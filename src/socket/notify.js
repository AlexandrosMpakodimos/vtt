// Change notifications that carry ids only.
//
// Tell open pages that a campaign's membership or card changed, so nobody has to
// reload to see it: the game page re-reads its member list on member:updated
// (names, avatars, colours, who is at the table), and the dashboard re-reads its
// cards on campaign:updated. Both payloads carry ids only; each page re-fetches
// through its normal, permission-checked endpoint.
//
// Fire-and-forget after the write has committed: a failed notification must not
// turn a successful change into an error response.
function quietly(send) {
  Promise.resolve().then(send).catch(() => {});
}

// Tolerates a request without an app (handler unit tests build bare requests):
// no socket layer means nothing to notify.
function socketsFor(req) {
  return req && req.app && typeof req.app.get === 'function' ? req.app.get('campaignSockets') : null;
}

function campaignUpdated(req, campaignId) {
  const sockets = socketsFor(req);
  if (!sockets) return;
  quietly(() => sockets.broadcastLobby(campaignId, 'campaign:updated', { campaign_id: campaignId }));
}

function membershipChanged(req, campaignId, userId) {
  const sockets = socketsFor(req);
  if (!sockets) return;
  quietly(() => sockets.broadcastRoom(campaignId, 'member:updated', { campaign_id: campaignId, user_id: userId }));
  campaignUpdated(req, campaignId);
}

module.exports = { campaignUpdated, membershipChanged };
