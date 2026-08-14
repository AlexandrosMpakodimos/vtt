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
// Resolve membership. `opts.requireOpen` decides whether a CLOSED campaign is
// reachable — see requireMember and requireMemberAnyState below.
async function resolveMember(req, res, next, { requireOpen }) {
  try {
    const campaign = await loadLiveCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    if (campaign.owner_id === req.user.id) {
      // The GM is never locked out of their own campaign. Closing it is how
      // they get the table to themselves to prepare, so a gate that shut them
      // out too would make the feature useless.
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

    // A closed campaign is not playable by anyone but its GM.
    //
    // 403 AND A REASON, not the 404 this project uses elsewhere. The usual rule
    // is that a refusal must not confirm existence — but this member already
    // knows the campaign exists: they joined it, it is on their dashboard, and
    // the dashboard says it is closed. There is nothing left to conceal, and a
    // 404 here would tell somebody who belongs at the table that their campaign
    // had vanished.
    if (requireOpen && campaign.is_open === false) {
      return res.status(403).json({ error: 'this campaign is closed — the GM has not opened the game' });
    }

    req.campaign = campaign;
    req.isOwner = false;
    req.membership = member;
    return next();
  } catch (err) {
    return next(err);
  }
}

// The DEFAULT, used by every game route: scenes, tokens, fog, actors, items,
// combat, chat, spells, assets. Closed means closed.
//
// Safe by DEFAULT rather than by application: a new game router inherits the
// gate by using the guard everyone else uses, and forgetting it is not possible
// because there is nothing to forget. The exceptions are the ones that have to
// be spelled out, and there are four of them.
async function requireMember(req, res, next) {
  return resolveMember(req, res, next, { requireOpen: true });
}

// Membership WITHOUT the open gate, for the handful of campaign-level routes
// that must keep working while the doors are shut.
//
// Reading the campaign, choosing your colour, archiving it from your dashboard
// and LEAVING are all things a member must be able to do regardless — being
// unable to leave a closed campaign would make closing it a way to trap people,
// which is a worse property than anything the gate protects.
async function requireMemberAnyState(req, res, next) {
  return resolveMember(req, res, next, { requireOpen: false });
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
  if (!member || member.status !== 'active') return false;
  // The open gate applies on BOTH transports.
  //
  // This function is the socket layer's whole membership check — joining a
  // room, moving a token, pinging. Gating only the HTTP routes would leave a
  // player who was already connected free to keep playing after the GM closed
  // the campaign, and would let a new socket join a closed one. That is the
  // shape of the M3 transport defect exactly: one rule, two transports, applied
  // to one of them.
  return campaign.is_open !== false;
}

module.exports = {
  requireMember, requireMemberAnyState, requireOwner, isActiveMember, validCampaignId,
};
