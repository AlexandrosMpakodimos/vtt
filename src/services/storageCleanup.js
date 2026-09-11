// The cleanup worker: drains storage_cleanup, deleting objects that must not
// exist and releasing their charged bytes exactly once when absence is finally
// established.
//
// WHY THIS EXISTS AND WHAT IT GUARANTEES
// storage.remove() can fail, and a failure that is swallowed is an object still
// costing bytes with nothing tracking it. Three routes now record such objects
// instead of dropping them: a rejected upload whose delete failed, an asset
// delete whose remove() returned false, and the stale-row sweep's abandoned
// pending objects. Each writes a storage_cleanup row. This worker is the other
// half — it retries those deletes until they succeed, and only then releases the
// bytes those objects were holding as cleanup debt.
//
// THE INVARIANTS IT KEEPS
//   1. A row's bytes are released to the ledger EXACTLY ONCE. Release and row
//      deletion happen in ONE serialisable transaction, so a retry cannot
//      release the same bytes twice and a crash cannot release them zero times.
//   2. No two workers process the same row. A row is claimed by stamping a
//      lease (leased_by + leased_until) under a serialisable transaction; a
//      second worker's claim of the same row conflicts and it moves on. An
//      expired lease is reclaimable, so a crashed worker strands nothing.
//   3. A delete is a FREE R2 operation, so no operation permit is charged — but
//      the maintenance byte/lease work stays bounded (a fixed batch per tick).
//   4. Coordinate with in-flight uploads: the worker only ever deletes keys that
//      were explicitly queued as garbage. It never lists-and-guesses, so it
//      cannot delete a key that a late upload is about to (re)create — that is
//      the reconciler's job, with its own dry-run gate.

const knex = require('../db');
const storage = require('./storage');
const budget = require('./storageBudget');

// How many rows one tick attempts. Bounded so a large backlog cannot turn a
// maintenance tick into an unbounded run of R2 calls.
const BATCH = 20;
// How long a claimed row is owned before another worker may reclaim it. Long
// enough to attempt a delete, short enough that a crash frees the row promptly.
const LEASE_MS = 60_000;
// Exponential-ish backoff between attempts, capped. A key that will not delete
// (permissions, a provider outage) should not be hammered every tick.
function nextDelayMinutes(attempts) {
  return Math.min(60, 2 ** Math.min(attempts, 6)); // 2,4,8,16,32,60,60…
}

const WORKER_ID = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;

// Claim up to BATCH due rows by stamping a lease, inside one serialisable
// transaction so two workers cannot claim the same row. Returns the claimed
// rows. "Due" = next_attempt_at in the past AND (no live lease).
async function claimBatch(trx) {
  const now = trx.fn.now();
  const due = await trx('storage_cleanup')
    .where('next_attempt_at', '<=', now)
    .andWhere(function leaseFree() {
      this.whereNull('leased_until').orWhere('leased_until', '<', now);
    })
    .orderBy('next_attempt_at', 'asc')
    .limit(BATCH)
    .forUpdate() // belt-and-braces alongside SERIALIZABLE
    .select('id');
  if (due.length === 0) return [];
  const ids = due.map((r) => r.id);
  await trx('storage_cleanup').whereIn('id', ids).update({
    leased_by: WORKER_ID,
    leased_until: trx.raw(`now() + interval '${Math.round(LEASE_MS / 1000)} seconds'`),
    updated_at: now,
  });
  return trx('storage_cleanup').whereIn('id', ids).select('*');
}

// Attempt to delete one claimed row's object. On success, release its bytes and
// remove the row in ONE transaction. On failure, record the error and push
// next_attempt_at out with backoff, releasing the lease.
async function processRow(row) {
  const removed = await storage.remove(row.storage_key);
  if (removed) {
    await budget.inSerializable(async (trx) => {
      // Release the debt (if any) and delete the row together: exactly once.
      await budget.releaseCleanupDebt(trx, row.bytes == null ? null : Number(row.bytes));
      await trx('storage_cleanup').where({ id: row.id }).del();
    });
    return { ok: true };
  }
  const attempts = Number(row.attempts) + 1;
  await knex('storage_cleanup').where({ id: row.id }).update({
    attempts,
    last_error: 'remove() returned false',
    next_attempt_at: knex.raw(`now() + interval '${nextDelayMinutes(attempts)} minutes'`),
    leased_by: null,
    leased_until: null,
    updated_at: knex.fn.now(),
  });
  return { ok: false };
}

// One tick: claim a batch, process each. Fail-soft — a thrown error is logged
// and the tick ends, like the other sweeps. Storage being unconfigured means
// there is nothing to delete against, so the worker no-ops rather than erroring.
async function tick() {
  if (!storage.isConfigured()) return { claimed: 0, deleted: 0 };
  let claimed = [];
  try {
    claimed = await budget.inSerializable((trx) => claimBatch(trx));
  } catch (err) {
    console.error('Cleanup claim failed:', err.message);
    return { claimed: 0, deleted: 0 };
  }
  let deleted = 0;
  for (const row of claimed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await processRow(row);
      if (r.ok) deleted += 1;
    } catch (err) {
      console.error(`Cleanup of ${row.storage_key} failed:`, err.message);
    }
  }
  if (deleted) console.log(`Cleanup worker deleted ${deleted} object(s)`);
  return { claimed: claimed.length, deleted };
}

// Operator/report helper: how much cleanup debt is outstanding and how many
// rows are stuck. Never used for a spend decision.
async function debtReport() {
  const rows = await knex('storage_cleanup').select('bytes', 'attempts', 'reason');
  const count = rows.length;
  const knownBytes = rows.reduce((s, r) => s + (r.bytes ? Number(r.bytes) : 0), 0);
  const unknownSize = rows.filter((r) => r.bytes == null).length;
  const stuck = rows.filter((r) => Number(r.attempts) >= 5).length;
  return { count, knownBytes, unknownSize, stuck };
}

module.exports = {
  tick, processRow, claimBatch, debtReport, nextDelayMinutes, BATCH, LEASE_MS, WORKER_ID,
};
