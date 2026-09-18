const { publicCampaign } = require('../services/campaigns/presentation');
const { SOFT_DELETE_DAYS } = require('../services/campaigns/constants');

// These are the handlers mounted by campaigns.js, not a separate test adapter.
// Operations finish their writes/commits before any response or socket effect.
function createCampaignMutationHandlers({ operations, gateway }) {
  function sendFailure(res, result) {
    if (result.retryable) res.set('Retry-After', '1');
    return res.status(result.status).json({
      error: result.error,
      ...(result.retryable ? { code: result.code, retryable: true } : {}),
    });
  }

  async function create(req, res, next) {
    try {
      const result = await operations.create({ userId: req.user.id, body: req.body });
      if (result.status) return sendFailure(res, result);
      return gateway.sendJson(req, res, { campaign: publicCampaign(result.row, req.user.id) }, 201);
    } catch (err) { return next(err); }
  }

  async function join(req, res, next) {
    try {
      const result = await operations.join({ campaignId: req.params.id, userId: req.user.id, body: req.body });
      if (result.status) return sendFailure(res, result);
      return gateway.sendJson(req, res, { campaign: publicCampaign(result.row, req.user.id), status: 'active' });
    } catch (err) { return next(err); }
  }

  async function leave(req, res, next) {
    try {
      const result = await operations.leave({ campaignId: req.campaign.id, userId: req.user.id });
      if (result.status) return sendFailure(res, result);
      req.app.get('campaignSockets')?.evictUser(req.campaign.id, req.user.id, 'left');
      return res.json({ ok: true, status: 'left' });
    } catch (err) { return next(err); }
  }

  async function patch(req, res, next) {
    try {
      const result = await operations.patch({ campaignId: req.campaign.id, userId: req.user.id, body: req.body });
      if (result.status) return sendFailure(res, result);
      const { row, updates } = result;
      if (updates.is_open === false) {
        req.app.get('campaignSockets')?.evictGamePlayers(row.id, row.owner_id);
      }
      // Preserve game eviction before lobby notification, including the existing
      // unawaited broadcast call; changing delivery semantics is separate work.
      if (updates.is_open !== undefined) {
        req.app.get('campaignSockets')?.broadcastLobby(
          req.campaign.id, 'campaign:state',
          { campaign_id: req.campaign.id, is_open: updates.is_open },
        );
      }
      return gateway.sendJson(req, res, { campaign: publicCampaign(row, req.user.id) });
    } catch (err) { return next(err); }
  }

  async function remove(req, res, next) {
    try {
      const result = await operations.remove({ campaignId: req.campaign.id, userId: req.user.id });
      if (result.status) return sendFailure(res, result);
      req.app.get('campaignSockets')?.evictCampaign(req.campaign.id);
      return res.json({ ok: true, message: `campaign deleted — recoverable for ${SOFT_DELETE_DAYS} days` });
    } catch (err) { return next(err); }
  }

  async function restore(req, res, next) {
    try {
      const result = await operations.restore({ campaignId: req.params.id, userId: req.user.id });
      if (result.error) return sendFailure(res, result);
      return gateway.sendJson(req, res, { campaign: publicCampaign(result.row, req.user.id) });
    } catch (err) { return next(err); }
  }

  async function transfer(req, res, next) {
    try {
      const result = await operations.transfer({ campaignId: req.campaign.id, userId: req.user.id, body: req.body });
      if (result.row && result.row.is_open === false) {
        req.app.get('campaignSockets')?.evictGamePlayers(result.row.id, result.row.owner_id);
      }
      if (result.error) return sendFailure(res, result);
      return gateway.sendJson(req, res, { campaign: publicCampaign(result.row, req.user.id) });
    } catch (err) { return next(err); }
  }

  function moderationRoute(nextStatus) {
    return async (req, res, next) => {
      try {
        const targetId = req.params.userId;
        const result = await operations.moderate({ campaignId: req.campaign.id, userId: req.user.id, targetId, nextStatus });
        if (result.status) return sendFailure(res, result);
        req.app.get('campaignSockets')?.evictUser(req.campaign.id, targetId);
        return res.json({ ok: true, user_id: targetId, status: nextStatus });
      } catch (err) { return next(err); }
    };
  }

  async function unban(req, res, next) {
    try {
      const targetId = req.params.userId;
      const result = await operations.unban({ campaignId: req.campaign.id, userId: req.user.id, targetId });
      if (result.status) return sendFailure(res, result);
      return res.json({ ok: true, user_id: targetId, status: 'left' });
    } catch (err) { return next(err); }
  }

  return { create, join, leave, patch, remove, restore, transfer, moderationRoute, unban };
}

module.exports = { createCampaignMutationHandlers };
