// The account-wide storage budget: the one place that decides whether an R2
// operation is allowed to happen, and the one place that records that it did.
//
// This is to the free allowance what atomicCap.js is to the per-scope image
// counts, and it is built the same way ON PURPOSE. The 2026-07-18 audit found
// every cap implemented as read-count-then-write across an await, and forty
// parallel creates made thirty campaigns against a cap of twenty. The standing
// fix since is: the check and the write happen inside ONE serialisable
// transaction with bounded retry on serialization_failure (40001); no
// in-process mutex, because a mutex does not survive the multiple processes the
// allowance is shared across. A byte/operation budget has exactly that race —
// N uploads each reading "under the ceiling" before any commits — so it gets
// exactly that discipline.
//
// WHAT IS COUNTED, AND WHY EACH ONE
//   committed_bytes    stored right now
//   reserved_bytes     promised to an in-flight upload, not yet stored
//   cleanup_debt_bytes objects we failed to delete and are still billed for
// The live liability is the SUM of the three, and it is the sum that is checked
// against the global ceiling. Checking committed alone would let a thousand
// simultaneous uploads each see room that the others are about to take, and
// ignoring cleanup debt would let a bucket full of undeletable objects read as
// empty.
//
//   class_a_used / class_b_used   operations this period. PUT, LIST and COPY
//   are Class A; GET and HEAD are Class B; DELETE is free. These are charged
//   BEFORE the operation and never refunded when an object is later deleted —
//   the operation happened and was billed; deleting the object does not un-bill
//   the read that created it. Conflating "bytes go away on delete" (true) with
//   "operations go away on delete" (false) is the mistake this refuses to make.
//
// EVERYTHING FAILS CLOSED. A budget that is not initialised (null period), a
// ledger that cannot be read, an operation class that is not recognised — each
// refuses the work rather than allowing it. The default answer to "may I spend
// against the account?" is no.

const knex = require('../db');

// Application defaults. These are OURS, deliberately well under Cloudflare's
// real free allowance so we stop before the provider does — never Cloudflare's
// numbers. Byte integers with explicit units; validated, not `Number(x)||d`,
// because a zero or NaN slipping through would silently disable a limit.
const DEFAULTS = {
  // 8 decimal GB against a 10 GB-month allowance: headroom for the averaging
  // (storage is billed on average daily peak, not the final byte) and for the
  // cleanup debt and reservations that also count.
  MAX_TOTAL_BYTES: 8_000_000_000,
  // 100k / 2M against 1M / 10M: an order of magnitude of headroom, because our
  // count is a conservative over-count (ambiguous failures are charged) and the
  // provider's is the bill.
  MAX_CLASS_A: 100_000,
  MAX_CLASS_B: 2_000_000,
  // A slice of each ceiling reserved for maintenance (reconciliation HEADs and
  // LISTs) so ordinary user traffic cannot consume the operations needed to
  // repair the accounting. Not a bypass — maintenance is metered too — a floor
  // it may not cross.
  MAINTENANCE_CLASS_A: 2_000,
  MAINTENANCE_CLASS_B: 40_000,
};

// Operation classification. Every R2 call goes through charge() with one of
// these; an unknown op fails closed rather than being charged as free.
const CLASS_A = new Set(['put', 'list', 'copy']);
const CLASS_B = new Set(['get', 'head']);
const FREE = new Set(['delete']);

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  // Explicitly NOT `Number(raw) || fallback`: that turns 0 and NaN into the
  // fallback, so a deployment setting a limit to 0 (meaning "allow nothing")
  // would silently get the default (meaning "allow a lot"). A limit is a
  // security control; an invalid one is a startup error, not a shrug.
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`storage budget limit ${name}=${raw} is not a non-negative integer`);
  }
  return n;
}

const LIMITS = {
  maxTotalBytes: readIntEnv('R2_MAX_TOTAL_BYTES', DEFAULTS.MAX_TOTAL_BYTES),
  maxClassA: readIntEnv('R2_MAX_CLASS_A', DEFAULTS.MAX_CLASS_A),
  maxClassB: readIntEnv('R2_MAX_CLASS_B', DEFAULTS.MAX_CLASS_B),
  maintClassA: readIntEnv('R2_MAINT_CLASS_A', DEFAULTS.MAINTENANCE_CLASS_A),
  maintClassB: readIntEnv('R2_MAINT_CLASS_B', DEFAULTS.MAINTENANCE_CLASS_B),
};

function classOf(op) {
  if (CLASS_A.has(op)) return 'a';
  if (CLASS_B.has(op)) return 'b';
  if (FREE.has(op)) return 'free';
  return null;
}

// The serialisable wrapper, identical in spirit to atomicCap's: one SERIALIZABLE
// transaction, bounded retry on 40001, no mutex. Every mutation of the ledger
// goes through it so two of them cannot interleave their read and write.
async function inSerializable(fn) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await knex.transaction(async (trx) => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        return fn(trx);
      });
    } catch (err) {
      if (err.budgetExceeded || err.budgetUninitialised) throw err;
      if (err.code === '40001' && attempt < 5) { attempt += 1; continue; }
      throw err;
    }
  }
}

async function readRow(trx) {
  const row = await trx('storage_budget').where({ id: true }).first();
  if (!row) {
    const e = new Error('storage budget is not initialised'); e.budgetUninitialised = true; throw e;
  }
  return row;
}

// Is the ledger usable at all? A null period means "not initialised" and every
// spend path must fail closed until it is set.
function isInitialised(row) {
  return !!(row.period_start && row.period_end);
}

// Reserve bytes for an upload about to begin. Charges reserved_bytes now; the
// upload later either commits (reserved -> committed) or releases (reserved ->
// gone). The ceiling check is against the WHOLE live liability.
async function reserveBytes(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('reserveBytes requires a positive integer');
  }
  return inSerializable(async (trx) => {
    const row = await readRow(trx);
    if (!isInitialised(row)) {
      const e = new Error('storage budget is not initialised'); e.budgetUninitialised = true; throw e;
    }
    const live = Number(row.committed_bytes) + Number(row.reserved_bytes)
      + Number(row.cleanup_debt_bytes);
    if (live + bytes > LIMITS.maxTotalBytes) {
      const e = new Error('storage byte budget reached');
      e.budgetExceeded = true; e.kind = 'bytes'; throw e;
    }
    await trx('storage_budget').where({ id: true })
      .update({ reserved_bytes: Number(row.reserved_bytes) + bytes, updated_at: trx.fn.now() });
    return { reserved: bytes };
  });
}

// An upload succeeded: move its reservation into committed. The reservation must
// have existed, so reserved_bytes cannot go negative (the DB check would fail
// the transaction if it tried, which is the correct loud failure).
async function commitReservedBytes(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('commitReservedBytes requires a positive integer');
  }
  return inSerializable(async (trx) => {
    const row = await readRow(trx);
    const reserved = Number(row.reserved_bytes);
    if (reserved < bytes) {
      // The reservation we are committing does not exist. Do NOT invent
      // committed bytes from nothing; this is a bug in the caller's bookkeeping
      // and must be visible.
      const e = new Error('commit exceeds reserved bytes'); e.ledgerInconsistent = true; throw e;
    }
    await trx('storage_budget').where({ id: true }).update({
      reserved_bytes: reserved - bytes,
      committed_bytes: Number(row.committed_bytes) + bytes,
      updated_at: trx.fn.now(),
    });
    return { committed: bytes };
  });
}

// An upload failed or was abandoned before commit: give the reservation back.
async function releaseReservedBytes(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('releaseReservedBytes requires a positive integer');
  }
  return inSerializable(async (trx) => {
    const row = await readRow(trx);
    const reserved = Number(row.reserved_bytes);
    // Clamp defensively: releasing more than is reserved is a bookkeeping bug,
    // but the ledger must never read negative, so release only what exists and
    // surface the discrepancy.
    const give = Math.min(reserved, bytes);
    await trx('storage_budget').where({ id: true })
      .update({ reserved_bytes: reserved - give, updated_at: trx.fn.now() });
    return { released: give, shortfall: bytes - give };
  });
}

// Committed bytes are leaving storage, but the object could not be deleted yet:
// move them from committed to cleanup_debt. They stay charged (the object still
// exists and still costs) until the durable cleanup queue confirms deletion.
async function moveToCleanupDebt(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('moveToCleanupDebt requires a positive integer');
  }
  return inSerializable(async (trx) => {
    const row = await readRow(trx);
    const committed = Number(row.committed_bytes);
    const give = Math.min(committed, bytes);
    await trx('storage_budget').where({ id: true }).update({
      committed_bytes: committed - give,
      cleanup_debt_bytes: Number(row.cleanup_debt_bytes) + give,
      updated_at: trx.fn.now(),
    });
    return { movedToDebt: give };
  });
}

// A queued object's deletion is finally confirmed: release its cleanup debt.
// Released EXACTLY ONCE — the caller (the cleanup worker) removes the queue row
// in the same transaction so a retry cannot release the same bytes twice.
async function releaseCleanupDebt(trx, bytes) {
  if (bytes == null) return { released: 0 };
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new Error('releaseCleanupDebt requires a non-negative integer or null');
  }
  const row = await readRow(trx);
  const debt = Number(row.cleanup_debt_bytes);
  const give = Math.min(debt, bytes);
  await trx('storage_budget').where({ id: true })
    .update({ cleanup_debt_bytes: debt - give, updated_at: trx.fn.now() });
  return { released: give };
}

// Charge one R2 operation of the given class BEFORE it happens. Fails closed on
// an unknown op and when the counter would cross its ceiling. `maintenance`
// callers may use the reserved maintenance slice; user traffic may not, so user
// traffic stops at (ceiling - maintenance) and cannot starve reconciliation.
async function charge(op, { maintenance = false } = {}) {
  const cls = classOf(op);
  if (cls === null) {
    // Unknown operations fail closed until classified. Charging them as free
    // would be the one way an unmetered call could exist.
    const e = new Error(`unclassified R2 operation: ${op}`); e.budgetExceeded = true; e.kind = 'unclassified'; throw e;
  }
  if (cls === 'free') return { charged: 0, class: 'free' };

  return inSerializable(async (trx) => {
    const row = await readRow(trx);
    if (!isInitialised(row)) {
      const e = new Error('storage budget is not initialised'); e.budgetUninitialised = true; throw e;
    }
    const col = cls === 'a' ? 'class_a_used' : 'class_b_used';
    const ceiling = cls === 'a' ? LIMITS.maxClassA : LIMITS.maxClassB;
    const maint = cls === 'a' ? LIMITS.maintClassA : LIMITS.maintClassB;
    // User traffic must leave the maintenance slice untouched; maintenance may
    // use the whole ceiling.
    const effectiveCeiling = maintenance ? ceiling : ceiling - maint;
    const used = Number(row[col]);
    if (used + 1 > effectiveCeiling) {
      const e = new Error(`Class ${cls.toUpperCase()} operation budget reached`);
      e.budgetExceeded = true; e.kind = `class_${cls}`; throw e;
    }
    await trx('storage_budget').where({ id: true })
      .update({ [col]: used + 1, updated_at: trx.fn.now() });
    return { charged: 1, class: cls };
  });
}

// A read-only snapshot for the operator view and for tests. Never used to make
// a spend decision — those read inside the transaction — only to report.
async function snapshot() {
  const row = await knex('storage_budget').where({ id: true }).first();
  if (!row) return null;
  const committed = Number(row.committed_bytes);
  const reserved = Number(row.reserved_bytes);
  const debt = Number(row.cleanup_debt_bytes);
  return {
    initialised: isInitialised(row),
    period_source: row.period_source,
    period_start: row.period_start,
    period_end: row.period_end,
    reconciled_at: row.reconciled_at,
    reconcile_complete: row.reconcile_complete,
    bytes: {
      committed, reserved, cleanup_debt: debt,
      live: committed + reserved + debt,
      limit: LIMITS.maxTotalBytes,
    },
    class_a: { used: Number(row.class_a_used), limit: LIMITS.maxClassA, maintenance: LIMITS.maintClassA },
    class_b: { used: Number(row.class_b_used), limit: LIMITS.maxClassB, maintenance: LIMITS.maintClassB },
  };
}

module.exports = {
  LIMITS,
  DEFAULTS,
  classOf,
  reserveBytes,
  commitReservedBytes,
  releaseReservedBytes,
  moveToCleanupDebt,
  releaseCleanupDebt,
  charge,
  snapshot,
  isInitialised,
  inSerializable,
  readRow,
};
