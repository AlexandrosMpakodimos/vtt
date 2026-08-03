// Scene access: the two functions that decide whether a caller may reach a
// given scene at all.
//
// WHY THIS MODULE EXISTS (M5, 2026-08-03). Two reasons, and the first one is
// forced rather than stylistic.
//
// 1. A require cycle. routes/combat.js needs to scope every combat through its
//    scene (a combat is only addressable through a scene, which is only
//    addressable through a campaign — the same two-step scoping that blocks
//    cross-campaign IDOR everywhere else in this project). routes/scenes.js
//    needs routes/combat.js, because placing or deleting a token has to update a
//    running fight. That is a genuine CommonJS cycle, which resolves to one
//    module receiving a half-populated exports object at load time.
//
//    This is exactly the situation that moved withAtomicCap out of
//    routes/scenes.js and into services/atomicCap.js during M4, and the fix is
//    the same: put the shared primitive in a leaf module with no route
//    knowledge. routes/scenes.js re-exports both functions, so socket.js and
//    every existing caller are untouched.
//
// 2. mayUseScene was DUPLICATED. It was defined in routes/scenes.js and NOT
//    exported, so socket.js re-derived the same rule inline in two places
//    (token:move and token:move-batch):
//
//        campaign.owner_id !== user.id && campaign.active_scene_id !== scene.id
//
//    Three copies of one authorisation rule, all correct today. The M3 V2 defect
//    was an authorisation boundary that held in one place and leaked in another,
//    and M5 was about to add a fourth caller. Collapsing them now, with the rule
//    in one place, is cheaper than auditing four copies later.

const knex = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Load a live scene that belongs to a given campaign. Scoping the lookup to the
// campaign is what stops a member of campaign A from reading or mutating a scene
// in campaign B by guessing its id (cross-campaign IDOR).
async function loadSceneInCampaign(sceneId, campaignId) {
  if (!validUuid(sceneId)) return null;
  return knex('scenes').where({ id: sceneId, campaign_id: campaignId }).first();
}

// A PLAYER is pinned to the campaign's active scene; the GM may open any scene
// (they need to prep and check maps without dragging the table along).
//
// Enforced on the SERVER, not by hiding buttons: a player who typed a scene id
// straight into the URL, or replayed an old request, would otherwise read a map
// the GM has not revealed yet — including its tokens, its fog and, since M5, its
// combats. Client-side hiding here would be the same security theatre that
// cosmetic token-dimming was rejected as in M2.
//
// Refusal is 404, never 403, and for the same reason non-members get 404: a 403
// would confirm that a scene with this id exists, letting a player enumerate the
// GM's unpublished maps by probing. To a player, a non-active scene is
// indistinguishable from one that does not exist.
//
// Takes the campaign and the owner flag rather than `req` so the socket layer
// can call it with the same arguments the HTTP layer does — that symmetry is the
// point of collapsing the copies.
function mayUseSceneFor({ isOwner, campaign, scene }) {
  if (isOwner) return true;
  return !!scene && !!campaign && campaign.active_scene_id === scene.id;
}

// Express-shaped convenience wrapper, so existing call sites read unchanged.
// req.isOwner and req.campaign are already on the request from requireMember.
function mayUseScene(req, scene) {
  return mayUseSceneFor({ isOwner: req.isOwner, campaign: req.campaign, scene });
}

module.exports = {
  loadSceneInCampaign,
  mayUseScene,
  mayUseSceneFor,
  validUuid,
};
