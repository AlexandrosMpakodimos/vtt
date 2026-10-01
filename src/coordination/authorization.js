// Delivery is serialized with authoritative PostgreSQL revocations, not with
// Redis leases. No network I/O belongs inside the final synchronous callback.
function createAuthorization(knex) {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  async function access(socket, campaignId, lobby, deliver) {
    const userId = socket.data.userId;
    const sid = socket.data.authSessionId;
    if (!socket.connected || !uuid(campaignId) || !uuid(userId) || !sid) return false;
    return knex.transaction(async trx => {
      // Bound lock contention and avoid holding a connection indefinitely.
      await trx.raw("SET LOCAL lock_timeout = '1500ms'");
      await trx.raw("SET LOCAL statement_timeout = '2500ms'");
      const campaign = await trx('campaigns').where({ id: campaignId }).forShare().first();
      if (!campaign || campaign.deleted_at) return false;
      const session = await trx('session').where({ sid }).where('expire', '>', trx.fn.now()).forShare().first();
      if (!session || session.sess?.passport?.user !== userId) return false;
      const member = await trx('campaign_members').where({ campaign_id: campaignId, user_id: userId }).forShare().first();
      if (campaign.owner_id !== userId && (member?.status !== 'active' || (!lobby && !campaign.is_open))) return false;
      // Recheck expiry after lock waits, using the same DB connection clock.
      const { rows: [clock] } = await trx.raw('SELECT clock_timestamp() AS now');
      const expiry = new Date(session.expire).getTime();
      if (!Number.isFinite(expiry) || expiry <= new Date(clock.now).getTime() || !socket.connected) return false;
      // Must stay synchronous: the socket write is enqueued while row locks are
      // held. Bytes already queued before a revocation cannot be recalled.
      deliver(campaign);
      return true;
    });
  }
  // accessMany: the same checks as access(), for every recipient of one
  // message, in ONE transaction. [ADDED 2026-10-01 after the production
  // capacity test] Calling access() once per recipient cost one database
  // transaction (about 8 round trips, ~55 ms to Neon) per socket, run one after
  // another, so a move reached the tenth connection about half a second after
  // the first, and the presence notices sent on every join grew as N x N and
  // queued ahead of everything else (no move reached 20 connections within
  // 10 s). One transaction per message makes the cost constant in N.
  //
  // The guarantee is unchanged: the campaign row, every allowed recipient's
  // session row and membership row are share-locked while deliver() enqueues
  // the writes synchronously, so a committed revocation (session delete,
  // membership change, campaign lock) is still ordered against delivery by
  // the database.
  //
  // Sessions are locked with SKIP LOCKED, in sid order. A session row that is
  // locked right now (being touched by express-session, or deleted by a
  // revocation) is NOT decided here: that socket is returned in `fallback` and
  // the caller checks it with access(), which waits for the lock as before.
  // Waiting for several session rows inside one statement could deadlock
  // against a revocation that deletes several of one user's sessions; skipping
  // and falling back keeps the batch from ever waiting on a session row.
  //
  // Returns { allowed: Socket[], denied: Socket[], fallback: Socket[] }.
  async function accessMany(sockets, campaignId, lobby, deliver) {
    const allowed = [], denied = [], fallback = [];
    const eligible = [];
    for (const socket of sockets) {
      const userId = socket.data.userId;
      if (!socket.connected || !uuid(userId) || !socket.data.authSessionId) denied.push(socket);
      else eligible.push(socket);
    }
    if (!uuid(campaignId)) return { allowed, denied: sockets.slice(), fallback };
    if (!eligible.length) return { allowed, denied, fallback };
    return knex.transaction(async trx => {
      await trx.raw("SET LOCAL lock_timeout = '1500ms'");
      await trx.raw("SET LOCAL statement_timeout = '2500ms'");
      const campaign = await trx('campaigns').where({ id: campaignId }).forShare().first();
      if (!campaign || campaign.deleted_at) return { allowed, denied: denied.concat(eligible), fallback };
      const sids = [...new Set(eligible.map(socket => socket.data.authSessionId))].sort();
      const sessionRows = await trx('session').whereIn('sid', sids).orderBy('sid')
        .forShare().skipLocked().select('sid', 'sess', 'expire');
      const sessions = new Map(sessionRows.map(row => [row.sid, row]));
      const checkable = eligible.filter(socket => {
        if (sessions.has(socket.data.authSessionId)) return true;
        fallback.push(socket); return false;
      });
      const userIds = [...new Set(checkable.map(socket => socket.data.userId))].sort();
      const memberRows = userIds.length
        ? await trx('campaign_members').where({ campaign_id: campaignId }).whereIn('user_id', userIds)
          .orderBy('user_id').forShare().select('user_id', 'status')
        : [];
      const members = new Map(memberRows.map(row => [row.user_id, row]));
      // Recheck expiry after lock waits, using the same DB connection clock.
      const { rows: [clock] } = await trx.raw('SELECT clock_timestamp() AS now');
      const now = new Date(clock.now).getTime();
      for (const socket of checkable) {
        const userId = socket.data.userId;
        const session = sessions.get(socket.data.authSessionId);
        const member = members.get(userId);
        const expiry = new Date(session.expire).getTime();
        const ok = session.sess?.passport?.user === userId
          && (campaign.owner_id === userId || (member?.status === 'active' && (lobby || campaign.is_open)))
          && Number.isFinite(expiry) && expiry > now && socket.connected;
        (ok ? allowed : denied).push(socket);
      }
      // Must stay synchronous: the socket writes are enqueued while the row
      // locks are held. Bytes already queued before a revocation cannot be recalled.
      if (allowed.length) deliver(campaign, allowed);
      return { allowed, denied, fallback };
    });
  }
  return { access, accessMany };
}
module.exports = { createAuthorization };
