// Scenes + tokens (M2 canvas), mounted under /api/campaigns/:id/scenes so that
// requireMember / requireOwner and req.campaign apply exactly as they do to the
// campaign routes. HTTP handles the heavy, structural writes (create a scene,
// place/delete a token, full scene load); the light, high-frequency delta —
// a token move on drop — is a socket event (see socket.js). "Load heavy,
// update light."
//
// The server is the single authority. Placement and movement rules this pass:
//   - The GM (campaign owner) places unlimited tokens and moves ANY token.
//   - A player may place ONE token per scene, and may move ONLY tokens they
//     placed (tokens.created_by === their id).
// These defaults will later be overridable by a per-campaign movement setting;
// tokenMovePolicy() below is the single seam where that will hook in. It is NOT
// built now (that would be scope creep) — the seam just keeps the future change
// to one function.

const express = require('express');
const knex = require('../db');
const { requireMember, requireOwner, validCampaignId } = require('../middleware/campaignAuth');
const {
  validateSceneName, validateTokenName, validateImageUrl,
  validateGridCoord, validateTokenSize, validateSceneDimension,
  validateTokenIdList, validateBool,
  validateFogType, validateFogPoints,
} = require('../services/validators');
const { contentWriteLimiter } = require('../middleware/rateLimit');
// Moved to services/ in M4: actors, items and inventory attunement now share
// this primitive, and leaving it here would create a require cycle between the
// scene and actor routers. Behaviour is unchanged for every call site below.
const { withAtomicCap } = require('../services/atomicCap');
// M5. Scene access moved to a leaf module to break the routes/scenes <->
// routes/combat require cycle; see that module's header.
const { loadSceneInCampaign, mayUseScene } = require('../services/sceneAccess');
// M5. Auto-add / auto-remove hooks. A token placed on a scene with a running
// fight joins the roster; a token deleted leaves it (via the FK cascade, which
// cannot notify anyone, hence the explicit broadcast).
const {
  autoAddCombatant, afterTokensDeleted, syncPropFlag,
} = require('./combat');
// M4: a token may now be LINKED to an actor. The actor router owns the
// projection (what a player may see of a character), and this router imports it
// rather than reimplementing it — one definition, so the scene load and the
// actor endpoints cannot disagree about what an NPC discloses.
const { shapeActorFor, loadActorInCampaign } = require('./actors');

// mergeParams: this router is mounted at .../:id/scenes, and :id (the campaign)
// lives on the parent router's params.
const router = express.Router({ mergeParams: true });

// Rate-limit state-changing requests only. Reads are cheap and an open canvas
// polls them; writes are what a script would abuse. Total state is separately
// bounded by the caps below — this bounds the rate, they bound the amount.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// D&D 5e creature-size categories → token footprint in GRID UNITS (1 = one
// 5-ft square). Tiny is a quarter-square (0.5×0.5); Small and Medium both fill
// one square; each step up doubles the side. Gargantuan's 4×4 is the 5e minimum
// (the DMG treats 20ft+ as Gargantuan, so bigger is legal — a GM can still set a
// custom size directly). These are presets, not enforcement: the token width/
// height columns accept any validated size.
const SIZE_PRESETS = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
};

// A player may place at most this many tokens per scene this pass. The GM is
// exempt. This is a "no more than N of X" rule, so per the standing constraint
// from the M2 audit it is enforced ATOMICALLY (serialisable transaction), never
// read-then-write.
const MAX_PLAYER_TOKENS_PER_SCENE = 1;

// Abuse-prevention caps (added after the canvas security audit, which created
// 6000 tokens in under a second and 30 scenes unchecked). These are NOT gameplay
// limits — they are bounds on what a single authenticated GM can do to the
// database and to every client's scene-load. Like the campaign caps, they are
// app-logic abuse prevention, and per the standing constraint every one of them
// is enforced atomically (count + write inside one SERIALIZABLE transaction),
// never as a separate read-then-write.
const MAX_TOKENS_PER_SCENE = 500;    // a crowded battle map is dozens, not thousands
const MAX_SCENES_PER_CAMPAIGN = 100; // a long campaign is tens of maps

// Fog regions per scene (M3). Same class of rule as the two above, so it is
// enforced through the same atomic helper. This bounds HOW MANY regions exist;
// MAX_FOG_POINTS in validators.js separately bounds how big ONE region can be,
// which is the bound that actually matters — 200 regions of 50,000 vertices each
// is a small number of requests that poisons every future scene load, and no row
// cap would catch it. Both numbers are chosen as sane abuse bounds, not measured.
const MAX_FOG_REGIONS_PER_SCENE = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Response shapes: explicit allow-lists, mirroring SAFE_COLUMNS discipline.
function publicScene(s) {
  if (!s) return null;
  return {
    id: s.id,
    campaign_id: s.campaign_id,
    folder_id: s.folder_id,
    name: s.name,
    img_url: s.img_url,
    width: s.width,
    height: s.height,
    grid: s.grid,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function publicToken(t) {
  if (!t) return null;
  return {
    id: t.id,
    scene_id: t.scene_id,
    actor_id: t.actor_id,
    created_by: t.created_by,
    name: t.name,
    img_url: t.img_url,
    // Postgres DECIMAL comes back as a string over the wire; coerce so clients
    // get numbers to render with, not "3.00".
    x: Number(t.x),
    y: Number(t.y),
    width: Number(t.width),
    height: Number(t.height),
    rotation: Number(t.rotation),
    hidden: t.hidden,
    locked: t.locked,
    // M5. The GM's "this is scenery, never a combatant" flag. Safe to send to
    // players: it is the GM's classification of a token they can already see,
    // and hidden tokens never reach them at all. Same class as `locked`.
    is_prop: t.is_prop,
    bar1_value: t.bar1_value,
    bar1_max: t.bar1_max,
    conditions: t.conditions,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// loadSceneInCampaign and mayUseScene now live in services/sceneAccess.js and are
// imported at the top of this file. M5 moved them for two reasons, both recorded
// in that module's header: routes/combat.js needs them and this file needs
// routes/combat.js (a genuine require cycle, the same one that moved
// withAtomicCap out of here during M4), and mayUseScene was never exported, so
// socket.js had re-derived it inline in two places. Three copies of one
// authorisation rule, collapsed to one before M5 added a fourth caller.
// Both are re-exported at the bottom of this file, so every existing call site
// is unchanged.

function publicFog(f) {
  if (!f) return null;
  return {
    id: f.id,
    scene_id: f.scene_id,
    type: f.type,
    // jsonb comes back parsed from pg; coordinates were validated as numbers on
    // the way in, so no coercion is needed on the way out (unlike token DECIMALs,
    // which arrive as strings).
    points: f.points,
    revealed: f.revealed,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

// Fog equivalent of the scene loader: a region is only addressable through the
// scene it belongs to, which is itself only addressable through the campaign.
// That two-step scoping is what blocks cross-scene and cross-campaign IDOR on
// every fog endpoint, exactly as it does for tokens.
async function loadFogInScene(fogId, sceneId) {
  if (!validUuid(fogId)) return null;
  return knex('fog_of_war').where({ id: fogId, scene_id: sceneId }).first();
}

// The single seam for the future per-campaign movement setting. Today it encodes
// the fixed default; later it will read req.campaign.settings. Returns true if
// `user` may move `token` in `campaign`.
//
//   - owner (GM): may move anything.
//   - player: may move only a token they placed.
function tokenMovePolicy({ campaign, token, userId }) {
  if (campaign.owner_id === userId) return true;
  return token.created_by === userId;
}

// M4 — resolve a body-supplied actor_id into an actor this user may put on the
// board, or an error. Used by placement, PATCH and paste, so the rule exists in
// one place across all three write paths.
//
// Until M4 every one of those paths forced actor_id to NULL, and three suites
// assert exactly that. Relaxing it is a deliberate, narrow weakening of an
// existing hardening — pasting five goblin tokens that all point at one Goblin
// actor is the entire point of linking — so the replacement guarantee has to be
// stated precisely:
//
//   BEFORE: actor_id is always NULL.
//   AFTER : actor_id is NULL unless the body named an actor that (a) exists,
//           (b) belongs to THIS campaign, and (c) the caller may put on the
//           board. A forged id from another campaign is still refused.
//
// (c) differs by role, and the reason is the same one behind the per-player
// token cap: the GM runs the board and may place any character or monster; a
// player may only place a character they control. Without that a player could
// place the GM's dragon, or link their token to an NPC and — since a linked
// token derives its bar from the actor — read hit points the projection is
// specifically designed to withhold.
//
// A player aiming at an actor they do not control gets 404, not 403. The M4
// audit note predicted this coupling exactly: the 403 was tolerable only while
// GET /actors listed every NPC to players, because then the refusal confirmed
// nothing they could not already read. V1 removed that listing, so a 403 here
// would have become the enumeration oracle the list no longer offers — probe the
// placement endpoint with candidate ids and the GM's prep answers back.
async function resolveTokenActor({ req, rawActorId }) {
  if (rawActorId === undefined || rawActorId === null || rawActorId === '') {
    return { actor: null };
  }
  if (!validUuid(rawActorId)) return { error: 'actor_id must be a valid id' };

  const actor = await loadActorInCampaign(rawActorId, req.campaign.id);
  // 404-shaped refusal rather than "wrong campaign": a member of campaign A
  // must not be able to confirm that an actor id exists in campaign B.
  if (!actor) return { error: 'actor not found' };

  const isOwner = req.campaign.owner_id === req.user.id;
  if (!isOwner && actor.user_id !== req.user.id) {
    return { error: 'actor not found' };
  }
  return { actor };
}

// ---- scenes ----

// POST /api/campaigns/:id/scenes — GM creates a scene.
router.post('/', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};

    const n = validateSceneName(body.name);
    if (n.error) return res.status(400).json({ error: n.error });

    const img = validateImageUrl(body.img_url, 'img_url');
    if (img.error) return res.status(400).json({ error: img.error });

    const w = validateSceneDimension(body.width, 'width', 1400);
    if (w.error) return res.status(400).json({ error: w.error });

    const h = validateSceneDimension(body.height, 'height', 1050);
    if (h.error) return res.status(400).json({ error: h.error });

    // Hand-listed columns only — never the raw body (mass-assignment immunity).
    // Scene count is capped atomically (abuse prevention, not a gameplay limit).
    let rows;
    try {
      rows = await withAtomicCap({
        table: 'scenes',
        where: { campaign_id: req.campaign.id },
        max: MAX_SCENES_PER_CAMPAIGN,
        capMessage: `a campaign may hold at most ${MAX_SCENES_PER_CAMPAIGN} scenes`,
        insert: {
          campaign_id: req.campaign.id,
          name: n.value,
          img_url: img.value,
          width: w.value,
          height: h.value,
        },
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }
    const row = rows[0];

    return res.status(201).json({ scene: publicScene(row) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/scenes — any active member lists the campaign's scenes.
router.get('/', requireMember, async (req, res, next) => {
  try {
    // The GM gets the whole list — it is their scene manager. A player gets at
    // most the active scene, so the other maps are not even enumerable, let
    // alone openable. An unset active scene means a player sees nothing yet.
    if (!req.isOwner) {
      if (!req.campaign.active_scene_id) return res.json({ scenes: [] });
      const active = await knex('scenes')
        .where({ id: req.campaign.active_scene_id, campaign_id: req.campaign.id })
        .first();
      return res.json({ scenes: active ? [publicScene(active)] : [] });
    }
    const rows = await knex('scenes')
      .where({ campaign_id: req.campaign.id })
      .orderBy('created_at', 'asc');
    return res.json({ scenes: rows.map(publicScene) });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/campaigns/:id/scenes/active — the GM sets (or clears) the campaign's
// active scene: the shared notion of "which scene everyone is looking at".
//
// Registered BEFORE the /:sceneId routes. There is no PUT on /:sceneId, so
// nothing is actually shadowed today, but keeping it above the parameterised
// routes means adding one later can't silently swallow this path.
//
// Body: { scene_id: <uuid> } to activate, or { scene_id: null } to clear.
// The scene is looked up THROUGH the campaign, so a GM cannot point their
// campaign at a scene belonging to someone else's (cross-campaign IDOR, and
// also an integrity problem: every member would then load a foreign scene).
router.put('/active', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'scene_id')) {
      return res.status(400).json({ error: 'scene_id is required (use null to clear)' });
    }

    let nextId = null;
    if (body.scene_id !== null) {
      const scene = await loadSceneInCampaign(body.scene_id, req.campaign.id);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      nextId = scene.id;
    }

    await knex('campaigns')
      .where({ id: req.campaign.id })
      .update({ active_scene_id: nextId, updated_at: knex.fn.now() });

    // Everyone in the room follows the GM. The FK is ON DELETE SET NULL, so a
    // deleted active scene simply clears the pointer rather than cascading.
    req.app.get('campaignSockets')?.broadcastRoom(req.campaign.id, 'scene:activated', {
      campaign_id: req.campaign.id,
      scene_id: nextId,
    });

    return res.json({ ok: true, active_scene_id: nextId });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/scenes/:sceneId — a full scene load: the scene plus all
// its tokens and all its fog. This is the "load heavy" half; live changes after
// this arrive as socket deltas.
router.get('/:sceneId', requireMember, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });
    // A player may only load the active scene (see mayUseScene).
    if (!mayUseScene(req, scene)) return res.status(404).json({ error: 'scene not found' });

    // True hiding: a hidden token is filtered out of what a PLAYER receives, not
    // merely dimmed client-side. Sending it and hiding it in CSS would leak — a
    // player reading the socket/JSON would see it. The GM (owner) gets everything.
    const isOwner = req.campaign.owner_id === req.user.id;
    const q = knex('tokens').where({ scene_id: scene.id });
    if (!isOwner) q.where('hidden', false);
    const tokens = await q.orderBy('created_at', 'asc');

    // Fog is NOT filtered by viewer, deliberately, and the reasoning differs
    // from the hidden-token case above. A player has to draw the fog, so they
    // must receive its geometry: what is sent is exactly what is rendered on
    // their own screen, so withholding it would buy nothing. Fog is a
    // presentation control over the scene image the client already holds
    // (scenes.img_url is sent to every member), NOT a confidentiality boundary
    // like a hidden token, whose row genuinely never leaves the server.
    const fog = await knex('fog_of_war')
      .where({ scene_id: scene.id })
      .orderBy('created_at', 'asc');

    // M4: the characters behind the tokens. Additive — pre-M4 clients that
    // ignore this key are unaffected.
    //
    // The list is built from the ALREADY-FILTERED tokens above, not from the
    // campaign's full actor table, and that ordering is doing real work: a
    // hidden token has been removed from `tokens` before this line, so a player
    // never receives even the projected row of a character whose token the GM
    // is keeping off their board. Confidentiality falls out of the filtering
    // that was already there rather than needing a second rule.
    //
    // The bar on an actor-linked token is DERIVED from these rows
    // (hp_current / hp_max), which is why tokens.bar1_* stays untouched for
    // linked tokens and stays meaningful only for unlinked ones. A player's copy
    // of an NPC carries no hit points at all, so a monster token simply renders
    // no bar for them — no per-token toggle needed.
    const actorIds = [...new Set(tokens.map((t) => t.actor_id).filter(Boolean))];
    let actors = [];
    if (actorIds.length) {
      const rows = await knex('actors')
        .whereIn('id', actorIds)
        .andWhere({ campaign_id: req.campaign.id })
        .orderBy('created_at', 'asc');
      actors = rows.map((a) => shapeActorFor(isOwner, a));
    }

    return res.json({
      scene: publicScene(scene),
      tokens: tokens.map(publicToken),
      fog: fog.map(publicFog),
      actors,
    });
  } catch (err) {
    return next(err);
  }
});

// ---- tokens ----

// DELETE /api/campaigns/:id/scenes/:sceneId — GM destroys a scene.
//
// HARD delete, not the 30-day soft delete campaigns get. The reasoning follows
// the account-deletion decision already recorded for this project: keep the
// cascade, and mitigate with a confirmation that NAMES THE BLAST RADIUS rather
// than a bare "are you sure?". That is why this returns the counts it destroyed
// — the harness reads them first and puts them in the prompt.
//
// The cascade is real: tokens and fog_of_war are both ON DELETE CASCADE, so this
// one call can remove hours of preparation. Counting happens BEFORE the delete
// for the obvious reason that afterwards there is nothing left to count.
//
// A scene delete is also the only operation that can silently invalidate the
// campaign's active scene. The FK does the right thing on its own
// (active_scene_id is ON DELETE SET NULL, verified in break-fog.js) — but the DB
// cannot tell anybody, so players would sit looking at a scene that no longer
// exists while the server refused every request they made. Hence the explicit
// scene:activated broadcast below.
router.delete('/:sceneId', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const wasActive = req.campaign.active_scene_id === scene.id;
    const tokenCount = Number((await knex('tokens').where({ scene_id: scene.id }).count({ n: '*' }).first()).n);
    const fogCount = Number((await knex('fog_of_war').where({ scene_id: scene.id }).count({ n: '*' }).first()).n);
    // M5. combat.scene_id is ON DELETE CASCADE, so deleting a scene destroys any
    // encounter staged on it and every combatant in it. This route's whole
    // design is that the confirmation NAMES what is destroyed rather than asking
    // a bare "are you sure?" — a silent third casualty would make that promise
    // false, so the counts are gathered here alongside tokens and fog.
    const combatCount = Number((await knex('combat').where({ scene_id: scene.id }).count({ n: '*' }).first()).n);
    const combatantCount = Number((await knex('combatants')
      .join('combat', 'combat.id', 'combatants.combat_id')
      .where('combat.scene_id', scene.id)
      .count({ n: '*' }).first()).n);

    await knex('scenes').where({ id: scene.id }).del();

    const sockets = req.app.get('campaignSockets');
    // GM-only: a player has no business learning that a scene they could never
    // open has been removed. Consistent with the active-scene boundary — the
    // only scene ids a player ever hears about are ones they are allowed to load.
    await sockets?.broadcastToOwner(req.campaign.id, 'scene:deleted', {
      campaign_id: req.campaign.id, id: scene.id,
    });
    // If it was the active scene, everyone must be told to stand down. This one
    // IS room-wide: the players were looking at it.
    if (wasActive) {
      sockets?.broadcastRoom(req.campaign.id, 'scene:activated', {
        campaign_id: req.campaign.id, scene_id: null,
      });
    }

    return res.json({
      ok: true,
      id: scene.id,
      was_active: wasActive,
      deleted: {
        tokens: tokenCount,
        fog: fogCount,
        combat: combatCount,
        combatants: combatantCount,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/scenes/:sceneId/tokens — place a token.
// GM: unlimited. Player: at most MAX_PLAYER_TOKENS_PER_SCENE, enforced
// atomically. actor_id stays NULL this pass (standalone token: name + image).
router.post('/:sceneId/tokens', requireMember, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });
    // A player may only place on the active scene — otherwise "players are only
    // on the active scene" would hold for reads but not for writes, and a player
    // could seed tokens onto a map the GM has not opened yet.
    if (!mayUseScene(req, scene)) return res.status(404).json({ error: 'scene not found' });

    const body = req.body || {};
    const isOwner = req.campaign.owner_id === req.user.id;

    // M4: an optional actor link. Resolved BEFORE the other fields so its name,
    // portrait and size can supply their defaults below.
    const linked = await resolveTokenActor({ req, rawActorId: body.actor_id });
    if (linked.error) {
      // Always 404: resolveTokenActor no longer distinguishes "does not exist"
      // from "not yours" (see its header — closing the enumeration oracle V1
      // opened).
      return res.status(404).json({ error: linked.error });
    }
    const actor = linked.actor;

    const name = validateTokenName(body.name);
    if (name.error) return res.status(400).json({ error: name.error });

    const img = validateImageUrl(body.img_url, 'img_url');
    if (img.error) return res.status(400).json({ error: img.error });

    // Position/size default sensibly so a bare {name, img_url} places at origin.
    const x = validateGridCoord(body.x === undefined ? 0 : body.x, 'x');
    if (x.error) return res.status(400).json({ error: x.error });
    const y = validateGridCoord(body.y === undefined ? 0 : body.y, 'y');
    if (y.error) return res.status(400).json({ error: y.error });
    const width = validateTokenSize(body.width === undefined ? 1 : body.width, 'width');
    if (width.error) return res.status(400).json({ error: width.error });
    const height = validateTokenSize(body.height === undefined ? 1 : body.height, 'height');
    if (height.error) return res.status(400).json({ error: height.error });

    // A GM may place a token ALREADY HIDDEN. Without this the only route to a
    // hidden token is place-then-PATCH, and the placement is broadcast to every
    // player in between: the ambush appears on their canvas and then vanishes.
    // Brief, but a genuine spoiler leak in ordinary use, and it defeats the point
    // of the hidden flag. Found while auditing the active-scene work.
    //
    // Players may NOT place hidden tokens, consistent with the existing "player
    // cannot hide (403)" rule on PATCH. A non-owner sending hidden:true has it
    // ignored rather than refused, matching every other non-allow-listed field
    // on this endpoint.
    let hidden = false;
    if (isOwner && body.hidden !== undefined) {
      const h = validateBool(body.hidden, 'hidden');
      if (h.error) return res.status(400).json({ error: h.error });
      hidden = h.value;
    }

    // M5. is_prop marks scenery — a tree, a door, a barricade — so auto-add does
    // not enrol it when a fight is running on this scene. GM-only, and SILENTLY
    // DROPPED for a player rather than refused, matching `hidden` immediately
    // above on this same handler.
    //
    // That is deliberate and it is the exception the M4 refuse-vs-ignore
    // amendment already carved out: that amendment was scoped to ACTORS, and its
    // stated reason for leaving the token routes alone was that `hidden` is a
    // GM-only presentation flag with a safe default rather than authored
    // content. is_prop is exactly that same class of field on exactly that same
    // route, so it follows its neighbour. Two different behaviours for two
    // identical booleans in one handler would be worse than matching.
    let isProp = false;
    if (isOwner && body.is_prop !== undefined) {
      const pr = validateBool(body.is_prop, 'is_prop');
      if (pr.error) return res.status(400).json({ error: pr.error });
      isProp = pr.value;
    }

    // A linked token INHERITS the character's name, portrait and footprint when
    // the request does not override them — placing a Goblin actor should give a
    // token called "Goblin" wearing the goblin's picture, not an unnamed square.
    // An explicit body value still wins, so a GM can drop the same actor twice
    // as "Guard A" and "Guard B". actors.size maps through the SAME 5e size
    // presets the token router already uses (Large -> 2x2), which is the job
    // that column was described as having in SCHEMA_REFERENCE.
    let tokenName = name.value;
    let tokenImg = img.value;
    let tokenW = width.value;
    let tokenH = height.value;
    if (actor) {
      if (body.name === undefined) tokenName = actor.name;
      if (body.img_url === undefined) tokenImg = actor.img_url;
      const preset = SIZE_PRESETS[String(actor.size || '').toLowerCase()];
      if (preset !== undefined) {
        if (body.width === undefined) tokenW = preset;
        if (body.height === undefined) tokenH = preset;
      }
    }

    const insertRow = {
      scene_id: scene.id,
      // Server-resolved, never the raw body value: a forged id was refused above.
      actor_id: actor ? actor.id : null,
      created_by: req.user.id,
      name: tokenName,
      img_url: tokenImg,
      x: x.value,
      y: y.value,
      width: tokenW,
      height: tokenH,
      hidden,
      is_prop: isProp,
    };

    let token;
    if (isOwner) {
      // GM: no per-player cap, but the scene still has a total-token ceiling as
      // abuse prevention (the audit created 6000 tokens in under a second, and
      // every one of them is returned on every client's scene-load).
      try {
        const rows = await withAtomicCap({
          table: 'tokens',
          where: { scene_id: scene.id },
          max: MAX_TOKENS_PER_SCENE,
          capMessage: `a scene may hold at most ${MAX_TOKENS_PER_SCENE} tokens`,
          insert: insertRow,
        });
        token = rows[0];
      } catch (err) {
        if (err.capExceeded) return res.status(409).json({ error: err.message });
        throw err;
      }
    } else {
      // Player: at most N tokens per scene, enforced atomically. Same pattern as
      // the campaign create/join caps: count + insert inside one SERIALIZABLE
      // transaction so N concurrent placements can't all read "count < MAX"
      // before any commits. A loser aborts (40001) and retries against a now
      // accurate count.
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          token = await knex.transaction(async (trx) => {
            await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            const cur = await trx('tokens')
              .where({ scene_id: scene.id, created_by: req.user.id })
              .count({ n: '*' }).first();
            if (Number(cur.n) >= MAX_PLAYER_TOKENS_PER_SCENE) {
              const e = new Error('token cap'); e.tokenCap = true; throw e;
            }
            const [row] = await trx('tokens').insert(insertRow).returning('*');
            return row;
          });
          break;
        } catch (err) {
          if (err.tokenCap) {
            return res.status(409).json({
              error: `players may place at most ${MAX_PLAYER_TOKENS_PER_SCENE} token(s) in a scene`,
            });
          }
          if (err.code === '40001' && attempt < 5) { attempt += 1; continue; }
          throw err;
        }
      }
    }

    const shaped = publicToken(token);

    // Broadcast the placement to the room (including the placer) so every open
    // canvas gets the authoritative row — but a HIDDEN token is announced to the
    // GM alone. The row must not leave the server for players here, exactly as on
    // scene load and on move. The scene-aware helper then applies the second
    // gate: players hear nothing at all about a non-active scene.
    const sockets = req.app.get('campaignSockets');
    // A linked token arrives on a client that may never have seen the actor —
    // a GM placing a monster for the first time. Send the actor FIRST, shaped per
    // tier, so no client ever holds a token pointing at a character it does not
    // have. This reuses the actor:updated event rather than inventing a second
    // one: same payload shape, same two-tier projection, one handler client-side.
    if (sockets && actor) {
      await sockets.broadcastToOwner(req.campaign.id, 'actor:updated', shapeActorFor(true, actor));
      // Only players who may see this scene need it, and only if the token
      // itself is reaching them — a hidden token discloses nothing.
      if (!shaped.hidden) {
        await sockets.broadcastScenePlayers(
          req.campaign.id, scene.id, 'actor:updated', shapeActorFor(false, actor),
        );
      }
    }
    if (shaped.hidden) await sockets?.broadcastToOwner(req.campaign.id, 'token:created', shaped);
    else await sockets?.broadcastScene(req.campaign.id, scene.id, 'token:created', shaped);

    // M5. A token placed on a scene with a RUNNING fight joins the roster
    // automatically, unless it is a prop. autoAddCombatant is a no-op when there
    // is no active combat, so this costs one indexed lookup in the ordinary case.
    //
    // The roster broadcast is the two-payload one in routes/combat.js: a hidden
    // token produces a combatant row the GM receives and players do not, which
    // is why enrolling one here cannot leak it.
    const enrolled = await autoAddCombatant(token);
    if (enrolled) await afterTokensDeleted(req, scene.id);

    return res.status(201).json({ token: shaped, actor: actor ? shapeActorFor(true, actor) : null });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/scenes/:sceneId/tokens/:tokenId
// GM deletes any token; a player deletes only a token they placed (same policy
// as movement). Kept on HTTP: deletion is a structural change, not a per-frame
// delta.
router.delete('/:sceneId/tokens/:tokenId', requireMember, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });
    // This is the one player-reachable WRITE besides placement, and it was missed
    // in the first pass of the active-scene work: without this a player could
    // still delete their own token on a scene the GM had switched away from —
    // mutating state on a map the server refuses to show them.
    if (!mayUseScene(req, scene)) return res.status(404).json({ error: 'scene not found' });

    if (!validUuid(req.params.tokenId)) {
      return res.status(404).json({ error: 'token not found' });
    }
    const token = await knex('tokens')
      .where({ id: req.params.tokenId, scene_id: scene.id })
      .first();
    if (!token) return res.status(404).json({ error: 'token not found' });

    if (!tokenMovePolicy({ campaign: req.campaign, token, userId: req.user.id })) {
      return res.status(403).json({ error: 'you can only remove tokens you placed' });
    }

    await knex('tokens').where({ id: token.id }).del();

    req.app.get('campaignSockets')?.broadcastScene(req.campaign.id, scene.id, 'token:deleted', {
      id: token.id, scene_id: scene.id,
    });

    // M5. combatants.token_id is ON DELETE CASCADE, so the roster row is already
    // gone — but a FOREIGN KEY CANNOT NOTIFY ANYBODY, so every open tracker
    // would keep showing a combatant whose token no longer exists. Same lesson
    // DELETE /:sceneId learned when the FK silently cleared active_scene_id.
    await afterTokensDeleted(req, scene.id);

    return res.json({ ok: true, id: token.id });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/scenes/:sceneId/tokens/:tokenId — GM edits a token's
// size / visibility / lock. GM-only this pass (players' tokens are move-only for
// the player; the GM runs the board). Settings may later widen this.
//
// Accepts any subset of:
//   size    — a 5e size preset name (sets width AND height from SIZE_PRESETS)
//   width   — explicit grid-unit width  (alternative to size)
//   height  — explicit grid-unit height (alternative to size)
//   hidden  — hide/show from players
//   locked  — lock/unlock (a locked token refuses moves; see socket.js)
//   actor_id — link this token to a character, or null to unlink it (M4)
//
// Linking is available here as well as at placement because a GM populates a map
// before deciding what everything is: drop the squares, then say which one is
// the boss. Unlinking (null) leaves the token on the board as a plain marker —
// the same end state the ON DELETE SET NULL foreign key produces when the actor
// itself is deleted.
router.patch('/:sceneId/tokens/:tokenId', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    if (!validUuid(req.params.tokenId)) return res.status(404).json({ error: 'token not found' });
    const token = await knex('tokens')
      .where({ id: req.params.tokenId, scene_id: scene.id }).first();
    if (!token) return res.status(404).json({ error: 'token not found' });

    const body = req.body || {};
    const updates = {};

    // A named 5e size preset sets both dimensions. `size` and explicit
    // width/height are mutually exclusive to avoid an ambiguous request.
    if (body.size !== undefined) {
      if (body.width !== undefined || body.height !== undefined) {
        return res.status(400).json({ error: 'use either size or width/height, not both' });
      }
      const key = typeof body.size === 'string' ? body.size.toLowerCase() : '';
      if (!Object.prototype.hasOwnProperty.call(SIZE_PRESETS, key)) {
        return res.status(400).json({ error: `size must be one of: ${Object.keys(SIZE_PRESETS).join(', ')}` });
      }
      updates.width = SIZE_PRESETS[key];
      updates.height = SIZE_PRESETS[key];
    } else {
      if (body.width !== undefined) {
        const w = validateTokenSize(body.width, 'width');
        if (w.error) return res.status(400).json({ error: w.error });
        updates.width = w.value;
      }
      if (body.height !== undefined) {
        const h = validateTokenSize(body.height, 'height');
        if (h.error) return res.status(400).json({ error: h.error });
        updates.height = h.value;
      }
    }

    // Link / unlink. This route is requireOwner, so resolveTokenActor's per-role
    // branch always takes the GM path; it is still routed through the shared
    // resolver so the campaign-scoping check has exactly one implementation.
    let linkedActor = null;
    if (body.actor_id !== undefined) {
      const linked = await resolveTokenActor({ req, rawActorId: body.actor_id });
      if (linked.error) {
        // Always 404 — see resolveTokenActor's header.
        return res.status(404).json({ error: linked.error });
      }
      linkedActor = linked.actor;
      updates.actor_id = linked.actor ? linked.actor.id : null;
    }

    if (body.hidden !== undefined) {
      const b = validateBool(body.hidden, 'hidden');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.hidden = b.value;
    }
    if (body.locked !== undefined) {
      const b = validateBool(body.locked, 'locked');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.locked = b.value;
    }
    // M5. Toggling scenery on/off. This route is requireOwner, so unlike
    // placement there is no player branch to consider.
    if (body.is_prop !== undefined) {
      const b = validateBool(body.is_prop, 'is_prop');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.is_prop = b.value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('tokens').where({ id: token.id }).update(updates).returning('*');
    const shaped = publicToken(row);

    // Visibility-aware broadcast. If the token is (now) hidden, only the GM should
    // learn its state; players must not receive it. If it just became visible, a
    // full 'token:created' to players re-materialises it on their canvas.
    const sockets = req.app.get('campaignSockets');
    if (sockets && linkedActor) {
      // Newly linked: recipients need the character before the token update
      // that references it.
      await sockets.broadcastToOwner(req.campaign.id, 'actor:updated', shapeActorFor(true, linkedActor));
      if (!row.hidden) {
        await sockets.broadcastScenePlayers(
          req.campaign.id, scene.id, 'actor:updated', shapeActorFor(false, linkedActor),
        );
      }
    }
    if (sockets) {
      const becameHidden = row.hidden === true;
      const becameVisible = token.hidden === true && row.hidden === false;
      if (becameHidden) {
        // Tell players to drop it (if they could see it before), GM to update it.
        sockets.broadcastScenePlayers(req.campaign.id, scene.id, 'token:deleted', { id: row.id, scene_id: scene.id });
        sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
      } else if (becameVisible) {
        sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
        sockets.broadcastScenePlayers(req.campaign.id, scene.id, 'token:created', shaped);
      } else {
        // Not a visibility change (resize/lock on an already-visible token, or an
        // edit to an already-hidden one): update whoever can legitimately see it.
        if (row.hidden) sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
        else sockets.broadcastScene(req.campaign.id, scene.id, 'token:updated', shaped);
      }
    }

    // M5. Tagging something a prop while it stands in the roster must REMOVE it,
    // or the flag is lying; untagging it while a fight runs enrols it. Only
    // fires when the flag actually changed, so a resize never touches combat.
    if (body.is_prop !== undefined && row.is_prop !== token.is_prop) {
      await syncPropFlag(req, row);
    }

    return res.json({ token: shaped });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/scenes/:sceneId/tokens/batch-delete — GM removes many
// tokens at once (marquee delete). GM-only, so no per-token authority check is
// needed; the whole call is gated by requireOwner. Scoped to the scene, run in
// one transaction so a mid-batch failure doesn't leave a half-applied delete.
router.post('/:sceneId/tokens/batch-delete', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const ids = validateTokenIdList(req.body && req.body.token_ids);
    if (ids.error) return res.status(400).json({ error: ids.error });

    // Only ids that actually belong to this scene are deletable; a foreign id is
    // silently ignored rather than erroring the whole batch.
    const deleted = await knex('tokens')
      .whereIn('id', ids.value)
      .where('scene_id', scene.id)
      .del()
      .returning('id');
    const deletedIds = deleted.map((r) => r.id);

    const sockets = req.app.get('campaignSockets');
    if (sockets && deletedIds.length) {
      // Deletion is broadcast to everyone: a player who could see a token must be
      // told it's gone. (Hidden tokens they never had are simply a no-op for them.)
      sockets.broadcastScene(req.campaign.id, scene.id, 'token:deleted-batch', {
        ids: deletedIds, scene_id: scene.id,
      });
    }

    // M5. Same cascade-cannot-notify problem as the single delete above.
    if (deletedIds.length) await afterTokensDeleted(req, scene.id);

    return res.json({ ok: true, deleted: deletedIds });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/scenes/:sceneId/tokens/copy — GM pastes tokens.
// GM-only; every pasted token is stamped created_by = the GM (so the pasting GM
// owns them, and the player 1-token cap is never involved).
//
// The body carries token SPECS, not ids:
//   { tokens: [{ name, img_url, width, height, rotation, hidden, x, y }, ...] }
//
// Why specs and not ids: a clipboard is a SNAPSHOT, not a pointer. An earlier
// version re-read the source rows from the DB by id, which meant copy-then-delete
// (and cut, which deletes by definition) could never be pasted — the source was
// gone. Holding the data client-side is what makes cut work at all.
//
// Trusting client-supplied data here is safe because nothing is trusted: every
// field is validated exactly as it is on placement, and `created_by` and
// `scene_id` are set server-side, never from the body. The worst a hostile
// client can do is create tokens it is already allowed to create via the normal
// placement endpoint.
//
// M4 CHANGED ONE THING HERE, and it is worth recording because it relaxes an
// existing hardening. Until now actor_id was forced NULL on this path, which
// meant copying a linked token produced an unlinked one — copy/paste and
// duplicate are how a GM populates an encounter, so pasting five goblins that
// all point at the one Goblin actor is precisely what the feature is for.
// actor_id is now taken from the spec and put through resolveTokenActor(), the
// SAME resolver placement uses: it must be a real actor in THIS campaign that
// this caller may place. A forged id from another campaign is still refused, so
// what changed is "always NULL" -> "NULL unless validated", not "trusted".
router.post('/:sceneId/tokens/copy', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const specs = req.body && req.body.tokens;
    if (!Array.isArray(specs)) return res.status(400).json({ error: 'tokens must be an array' });
    if (specs.length === 0) return res.status(400).json({ error: 'tokens is empty' });
    if (specs.length > 500) return res.status(400).json({ error: 'too many tokens (max 500)' });

    // Validate every field of every spec before touching the DB — one bad spec
    // rejects the whole paste rather than half-applying it.
    const rows = [];
    // Distinct actors referenced by this paste, so the broadcast below sends
    // each one once rather than once per pasted token.
    const linkedActors = new Map();
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') return res.status(400).json({ error: 'invalid token spec' });

      const name = validateTokenName(spec.name);
      if (name.error) return res.status(400).json({ error: name.error });
      const img = validateImageUrl(spec.img_url, 'img_url');
      if (img.error) return res.status(400).json({ error: img.error });
      const x = validateGridCoord(spec.x === undefined ? 0 : spec.x, 'x');
      if (x.error) return res.status(400).json({ error: x.error });
      const y = validateGridCoord(spec.y === undefined ? 0 : spec.y, 'y');
      if (y.error) return res.status(400).json({ error: y.error });
      const width = validateTokenSize(spec.width === undefined ? 1 : spec.width, 'width');
      if (width.error) return res.status(400).json({ error: width.error });
      const height = validateTokenSize(spec.height === undefined ? 1 : spec.height, 'height');
      if (height.error) return res.status(400).json({ error: height.error });

      let hidden = false;
      if (spec.hidden !== undefined) {
        const b = validateBool(spec.hidden, 'hidden');
        if (b.error) return res.status(400).json({ error: b.error });
        hidden = b.value;
      }

      // Same resolver as placement. One bad spec rejects the whole paste rather
      // than half-applying it, consistent with every other field here.
      const linked = await resolveTokenActor({ req, rawActorId: spec.actor_id });
      if (linked.error) {
        // Always 404 — see resolveTokenActor's header.
        return res.status(404).json({ error: linked.error });
      }
      if (linked.actor) linkedActors.set(linked.actor.id, linked.actor);

      // Hand-listed columns only. scene_id / created_by come from the server,
      // never from the body; actor_id is the RESOLVED actor, not the raw spec
      // value — a forged or foreign id was refused above.
      rows.push({
        scene_id: scene.id,
        actor_id: linked.actor ? linked.actor.id : null,
        created_by: req.user.id,
        name: name.value,
        img_url: img.value,
        x: x.value,
        y: y.value,
        width: width.value,
        height: height.value,
        hidden,
        locked: false,          // a pasted token starts unlocked
        // A copied prop stays a prop: pasting a row of trees should not fill the
        // initiative roster. Read from the spec like every other field and
        // validated the same way; this route is requireOwner.
        is_prop: spec.is_prop === undefined ? false : spec.is_prop === true || spec.is_prop === 'true',
      });
    }

    // The scene's total-token ceiling applies here too, and this is the biggest
    // amplification vector (up to 500 rows per request), so the count and the
    // insert happen inside one serialisable transaction.
    let inserted;
    try {
      inserted = await withAtomicCap({
        table: 'tokens',
        where: { scene_id: scene.id },
        max: MAX_TOKENS_PER_SCENE,
        capMessage: `a scene may hold at most ${MAX_TOKENS_PER_SCENE} tokens`,
        insert: rows,
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }
    const shaped = inserted.map(publicToken);

    const sockets = req.app.get('campaignSockets');
    if (sockets) {
      // Actors first, once each, so no client receives a token pointing at a
      // character it does not yet hold.
      const anyVisible = shaped.some((t) => !t.hidden);
      for (const a of linkedActors.values()) {
        await sockets.broadcastToOwner(req.campaign.id, 'actor:updated', shapeActorFor(true, a));
        if (anyVisible) {
          await sockets.broadcastScenePlayers(
            req.campaign.id, scene.id, 'actor:updated', shapeActorFor(false, a),
          );
        }
      }
      for (const t of shaped) {
        if (t.hidden) sockets.broadcastToOwner(req.campaign.id, 'token:created', t);
        else sockets.broadcastScene(req.campaign.id, scene.id, 'token:created', t);
      }
    }

    // M5. Paste is how a GM populates an encounter, so it is the auto-add path
    // that matters most in practice: pasting five goblins mid-fight should put
    // five goblins in the roster, each with its OWN hp_override defaulted from
    // the shared actor's hp_max. One roster broadcast at the end rather than one
    // per token — the same "N ids in one event, not N events" discipline the
    // batch token operations already follow.
    let enrolledAny = false;
    for (const t of inserted) {
      // eslint-disable-next-line no-await-in-loop
      if (await autoAddCombatant(t)) enrolledAny = true;
    }
    if (enrolledAny) await afterTokensDeleted(req, scene.id);

    return res.status(201).json({ tokens: shaped });
  } catch (err) {
    return next(err);
  }
});

// ---- fog of war (M3) ----
//
// Every fog write is GM-only (requireOwner) and every one is scoped through
// loadSceneInCampaign, so a non-member gets 404 — no existence leak — and a
// member of another campaign cannot reach these rows at all.
//
// All fog writes are HTTP, not socket events. Drawing, toggling, moving and
// deleting a region are STRUCTURAL changes, not per-frame deltas, so they sit on
// the same side of the "load heavy, update light" split as token placement and
// deletion. The practical consequence is that fog adds ZERO new authorisation
// surface to socket.js: there is no new event handler to get wrong.
//
// Render rule the whole feature is built around, order-independent because the
// schema deliberately has no z_index:
//     fog = union(revealed = false) - union(revealed = true)

// POST /api/campaigns/:id/scenes/:sceneId/fog — GM draws a region.
router.post('/:sceneId/fog', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const body = req.body || {};

    const type = validateFogType(body.type);
    if (type.error) return res.status(400).json({ error: type.error });

    // Geometry rules are per-type, and the validator NORMALISES as it goes (a
    // backwards rect drag is stored as [min, max]), so what lands in jsonb is
    // canonical regardless of how the client drew it.
    const points = validateFogPoints(type.value, body.points);
    if (points.error) return res.status(400).json({ error: points.error });

    // Default false: a freshly drawn region COVERS, which is what the gesture of
    // dragging a shape onto the map means. An explicit revealed:true creates the
    // region as a hole, which is how "cover everything, then punch windows" works.
    let revealed = false;
    if (body.revealed !== undefined) {
      const b = validateBool(body.revealed, 'revealed');
      if (b.error) return res.status(400).json({ error: b.error });
      revealed = b.value;
    }

    // Hand-listed columns only; scene_id comes from the server, never the body.
    // points is JSON.stringify'd because node-pg turns a bare JS ARRAY into a
    // Postgres array literal, which a jsonb column rejects — objects are inferred
    // correctly but arrays are not, and every fog region's points IS an array.
    let rows;
    try {
      rows = await withAtomicCap({
        table: 'fog_of_war',
        where: { scene_id: scene.id },
        max: MAX_FOG_REGIONS_PER_SCENE,
        capMessage: `a scene may hold at most ${MAX_FOG_REGIONS_PER_SCENE} fog regions`,
        insert: {
          scene_id: scene.id,
          type: type.value,
          points: JSON.stringify(points.value),
          revealed,
        },
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    const shaped = publicFog(rows[0]);
    req.app.get('campaignSockets')?.broadcastScene(req.campaign.id, scene.id, 'fog:created', shaped);

    return res.status(201).json({ fog: shaped });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/scenes/:sceneId/fog/:fogId — GM toggles a region
// between fog and revealed, and/or moves/reshapes it.
//
// `type` is NOT patchable: changing a rect into a poly changes what `points`
// even means, so that is a delete plus a create rather than an update. New
// points are therefore validated against the STORED type, and re-validated in
// full — the update path is not a way around the geometry rules.
router.patch('/:sceneId/fog/:fogId', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const fog = await loadFogInScene(req.params.fogId, scene.id);
    if (!fog) return res.status(404).json({ error: 'fog region not found' });

    const body = req.body || {};
    const updates = {};

    if (body.revealed !== undefined) {
      const b = validateBool(body.revealed, 'revealed');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.revealed = b.value;
    }

    if (body.points !== undefined) {
      const points = validateFogPoints(fog.type, body.points);
      if (points.error) return res.status(400).json({ error: points.error });
      updates.points = JSON.stringify(points.value);
    }

    if (body.type !== undefined) {
      return res.status(400).json({ error: 'type cannot be changed; delete and redraw instead' });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('fog_of_war').where({ id: fog.id }).update(updates).returning('*');
    const shaped = publicFog(row);

    req.app.get('campaignSockets')?.broadcastScene(req.campaign.id, scene.id, 'fog:updated', shaped);

    return res.json({ fog: shaped });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/scenes/:sceneId/fog/:fogId — GM removes one region.
router.delete('/:sceneId/fog/:fogId', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const fog = await loadFogInScene(req.params.fogId, scene.id);
    if (!fog) return res.status(404).json({ error: 'fog region not found' });

    await knex('fog_of_war').where({ id: fog.id }).del();

    req.app.get('campaignSockets')?.broadcastScene(req.campaign.id, scene.id, 'fog:deleted', {
      id: fog.id, scene_id: scene.id,
    });

    return res.json({ ok: true, id: fog.id });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/scenes/:sceneId/fog/batch-delete — GM removes many
// regions at once (marquee delete), or clears the scene's fog entirely.
//
// Body is either { fog_ids: [uuid, ...] } or { all: true }. The `all` form
// exists so clearing a fully-fogged map is one request instead of a round-trip
// carrying 200 ids back to the server that the server could derive itself.
router.post('/:sceneId/fog/batch-delete', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const body = req.body || {};
    let deletedIds;

    if (body.all !== undefined) {
      const b = validateBool(body.all, 'all');
      if (b.error) return res.status(400).json({ error: b.error });
      if (!b.value) return res.status(400).json({ error: 'all must be true, or send fog_ids' });
      const deleted = await knex('fog_of_war').where({ scene_id: scene.id }).del().returning('id');
      deletedIds = deleted.map((r) => r.id);
    } else {
      const ids = validateTokenIdList(body.fog_ids, 'fog_ids');
      if (ids.error) return res.status(400).json({ error: ids.error });

      // Scene-scoped: an id belonging to another scene is silently skipped rather
      // than erroring the whole batch, matching the token batch-delete.
      const deleted = await knex('fog_of_war')
        .whereIn('id', ids.value)
        .where('scene_id', scene.id)
        .del()
        .returning('id');
      deletedIds = deleted.map((r) => r.id);
    }

    if (deletedIds.length) {
      req.app.get('campaignSockets')?.broadcastScene(req.campaign.id, scene.id, 'fog:deleted-batch', {
        ids: deletedIds, scene_id: scene.id,
      });
    }

    return res.json({ ok: true, deleted: deletedIds });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/scenes/:sceneId/fog/copy — GM pastes fog regions.
//
// Same clipboard model as tokens, for the same recorded reason: the body carries
// region SPECS, not ids, because a clipboard is a SNAPSHOT and not a pointer.
// An id-based paste cannot survive a CUT, which deletes the source by definition.
//
// Trusting client-supplied specs is safe because nothing is trusted: every field
// goes through exactly the validation the create endpoint applies, and scene_id
// is set server-side. The worst a hostile client achieves is creating regions it
// is already allowed to create one at a time.
router.post('/:sceneId/fog/copy', requireOwner, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const specs = req.body && req.body.regions;
    if (!Array.isArray(specs)) return res.status(400).json({ error: 'regions must be an array' });
    if (specs.length === 0) return res.status(400).json({ error: 'regions is empty' });
    // Bounded by the per-scene cap: one request can never legitimately create
    // more regions than a scene may hold.
    if (specs.length > MAX_FOG_REGIONS_PER_SCENE) {
      return res.status(400).json({ error: `too many regions (max ${MAX_FOG_REGIONS_PER_SCENE})` });
    }

    // Validate every spec before touching the DB — one bad spec rejects the whole
    // paste rather than half-applying it.
    const rows = [];
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return res.status(400).json({ error: 'invalid fog spec' });
      }

      const type = validateFogType(spec.type);
      if (type.error) return res.status(400).json({ error: type.error });

      const points = validateFogPoints(type.value, spec.points);
      if (points.error) return res.status(400).json({ error: points.error });

      let revealed = false;
      if (spec.revealed !== undefined) {
        const b = validateBool(spec.revealed, 'revealed');
        if (b.error) return res.status(400).json({ error: b.error });
        revealed = b.value;
      }

      rows.push({
        scene_id: scene.id,
        type: type.value,
        points: JSON.stringify(points.value),
        revealed,
      });
    }

    // The per-scene ceiling applies here too, and this is the biggest
    // amplification vector, so count and insert happen in one serialisable
    // transaction rather than as a read-then-write.
    let inserted;
    try {
      inserted = await withAtomicCap({
        table: 'fog_of_war',
        where: { scene_id: scene.id },
        max: MAX_FOG_REGIONS_PER_SCENE,
        capMessage: `a scene may hold at most ${MAX_FOG_REGIONS_PER_SCENE} fog regions`,
        insert: rows,
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    const shaped = inserted.map(publicFog);
    const sockets = req.app.get('campaignSockets');
    if (sockets) {
      for (const f of shaped) sockets.broadcastScene(req.campaign.id, scene.id, 'fog:created', f);
    }

    return res.status(201).json({ fog: shaped });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicToken,
  publicScene,
  publicFog,
  tokenMovePolicy,
  // Re-exported from services/sceneAccess.js so socket.js and every existing
  // suite keep importing them from here. mayUseScene is now exported too, which
  // it never was — that omission is why socket.js had two inline copies of the
  // active-scene rule.
  loadSceneInCampaign,
  mayUseScene,
  loadFogInScene,
  validateGridCoord,
  validateTokenSize,
  MAX_PLAYER_TOKENS_PER_SCENE,
  MAX_FOG_REGIONS_PER_SCENE,
  SIZE_PRESETS,
};
