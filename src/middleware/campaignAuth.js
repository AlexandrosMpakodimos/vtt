// Campaign-level authorisation. The auth chapter established *who* a user is
// (authentication); this establishes *what they may do* inside a campaign.
//
// Two facts drive every decision here:
//   - The GM is DERIVED: campaigns.owner_id === user.id. There is no role column,
//     so there is no second source of truth to disagree with this one.
//   - Soft-deleted campaigns do not exist to anyone. Every lookup filters
//     deleted_at IS NULL, so a deleted campaign 404s even for its owner (the
//     restore route deliberately bypasses this middleware for that reason).
//
// Both middlewares attach req.campaign so the route handler need not re-query.

const knex = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres throws 22P02 on a malformed uuid; catching the shape first turns a
// 500 into a clean 404 and keeps garbage ids from reaching the database.
function validCampaignId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

async function loadLiveCampaign(id) {
  if (!validCampaignId(id)) return null;
  return knex('campaigns').where({ id }).whereNull('deleted_at').first();
}

// Is this user an 'active' member of this campaign?
//
// The owner is treated as a member unconditionally. Their campaign_members row
// is created at campaign creation, but ownership TRANSFER moves owner_id without
// touching membership rows -- so deriving access from owner_id, not from the
// join table, keeps the owner from ever locking themselves out.
//
// Deliberately returns 404, not 403, for a non-member: a 403 would confirm that
// a campaign with this id exists, letting someone enumerate private campaigns by
// probing ids. Members-only routes should not leak existence to non-members.
async function requireMember(req, res, next) {
  try {
    const campaign = await loadLiveCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    if (campaign.owner_id === req.user.id) {
      req.campaign = campaign;
      req.isOwner = true;
      return next();
    }

    const member = await knex('campaign_members')
      .where({ campaign_id: campaign.id, user_id: req.user.id })
      .first();

    if (!member || member.status !== 'active') {
      return res.status(404).json({ error: 'campaign not found' });
    }

    req.campaign = campaign;
    req.isOwner = false;
    req.membership = member;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Is this user the owner (i.e. the GM) of this campaign?
// Same 404-not-403 reasoning as above for a non-member. A member who is not the
// owner already knows the campaign exists, so they get an honest 403.
async function requireOwner(req, res, next) {
  try {
    const campaign = await loadLiveCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    if (campaign.owner_id !== req.user.id) {
      const member = await knex('campaign_members')
        .where({ campaign_id: campaign.id, user_id: req.user.id })
        .first();
      if (member && member.status === 'active') {
        return res.status(403).json({ error: 'only the campaign owner can do that' });
      }
      return res.status(404).json({ error: 'campaign not found' });
    }

    req.campaign = campaign;
    req.isOwner = true;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Shared by the socket layer, which has no req/res to work with.
async function isActiveMember(campaignId, userId) {
  const campaign = await loadLiveCampaign(campaignId);
  if (!campaign) return false;
  if (campaign.owner_id === userId) return true;
  const member = await knex('campaign_members')
    .where({ campaign_id: campaignId, user_id: userId })
    .first();
  return !!member && member.status === 'active';
}

module.exports = { requireMember, requireOwner, isActiveMember, validCampaignId };
