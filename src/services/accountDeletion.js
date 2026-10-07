// Account deletion (Fix 4, decided 2026-10-05, built 2026-10-07).
//
// WHAT IS REMOVED AND WHAT IS KEPT
// The users row is deleted and the foreign keys do the rest:
//   - CASCADE: campaign_members, email_verification_tokens,
//     password_reset_tokens, and campaigns.owner_id (see the refusal below).
//   - SET NULL: messages.user_id (the line keeps its speaker_name snapshot),
//     actors.user_id (the character stays in the campaign, unassigned),
//     tokens.created_by, assets.user_id (images in other people's campaigns
//     stay where they are).
// Sessions are not tied to users by a foreign key (connect-pg-simple stores
// the id inside the session JSON), so they are deleted explicitly.
//
// THE REFUSAL
// A user who owns a campaign that is not deleted (deleted_at IS NULL) is
// refused with the list of those campaigns, and nothing changes: they must
// transfer or delete each one first with the existing buttons. This mirrors
// "the owner cannot leave". Without it, campaigns.owner_id CASCADE would
// silently delete a running game out from under its players.
//
// IMAGES THAT WOULD OTHERWISE BE ORPHANED IN THE BUCKET
// The user's soft-deleted campaigns (still inside, or past, their 30-day
// window) and their own avatars (assets.campaign_id IS NULL) would lose their
// asset rows to the cascade while the objects stayed in R2. They go through the
// same steps as the hourly purge (src/services/campaignPurge.js): rows deleted
// explicitly, objects queued in storage_cleanup, verified bytes moved to
// cleanup debt, reservations released. All of this happens BEFORE the users
// row is deleted, because campaigns.owner_id is CASCADE.
//
// ONE SERIALIZABLE TRANSACTION, with the shared jittered 40001 retry
// (budget.inSerializable -> retryAfterSerializationFailure). A conflict or a
// crash anywhere rolls the whole attempt back. A retry starts from the top, so
// a campaign transferred to this user by a transaction that committed during
// the first attempt is seen by the second, which then refuses.

const budget = require('./storageBudget');
const { purgeCampaignsIn, queueDeletedAssetsIn, QUEUE_COLUMNS } = require('./campaignPurge');
const { PENDING_TTL_MINUTES } = require('../routes/assets');

// The deleting user's avatar objects are queued with an existing reason: the
// storage_cleanup.reason CHECK (Fix 1) allows delete_failed, orphan_pending,
// campaign_purged and rejected, and a dedicated reason would need a migration.
// delete_failed is what the single-image DELETE writes for the same state:
// the asset row is gone and the object still has to be deleted.
const AVATAR_CLEANUP_REASON = 'delete_failed';

// userId: the signed-in user. expectedHash: the password_hash the request
// verified the password against (outside the transaction, as Argon2id is slow).
// destroySessions(trx, userId) deletes every session of the user and returns
// the deleted rows' sids.
//
// Returns one of:
//   { outcome: 'changed' }             the password changed meanwhile (or the
//                                      user is gone): nothing done
//   { outcome: 'owns_campaigns', campaigns: [{ id, name }] }
//   { outcome: 'upload_in_progress' }  an avatar upload is still running
//   { outcome: 'deleted', sessionIds, memberOf, purged, avatarsQueued }
async function deleteAccount({ userId, expectedHash, destroySessions }) {
  return budget.inSerializable(async (trx) => {
    const user = await trx('users').where({ id: userId }).forUpdate()
      .first('id', 'password_hash');
    if (!user || user.password_hash !== expectedHash) return { outcome: 'changed' };

    const owned = await trx('campaigns')
      .where({ owner_id: userId }).whereNull('deleted_at')
      .orderBy('name').orderBy('id')
      .select('id', 'name');
    if (owned.length) return { outcome: 'owns_campaigns', campaigns: owned };

    // An avatar upload still inside its request: deleting its row now would
    // let the request commit its reservation into the ledger and leave an
    // object with no row. Rows older than the stale-sweep window belong to
    // an upload that died, and are queued below like any other.
    const uploading = await trx('assets')
      .where({ user_id: userId, status: 'pending' }).whereNull('campaign_id')
      .whereRaw(`created_at >= now() - interval '${PENDING_TTL_MINUTES} minutes'`)
      .first('id');
    if (uploading) return { outcome: 'upload_in_progress' };

    // Rosters to refresh after commit: every live campaign this user has a
    // membership row in (any status, since the GM's manage view lists them all).
    const memberOf = await trx('campaign_members as m')
      .join('campaigns as c', 'c.id', 'm.campaign_id')
      .where('m.user_id', userId).whereNull('c.deleted_at')
      .orderBy('m.campaign_id')
      .pluck('m.campaign_id');

    const softDeleted = await trx('campaigns')
      .where({ owner_id: userId }).whereNotNull('deleted_at')
      .orderBy('id')
      .pluck('id');
    const purged = await purgeCampaignsIn(trx, softDeleted);

    const avatars = await trx('assets')
      .where({ user_id: userId }).whereNull('campaign_id')
      .del()
      .returning(QUEUE_COLUMNS);
    const avatarsQueued = await queueDeletedAssetsIn(trx, avatars, AVATAR_CLEANUP_REASON);

    const sessions = await destroySessions(trx, userId);
    await trx('users').where({ id: userId }).del();

    return {
      outcome: 'deleted',
      sessionIds: sessions.map((s) => s.sid),
      memberOf,
      purged,
      avatarsQueued,
    };
  });
}

module.exports = { deleteAccount, AVATAR_CLEANUP_REASON };
