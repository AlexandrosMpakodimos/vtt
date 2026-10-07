// Permanently removes campaigns whose 30-day soft-delete window has elapsed,
// and hands their stored images to the durable cleanup queue first.
//
// WHY THIS EXISTS
// The hourly sweep used to be a bare `DELETE FROM campaigns`. The FK cascade
// took the campaign's asset ROWS with it, but nothing deleted the OBJECTS in R2:
// they stayed in the bucket for ever, still billed against the account's free
// tier, and invisible to the app's storage ledger once their rows were gone.
// Deleting a single image never had this gap (src/routes/assets.js DELETE moves
// a failed delete to the queue); this brings the purge in line with it.
// Found in the production review, 2026-10-01.
//
// WHAT ONE RUN DOES, IN ONE SERIALIZABLE TRANSACTION
//   1. find the expired campaigns (deleted_at older than SOFT_DELETE_DAYS)
//   2. delete their asset rows explicitly (RETURNING them), BEFORE the cascade
//   3. for each row with a stored object, insert a storage_cleanup row
//      (reason 'campaign_purged'); the cleanup worker deletes the object and
//      only then releases its bytes, exactly as for any queued delete
//   4. keep the ledger honest while the object still exists:
//        - verified committed bytes move committed -> cleanup debt, and the
//          queue row records exactly the amount moved, so the worker later
//          releases exactly that amount, once
//        - an unconfirmed upload's reservation is released (it never became
//          committed bytes); its queue row carries bytes = null
//      If the ledger is not initialised, nothing is moved and every queue row
//      carries bytes = null, so a later release cannot take bytes it never put
//      there. The object is still queued, so it is still deleted.
//   5. delete the campaigns (the cascade removes members, scenes, tokens, ...)
// A crash or serialization conflict anywhere rolls the whole run back: the
// campaigns, their asset rows and the ledger stay as they were and the next
// hourly run tries again. Nothing is half-done, so no object can lose its row
// without gaining a queue entry.
//
// Deleting the object here directly would be the wrong order: an R2 call inside
// a database transaction is slow and cannot be rolled back. The queue is the
// mechanism that already guarantees "deleted, then released, exactly once".
//
// Personal images (avatars: campaign_id IS NULL) are never touched by the
// hourly purge. Steps 2-5 can also be run for explicit campaign ids
// (purgeCampaignsIn); account deletion uses that, and queueDeletedAssetsIn for
// the deleting user's avatars (Fix 4, 2026-10-07).

const knex = require('../db');
const budget = require('./storageBudget');
const { SOFT_DELETE_DAYS } = require('./campaigns/constants');

// The columns a deleted asset row must hand back so its object can be queued.
const QUEUE_COLUMNS = ['id', 'storage_key', 'bytes', 'bytes_verified', 'reserved_bytes'];

// Steps 3-4 for asset rows the caller has just deleted (RETURNING
// QUEUE_COLUMNS), inside the caller's SERIALIZABLE transaction. Shared with
// account deletion (src/services/accountDeletion.js), which hands the same
// rows over for a user's avatars. Returns how many objects were queued.
async function queueDeletedAssetsIn(trx, assets, reason) {
  if (assets.length === 0) return 0;
  const ledger = await trx('storage_budget').where({ id: true }).first();
  const ledgerActive = !!ledger && budget.isInitialised(ledger);

  let queued = 0;
  for (const asset of assets) {
    // A pending upload's reservation (bigint: node-pg returns a string).
    const reserved = Number(asset.reserved_bytes);
    if (ledgerActive && reserved > 0) {
      // eslint-disable-next-line no-await-in-loop
      await budget.releaseReservedBytesIn(trx, reserved);
    }
    if (!asset.storage_key) continue;   // an external link: nothing stored

    // The same rule as the single-image DELETE: only verified sizes are
    // committed bytes. Anything else is queued with an unknown size.
    let queuedBytes = null;
    const committed = (asset.bytes_verified && Number.isInteger(asset.bytes) && asset.bytes > 0)
      ? asset.bytes : null;
    if (ledgerActive && committed) {
      // eslint-disable-next-line no-await-in-loop
      const { movedToDebt } = await budget.moveToCleanupDebtIn(trx, committed);
      queuedBytes = movedToDebt > 0 ? movedToDebt : null;
    }
    // eslint-disable-next-line no-await-in-loop
    await trx('storage_cleanup').insert({
      storage_key: asset.storage_key,
      bytes: queuedBytes,
      reason,
    });
    queued += 1;
  }
  return queued;
}

// Steps 2-5 for explicit campaign ids, inside the caller's SERIALIZABLE
// transaction. The hourly purge passes the expired campaigns; account deletion
// passes the deleting user's soft-deleted campaigns (whatever their age).
async function purgeCampaignsIn(trx, ids) {
  if (ids.length === 0) return { campaigns: 0, assets: 0, queued: 0 };
  const assets = await trx('assets')
    .whereIn('campaign_id', ids)
    .del()
    .returning(QUEUE_COLUMNS);
  const queued = await queueDeletedAssetsIn(trx, assets, 'campaign_purged');
  const campaigns = await trx('campaigns').whereIn('id', ids).del();
  return { campaigns, assets: assets.length, queued };
}

async function purgeExpiredCampaigns() {
  return budget.inSerializable(async (trx) => {
    const expired = await trx('campaigns')
      .whereNotNull('deleted_at')
      .whereRaw(`deleted_at < now() - interval '${SOFT_DELETE_DAYS} days'`)
      .select('id');
    return purgeCampaignsIn(trx, expired.map((c) => c.id));
  });
}

module.exports = { purgeExpiredCampaigns, purgeCampaignsIn, queueDeletedAssetsIn, QUEUE_COLUMNS };
