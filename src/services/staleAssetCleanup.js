// Reclaims upload authorisations that were issued and never used.
//
// A presigned URL creates a `pending` asset row before the bytes exist, because
// the quota has to be claimed before the authorisation is handed out. A client
// that asks for a URL and never uploads therefore holds quota indefinitely, and
// asking repeatedly would exhaust it without storing a single image.
//
// Extracted from src/server.js (unchanged cadence, unchanged caller) purely so
// it can be exercised directly against a real database in tests, the same way
// src/services/storageCleanup.js already is. No timer, startup or shutdown
// behaviour lives here; server.js still owns the setInterval and the
// immediate-on-boot call, exactly as before.
//
// A stale pending row may have an OBJECT behind it: the client got a presigned
// URL and PUT the bytes but never confirmed, or confirmed and was rejected.
// Deleting the ROW without deleting the OBJECT turns a tracked upload into
// invisible storage — the exact leak the durable cleanup queue exists to close.
// So each stale row that has a storage_key is enqueued for deletion, and its
// byte reservation (if the budget is active) is released, in the SAME
// transaction that removes the row itself. Rows with no storage_key (external
// links never reach 'pending', but be defensive) just go. A 'rejected' row is
// swept here too: confirm() only marks a rejection, it never deletes the row,
// and it has already released its own reservation (assets.reserved_bytes is
// null by then), so this loop's release guard below naturally does nothing
// further for it — only the row and, if confirm's own delete attempt failed, a
// cleanup-queue entry remain to do.
//
// The claim IS the DELETE: matching rows are removed by this statement, and its
// RETURNING set is exactly, and only, the rows this call claimed. Postgres's
// row-level locking on DELETE gives two concurrent callers (two overlapping
// instances, or this sweep racing a confirm() finishing the same row) mutual
// exclusion for free — whichever commits first actually removes a given row;
// the other's claim for that same row returns nothing, so its loop body below
// simply never runs for it. Wrapping the claim, the cleanup-queue insert and
// the reservation release in ONE SERIALIZABLE transaction (the same discipline
// storageBudget.js uses throughout) means a crash or conflict anywhere in here
// rolls back the whole attempt: nothing is left half-done, and the untouched
// row is safely retried next sweep.

const knex = require('../db');
const budget = require('./storageBudget');
const { PENDING_TTL_MINUTES } = require('../routes/assets');

async function cleanupStaleAssets() {
  try {
    const claimed = await budget.inSerializable(async (trx) => {
      const rows = await trx('assets')
        .whereIn('status', ['pending', 'rejected'])
        .whereRaw(`created_at < now() - interval '${PENDING_TTL_MINUTES} minutes'`)
        .del()
        .returning(['id', 'storage_key', 'reserved_bytes']);

      for (const row of rows) {
        if (row.storage_key) {
          // eslint-disable-next-line no-await-in-loop
          await trx('storage_cleanup').insert({
            storage_key: row.storage_key,
            bytes: null, // an unconfirmed object's size was never established
            reason: 'orphan_pending',
          });
        }
        // reserved_bytes is a bigint column: node-pg returns it as a numeric
        // string, never a JS number, so Number(...) is required here — a typeof
        // check against 'number' would never fire for a value read back from
        // Postgres (a pre-existing defect in the code this replaced, confirmed
        // present before this patch; see the scope notes).
        const reservedBytes = Number(row.reserved_bytes);
        if (reservedBytes > 0) {
          // eslint-disable-next-line no-await-in-loop
          await budget.releaseReservedBytesIn(trx, reservedBytes);
        }
      }
      return rows;
    });

    if (claimed.length) {
      console.log(`Cleared ${claimed.length} stale asset row(s); queued objects for deletion`);
    }
    return claimed;
  } catch (err) {
    console.error('Asset cleanup failed:', err.message);
    return [];
  }
}

module.exports = { cleanupStaleAssets, PENDING_TTL_MINUTES };
