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
  return { access };
}
module.exports = { createAuthorization };
