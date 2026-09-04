// Combat (M5), mounted under /api/campaigns/:id/combat so that requireAuth /
// requireMember / requireOwner, req.campaign and req.isOwner apply exactly as
// they do to the campaign, scene, actor and item routes.
//
// A combat is a per-scene OVERLAY on the tokens already standing on that scene:
// an ordered roster with per-instance hit points. It is not a turn engine. Turn
// sequencing (combat.round, combat.turn_index, combatants.initiative) was cut
// from scope by explicit decision — the order is a visual aid the GM arranges by
// hand, and nothing on the server advances it.
//
// ---------------------------------------------------------------------------
// THE DOORS PROBLEM — why this file is mostly filtering
// ---------------------------------------------------------------------------
// M4 closed two vulnerabilities with one shape: ONE RESOURCE, SEVERAL DOORS, THE
// LOCK FITTED TO SOME OF THEM. V1 was a rule the scene load applied correctly
// and the list / detail / broadcast paths did not. V2 was a rule those three
// then applied correctly and a sibling inventory route did not.
//
// combatants is a THIRD door onto the same resources, and it enters the
// scenes -> tokens -> actors path sideways, at the token. It inherits nothing
// automatically. Four existing rules are bypassed by construction unless they
// are written out here:
//
//   1. tokens.hidden. combatants.token_id is NOT NULL, so every combatant names
//      a token, and a token may be hidden. Returning the roster unfiltered ships
//      the ambusher's token id to the table. Even a blanked payload leaks: seven
//      rows against four visible tokens is a countable disclosure of how many
//      things are about to jump the party. So the fix is to DROP ROWS, not to
//      blank fields — the roster is variable-length per recipient.
//
//   2. playersMayKnowActor. If the roster's actor array were assembled from
//      combatant rows rather than from an already-filtered token list, it would
//      hand players NPCs the scene load correctly withheld. That is V1 exactly.
//      Here the actor list is built from the filtered rows, for free, the same
//      way GET /scenes/:sceneId does it.
//
//   3. mayUseScene. combat.scene_id is an independent column and nothing forces
//      it to equal campaigns.active_scene_id — a GM legitimately stages an
//      encounter on a prep map. Without the gate a player reads the roster of a
//      fight on a scene the server refuses to show them: M3's V2 in a new door.
//
//   4. shapeActorFor's HP projection. combatants.hp_override is a monster's hit
//      points wearing a different column name. It is gated by hp_visible below.
//
// Every one of these has to hold on BOTH transports, which is why each broadcast
// in this file sends two different payloads rather than one payload to one room.
//
// ---------------------------------------------------------------------------
// PER-INSTANCE HIT POINTS — the reason combatants carries HP at all
// ---------------------------------------------------------------------------
// tokens.actor_id is MANY-TO-ONE. Five goblin tokens link to one Goblin actor
// and share one actors.hp_current. Correct for a player character (one
// individual, one authoritative sheet); wrong for a monster, where the actor is
// a TEMPLATE and each token is an INSTANCE taking its own damage.
//
//   current HP -> combatants.hp_override  (per instance)
//   max HP     -> actors.hp_max           (shared — every goblin of that type
//                                          really does have the same maximum)
//
// Which is why there is no hp_override_max column. The bar reads
// hp_override / actor.hp_max.
//
// THREE LIMITS, stated so a later session does not read them as bugs:
//   - It is COMBAT-SCOPED. No combatant row, no per-instance HP; five goblins
//     outside a fight still show one shared bar. Acceptable: HP tracking is what
//     a fight is for.
//   - It ENDS WITH THE FIGHT. New combat, new rows, overrides gone.
//   - A tokens.hp_current column would fix both and is REFUSED. It would be a
//     THIRD authority over hit points alongside actors.hp_current and
//     hp_override — three places a disclosure rule has to be fitted, which is
//     the M4 vulnerability shape by construction.

const express = require('express');
const knex = require('../db');
const { requireMember, requireOwner } = require('../middleware/campaignAuth');
const { loadSceneInCampaign, mayUseScene, validUuid } = require('../services/sceneAccess');
const { withAtomicCap } = require('../services/atomicCap');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const {
  validateCombatName, validateHpOverride, validateBool,
  validateSortOrder, validateTokenIdList, validateInt,
} = require('../services/validators');
const { shapeActorFor } = require('./actors');

const router = express.Router({ mergeParams: true });

// Same policy as scenes.js and actors.js: reads unlimited (an open tracker polls
// them), writes rate-bounded. The caps below bound total state; this bounds rate.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// CHOSEN, not measured — abuse prevention, per the standing constraint, enforced
// atomically. Matched to MAX_TOKENS_PER_SCENE because a combatant is a token and
// the roster cannot meaningfully exceed the board.
//
// Note this cap is NOT justified by "the token cap bounds it transitively
// anyway". That reasoning is on record in PROJECT_STATE as the one that produced
// the project's last non-atomic cap: locally true, and not the rule this project
// committed to. Every "no more than N of X" is enforced here with no carve-outs.
const MAX_COMBATANTS_PER_COMBAT = 500;

// "At most ONE active combat per scene." A cap of 1 is still a cap, so it goes
// through the same primitive: two parallel "start encounter" clicks would
// otherwise both read zero and both insert.
const MAX_ACTIVE_COMBATS_PER_SCENE = 1;

// ---------------------------------------------------------------------------
// Response shapes — explicit allow-lists, mirroring SAFE_COLUMNS discipline
// ---------------------------------------------------------------------------

function publicCombat(c) {
  if (!c) return null;
  return {
    id: c.id,
    campaign_id: c.campaign_id,
    scene_id: c.scene_id,
    name: c.name,
    active: c.active,
    round: c.round,
    turn_index: c.turn_index,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// A combatant, shaped for one recipient.
//
// The payload deliberately carries NO token data beyond token_id — no name, no
// image, no position. The client already holds the token from the scene load and
// joins on the id. This is the M4 "inventory broadcasts carry no data" decision
// applied again, and it buys the same thing: the token projection exists in
// exactly one place (publicToken, plus the hidden filter), so there is no second
// copy of it here to drift or leak.
//
// It also means a combatant that reaches a recipient always names a token that
// recipient already has, because both are filtered by the same rule.
//
// hp_override is included ONLY when hp_visible is true. hp_visible governs
// hp_override and nothing else: the linked actor's own hp_current stays
// shapeActorFor's sole business, because five goblin tokens share one actor row
// and a per-combatant switch cannot coherently disclose a per-actor value.
function shapeCombatantFor(isOwner, c) {
  if (!c) return null;
  const base = {
    id: c.id,
    combat_id: c.combat_id,
    token_id: c.token_id,
    sort_order: c.sort_order,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
  if (isOwner) {
    return { ...base, hp_override: c.hp_override, hp_visible: c.hp_visible };
  }
  // A player is not told whether a hidden number exists, only shown a visible
  // one. Sending hp_visible:false alongside a withheld value would announce
  // "there is a number here you may not see", which is a smaller leak than the
  // number but still a leak, and it buys the client nothing it cannot infer from
  // the absent key.
  if (c.hp_visible) return { ...base, hp_override: c.hp_override };
  return base;
}

// ---------------------------------------------------------------------------
// Loading and filtering
// ---------------------------------------------------------------------------

// A combat is only addressable through its campaign, and then only if the caller
// may use its scene. Two-step scoping, exactly as loadFogInScene and
// loadActorInCampaign do it.
//
// Returns { combat, scene } or null. NULL IS ALWAYS A 404 to the caller — never
// a 403 — so a player cannot distinguish "no such combat", "a combat on a scene
// you may not open" and "a combat in another campaign".
async function loadCombatForRequest(req) {
  if (!validUuid(req.params.combatId)) return null;
  const combat = await knex('combat')
    .where({ id: req.params.combatId, campaign_id: req.campaign.id })
    .first();
  if (!combat) return null;

  const scene = await loadSceneInCampaign(combat.scene_id, req.campaign.id);
  if (!scene) return null;
  if (!mayUseScene(req, scene)) return null;

  return { combat, scene };
}

// The roster, filtered and shaped for one recipient.
//
// ORDER OF OPERATIONS MATTERS AND IS LOAD-BEARING: drop rows first, project
// fields second. A hidden token's combatant must not appear at all, so
// hp_visible is irrelevant for it — the row never ships. Implementing the
// toggle as the ONLY gate would delete the row-level rule and rebuild V1.
//
// The join to tokens is what applies the hidden filter, and it is an explicit
// column list rather than a select(*) so the token's own fields cannot leak into
// scope and be accidentally spread into a payload.
async function loadRoster({ combat, isOwner }) {
  const q = knex('combatants')
    .join('tokens', 'tokens.id', 'combatants.token_id')
    .where('combatants.combat_id', combat.id)
    .orderBy([
      { column: 'combatants.sort_order', order: 'asc' },
      { column: 'combatants.created_at', order: 'asc' },
    ])
    .select(
      'combatants.id',
      'combatants.combat_id',
      'combatants.token_id',
      'combatants.sort_order',
      'combatants.hp_override',
      'combatants.hp_visible',
      'combatants.created_at',
      'combatants.updated_at',
      'tokens.hidden as token_hidden',
      'tokens.actor_id as token_actor_id',
    );

  // Rule 1. A player never receives a combatant whose token they do not have.
  if (!isOwner) q.where('tokens.hidden', false);

  const rows = await q;
  return rows;
}

// The characters behind the roster, shaped per tier.
//
// Built from the ALREADY-FILTERED rows, never from the campaign's actor table.
// That ordering is doing the security work: a hidden token was removed above, so
// its actor never enters this list, and confidentiality falls out of the
// filtering that was already there rather than needing a second rule. This is
// the pattern GET /scenes/:sceneId established and that M4's V1 was the failure
// to follow.
async function loadRosterActors({ rows, campaignId, isOwner }) {
  const ids = [...new Set(rows.map((r) => r.token_actor_id).filter(Boolean))];
  if (!ids.length) return [];
  const actors = await knex('actors')
    .whereIn('id', ids)
    .andWhere({ campaign_id: campaignId })
    .orderBy('created_at', 'asc');
  return actors.map((a) => shapeActorFor(isOwner, a));
}

// Broadcast a combat delta on BOTH tiers, as two different payloads.
//
// The player half is sent only when the combat's scene is the active scene, via
// broadcastScenePlayers — the socket half of rule 3. Without it the HTTP gate
// would hold and the socket would leak the whole roster of a prep-map encounter,
// which is precisely M3's V2.
//
// The two payloads are not the same array with fields removed: they can have
// DIFFERENT LENGTHS, because hidden-token combatants are dropped entirely for
// players. That is why the roster is re-derived per tier rather than mapped.
async function broadcastRoster(req, combat) {
  const sockets = req.app.get('campaignSockets');
  if (!sockets) return;

  const gmRows = await loadRoster({ combat, isOwner: true });
  await sockets.broadcastToOwner(req.campaign.id, 'combat:updated', {
    combat: publicCombat(combat),
    combatants: gmRows.map((r) => shapeCombatantFor(true, r)),
  });

  const playerRows = await loadRoster({ combat, isOwner: false });
  await sockets.broadcastScenePlayers(
    req.campaign.id, combat.scene_id, 'combat:updated',
    {
      combat: publicCombat(combat),
      combatants: playerRows.map((r) => shapeCombatantFor(false, r)),
    },
  );
}

// ---------------------------------------------------------------------------
// Auto-add — the hook routes/scenes.js calls on placement and paste
// ---------------------------------------------------------------------------

// Find the running fight on a scene, if there is one.
async function activeCombatForScene(sceneId) {
  return knex('combat').where({ scene_id: sceneId, active: true }).first();
}

// Default per-instance HP for a newly enrolled combatant.
//
// NPC-linked  -> actor.hp_max, so five goblins each start at the template's
//                maximum and diverge from there. This is a COPY, not a
//                derivation: one integer read and written unchanged, no
//                modifier, no roll, no formula. It stays on the safe side of the
//                "dice do not apply results" line while making the column usable
//                instead of something a GM has to type 20 times.
// PC-linked   -> NULL. Copying hp_max onto a player character would HEAL THEM TO
//                FULL at the start of every fight, discarding the number they
//                have been tracking across sessions. Their sheet is
//                authoritative; the override falls through to it.
// Unlinked    -> NULL. No actor to ask.
//
// hp_max defaults to 0 on actors, and a goblin entering a fight at 0 hit points
// is worse than one with no override at all, so a zero maximum yields NULL.
async function defaultHpOverride(token) {
  if (!token.actor_id) return null;
  const actor = await knex('actors').where({ id: token.actor_id }).first();
  if (!actor || !actor.is_npc) return null;
  const max = Number(actor.hp_max);
  return Number.isFinite(max) && max > 0 ? max : null;
}

// Enrol one token in the scene's running fight, if there is one and the token is
// eligible. Called from token placement and paste in routes/scenes.js.
//
// PROPS ARE SKIPPED. Auto-add is what makes tokens.is_prop necessary: without
// it, every tree, door and barricade placed mid-fight joins the roster. is_prop
// is a real column rather than "actor_id IS NULL" because a GM legitimately
// drops an unlinked square called "Ogre" when they never made it a sheet, and
// deriving prop-ness from the link would be true for the common case and false
// for that one — the M4 V1 shape.
//
// Returns the inserted row, or null if nothing was added. Never throws on the
// cap: a fight at its ceiling silently does not enrol the token rather than
// failing the placement, because the placement itself is legitimate and refusing
// it would make the token cap and the combatant cap interact confusingly.
async function autoAddCombatant(token) {
  if (!token || token.is_prop) return null;
  const combat = await activeCombatForScene(token.scene_id);
  if (!combat) return null;

  const hpOverride = await defaultHpOverride(token);
  // New combatants land at the end of the order. sort_order is a visual aid, so
  // "arrived last, listed last" is the only ordering the server can honestly
  // assert; the GM rearranges from there.
  const maxRow = await knex('combatants')
    .where({ combat_id: combat.id })
    .max({ m: 'sort_order' })
    .first();
  const sortOrder = Number(maxRow && maxRow.m != null ? maxRow.m : -1) + 1;

  try {
    const rows = await withAtomicCap({
      table: 'combatants',
      where: { combat_id: combat.id },
      max: MAX_COMBATANTS_PER_COMBAT,
      capMessage: `a combat may hold at most ${MAX_COMBATANTS_PER_COMBAT} combatants`,
      insert: {
        combat_id: combat.id,
        token_id: token.id,
        sort_order: sortOrder,
        hp_override: hpOverride,
      },
      // UNIQUE (combat_id, token_id) makes re-enrolment a no-op rather than a
      // duplicate row or a 500. The conflict branch counts a merge as adding 0,
      // which is correct: nothing new enters the capped set.
      conflict: {
        columns: ['combat_id', 'token_id'],
        match: { combat_id: combat.id, token_id: token.id },
        merge: ['updated_at'],
      },
    });
    return rows[0] || null;
  } catch (err) {
    if (err.capExceeded) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// combat
// ---------------------------------------------------------------------------

// GET /api/campaigns/:id/combat — list combats.
//
// The GM sees every combat in the campaign. A PLAYER sees at most the one on the
// active scene, and an empty array otherwise — the same shape GET /scenes takes,
// and for the same reason: combat.name is GM-authored prose ("Ambush at the
// bridge") and combat.scene_id names a map. Listing every combat would hand a
// player the names and scene ids of encounters staged on maps they may not open.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const q = knex('combat').where({ campaign_id: req.campaign.id });
    if (!req.isOwner) {
      if (!req.campaign.active_scene_id) return res.json({ combats: [] });
      q.andWhere({ scene_id: req.campaign.active_scene_id });
    }
    const rows = await q.orderBy('created_at', 'desc');
    return res.json({ combats: rows.map(publicCombat) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/combat — GM starts an encounter on a scene.
//
// Seeds the roster from the board: every non-prop token already on that scene
// becomes a combatant, ordered by placement time, with NPC-linked tokens
// defaulting their hp_override from the actor's maximum.
router.post('/', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};

    // The scene is looked up THROUGH the campaign, so combat.scene_id can never
    // point at another campaign's map and the denormalized campaign_id can never
    // disagree with it.
    const scene = await loadSceneInCampaign(body.scene_id, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const name = validateCombatName(body.name);
    if (name.error) return res.status(400).json({ error: name.error });

    let combat;
    try {
      // At most one ACTIVE combat per scene, enforced atomically. Two parallel
      // starts would otherwise both count zero and both insert.
      const rows = await withAtomicCap({
        table: 'combat',
        where: { scene_id: scene.id, active: true },
        max: MAX_ACTIVE_COMBATS_PER_SCENE,
        capMessage: 'that scene already has a running combat',
        insert: {
          campaign_id: req.campaign.id,
          scene_id: scene.id,
          name: name.value,
          active: true,
        },
      });
      combat = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    // Seed from the board. Props are excluded, matching auto-add.
    const tokens = await knex('tokens')
      .where({ scene_id: scene.id, is_prop: false })
      .orderBy('created_at', 'asc');

    if (tokens.length) {
      const seeded = [];
      for (let i = 0; i < tokens.length && i < MAX_COMBATANTS_PER_COMBAT; i += 1) {
        seeded.push({
          combat_id: combat.id,
          token_id: tokens[i].id,
          sort_order: i,
          // eslint-disable-next-line no-await-in-loop
          hp_override: await defaultHpOverride(tokens[i]),
        });
      }
      // One insert. The combat row was created a moment ago and is not yet
      // reachable by any other request, so the roster cannot be raced here — the
      // cap that matters is on the ADD paths, which do go through withAtomicCap.
      if (seeded.length) await knex('combatants').insert(seeded);
    }

    await broadcastRoster(req, combat);

    const rows = await loadRoster({ combat, isOwner: true });
    return res.status(201).json({
      combat: publicCombat(combat),
      combatants: rows.map((r) => shapeCombatantFor(true, r)),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/combat/:combatId — load one combat and its roster.
router.get('/:combatId', requireMember, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    const isOwner = req.isOwner === true;
    const rows = await loadRoster({ combat: found.combat, isOwner });
    const actors = await loadRosterActors({
      rows, campaignId: req.campaign.id, isOwner,
    });

    return res.json({
      combat: publicCombat(found.combat),
      combatants: rows.map((r) => shapeCombatantFor(isOwner, r)),
      actors,
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/combat/:combatId — rename, or end the fight.
//
// Setting active:false is how an encounter ends. The row and its roster are kept
// so the GM can reopen it; DELETE is the destructive option.
router.patch('/:combatId', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const name = validateCombatName(body.name);
      if (name.error) return res.status(400).json({ error: name.error });
      updates.name = name.value;
    }
    if (body.active !== undefined) {
      const b = validateBool(body.active, 'active');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.active = b.value;
      // Ending a fight resets the turn pointer, so a later restart begins at
      // round 1, top of the order — not wherever the previous fight stopped.
      if (b.value === false) { updates.round = 1; updates.turn_index = 0; }
    }
    if (body.round !== undefined) {
      const r = validateInt(body.round, { min: 1, max: 9999, field: 'round' });
      if (r.error) return res.status(400).json({ error: r.error });
      updates.round = r.value;
    }
    if (body.turn_index !== undefined) {
      // turn_index indexes the roster ordered by sort_order. Bound it to the live
      // combatant count so a stale client index can never point past the end;
      // an empty roster pins it to 0. min 0 always; max is count-1 (or 0).
      const count = await knex('combatants')
        .where({ combat_id: found.combat.id }).count('* as n').first();
      const n = Number(count ? count.n : 0);
      const hi = n > 0 ? n - 1 : 0;
      const ti = validateInt(body.turn_index, { min: 0, max: hi, field: 'turn_index' });
      if (ti.error) return res.status(400).json({ error: ti.error });
      updates.turn_index = ti.value;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    // Reactivating has to respect the one-active-per-scene rule, or a GM could
    // flip two ended fights back on and have both running. Routed through the
    // same primitive rather than a bare count, per the standing constraint.
    if (updates.active === true && found.combat.active === false) {
      try {
        const rows = await withAtomicCap({
          table: 'combat',
          where: { scene_id: found.combat.scene_id, active: true },
          max: MAX_ACTIVE_COMBATS_PER_SCENE,
          capMessage: 'that scene already has a running combat',
          update: { where: { id: found.combat.id }, patch: updates },
        });
        await broadcastRoster(req, rows[0]);
        return res.json({ combat: publicCombat(rows[0]) });
      } catch (err) {
        if (err.capExceeded) return res.status(409).json({ error: err.message });
        throw err;
      }
    }

    const [row] = await knex('combat')
      .where({ id: found.combat.id }).update(updates).returning('*');
    await broadcastRoster(req, row);
    return res.json({ combat: publicCombat(row) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/combat/:combatId — GM destroys an encounter.
//
// Combatants cascade. Tokens are UNTOUCHED: deleting a fight must never clear
// the board, and combatants.token_id CASCADE runs the other way (token -> row).
router.delete('/:combatId', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    const n = Number((await knex('combatants')
      .where({ combat_id: found.combat.id }).count({ n: '*' }).first()).n);

    await knex('combat').where({ id: found.combat.id }).del();

    const sockets = req.app.get('campaignSockets');
    await sockets?.broadcastToOwner(req.campaign.id, 'combat:deleted', {
      id: found.combat.id, scene_id: found.combat.scene_id,
    });
    await sockets?.broadcastScenePlayers(
      req.campaign.id, found.combat.scene_id, 'combat:deleted',
      { id: found.combat.id, scene_id: found.combat.scene_id },
    );

    return res.json({ ok: true, id: found.combat.id, deleted: { combatants: n } });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// combatants
// ---------------------------------------------------------------------------

// POST /api/campaigns/:id/combat/:combatId/combatants — GM adds a token by hand.
//
// Auto-add covers the ordinary case (place a token during a fight and it joins).
// This exists for the token that was already a prop, or was removed from the
// roster earlier, or was placed before the fight started.
router.post('/:combatId/combatants', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    const body = req.body || {};
    if (!validUuid(body.token_id)) return res.status(404).json({ error: 'token not found' });

    // Scoped to the combat's OWN scene. Without this a GM could enrol a token
    // from another map — and, since the roster is filtered by tokens.hidden on
    // the combat's scene, a foreign token would be filtered by rules that were
    // never meant to apply to it.
    const token = await knex('tokens')
      .where({ id: body.token_id, scene_id: found.combat.scene_id })
      .first();
    if (!token) return res.status(404).json({ error: 'token not found' });

    const hp = validateHpOverride(body.hp_override);
    if (hp.error) return res.status(400).json({ error: hp.error });

    const maxRow = await knex('combatants')
      .where({ combat_id: found.combat.id })
      .max({ m: 'sort_order' })
      .first();
    const sortOrder = Number(maxRow && maxRow.m != null ? maxRow.m : -1) + 1;

    const hpOverride = hp.value === undefined
      ? await defaultHpOverride(token)
      : hp.value;

    let row;
    try {
      const rows = await withAtomicCap({
        table: 'combatants',
        where: { combat_id: found.combat.id },
        max: MAX_COMBATANTS_PER_COMBAT,
        capMessage: `a combat may hold at most ${MAX_COMBATANTS_PER_COMBAT} combatants`,
        insert: {
          combat_id: found.combat.id,
          token_id: token.id,
          sort_order: sortOrder,
          hp_override: hpOverride,
        },
        conflict: {
          columns: ['combat_id', 'token_id'],
          match: { combat_id: found.combat.id, token_id: token.id },
          merge: ['updated_at'],
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    await broadcastRoster(req, found.combat);
    return res.status(201).json({ combatant: shapeCombatantFor(true, row) });
  } catch (err) {
    return next(err);
  }
});

// PATCH .../combatants/:combatantId — GM edits per-instance HP, its visibility,
// or one row's position.
router.patch('/:combatId/combatants/:combatantId', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    if (!validUuid(req.params.combatantId)) {
      return res.status(404).json({ error: 'combatant not found' });
    }
    // Scoped through the combat, so a combatant id from another fight is a 404.
    const combatant = await knex('combatants')
      .where({ id: req.params.combatantId, combat_id: found.combat.id })
      .first();
    if (!combatant) return res.status(404).json({ error: 'combatant not found' });

    const body = req.body || {};
    const updates = {};

    if (body.hp_override !== undefined) {
      const hp = validateHpOverride(body.hp_override);
      if (hp.error) return res.status(400).json({ error: hp.error });
      updates.hp_override = hp.value;
    }
    if (body.hp_visible !== undefined) {
      const b = validateBool(body.hp_visible, 'hp_visible');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.hp_visible = b.value;
    }
    if (body.sort_order !== undefined) {
      const s = validateSortOrder(body.sort_order);
      if (s.error) return res.status(400).json({ error: s.error });
      updates.sort_order = s.value;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('combatants')
      .where({ id: combatant.id }).update(updates).returning('*');

    await broadcastRoster(req, found.combat);
    return res.json({ combatant: shapeCombatantFor(true, row) });
  } catch (err) {
    return next(err);
  }
});

// POST .../reorder — GM drags the roster into a new order.
//
// Takes the COMPLETE ordered id list and validates it as a PERMUTATION of the
// combat's current combatants: same length, same members, no duplicates, no
// foreign ids. A partial list is refused rather than applied, because a
// half-written order leaves gaps and duplicate positions that the next drag then
// compounds. One transaction, one broadcast.
//
// Note the permutation check is what makes this safe to write without a
// per-element authorisation check: every id must already be in this combat, so
// there is no id in the payload that the GM could not already reach.
router.post('/:combatId/reorder', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    // Reuses the existing batch id validator: array, non-empty, bounded, every
    // element a uuid, duplicates collapsed.
    const ids = validateTokenIdList(req.body && req.body.combatant_ids, 'combatant_ids');
    if (ids.error) return res.status(400).json({ error: ids.error });

    const current = await knex('combatants')
      .where({ combat_id: found.combat.id })
      .select('id');
    const currentIds = new Set(current.map((r) => r.id));

    // validateTokenIdList collapses duplicates, so a payload that repeated an id
    // arrives shorter than the roster and is caught by the length check here.
    if (ids.value.length !== currentIds.size) {
      return res.status(400).json({ error: 'combatant_ids must list every combatant exactly once' });
    }
    for (const id of ids.value) {
      if (!currentIds.has(id)) {
        return res.status(400).json({ error: 'combatant_ids must list every combatant exactly once' });
      }
    }

    await knex.transaction(async (trx) => {
      for (let i = 0; i < ids.value.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await trx('combatants')
          .where({ id: ids.value[i], combat_id: found.combat.id })
          .update({ sort_order: i, updated_at: trx.fn.now() });
      }
    });

    await broadcastRoster(req, found.combat);

    const rows = await loadRoster({ combat: found.combat, isOwner: true });
    return res.json({ combatants: rows.map((r) => shapeCombatantFor(true, r)) });
  } catch (err) {
    return next(err);
  }
});

// DELETE .../combatants/:combatantId — GM removes one row from the roster.
//
// THE ROW ONLY. The token stays on the board, untouched. This is the per-fight
// half of a deliberate pair, and the two are not redundant:
//
//   tokens.is_prop  — durable, per token, across every fight.
//                     "This is never a combatant."
//   this endpoint   — one-off, per fight.
//                     "The goblin fled; it is still a creature."
//
// Tagging the fleeing goblin a prop would be the wrong tool and would follow it
// into every future encounter.
//
// Because auto-add fires on PLACEMENT rather than continuously, a removed
// combatant stays removed: the GM prunes once and it holds.
router.delete('/:combatId/combatants/:combatantId', requireOwner, async (req, res, next) => {
  try {
    const found = await loadCombatForRequest(req);
    if (!found) return res.status(404).json({ error: 'combat not found' });

    if (!validUuid(req.params.combatantId)) {
      return res.status(404).json({ error: 'combatant not found' });
    }
    const combatant = await knex('combatants')
      .where({ id: req.params.combatantId, combat_id: found.combat.id })
      .first();
    if (!combatant) return res.status(404).json({ error: 'combatant not found' });

    await knex('combatants').where({ id: combatant.id }).del();
    await closeSortOrderGaps(found.combat.id);
    await broadcastRoster(req, found.combat);

    return res.json({ ok: true, id: combatant.id });
  } catch (err) {
    return next(err);
  }
});

// Renumber sort_order to 0..n-1 after a removal.
//
// Not cosmetic. sort_order is written directly by the reorder endpoint and by
// auto-add (which appends at max+1), so gaps left by removals accumulate and
// eventually push new arrivals past validateSortOrder's bound. Renumbering on
// every removal keeps the sequence dense and the bound unreachable.
async function closeSortOrderGaps(combatId) {
  const rows = await knex('combatants')
    .where({ combat_id: combatId })
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'sort_order');
  await knex.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].sort_order === i) continue;
      // eslint-disable-next-line no-await-in-loop
      await trx('combatants').where({ id: rows[i].id }).update({ sort_order: i });
    }
  });
}

// Called from routes/scenes.js after a token is deleted. A foreign key CANNOT
// NOTIFY ANYBODY: combatants.token_id is ON DELETE CASCADE, so the row is
// already gone by the time this runs, and without an explicit broadcast every
// open tracker would keep showing a combatant whose token no longer exists.
//
// This is the same lesson DELETE /:sceneId learned when it had to emit
// scene:activated {null} because the FK had silently cleared the pointer.
async function afterTokensDeleted(req, sceneId) {
  const combat = await knex('combat').where({ scene_id: sceneId, active: true }).first();
  if (!combat) return;
  await closeSortOrderGaps(combat.id);
  await broadcastRoster(req, combat);
}

// Called from routes/scenes.js when a token's is_prop flag flips.
// Tagging something a prop while it stands in the roster must remove it, or the
// flag is lying.
async function syncPropFlag(req, token) {
  const combat = await activeCombatForScene(token.scene_id);
  if (!combat) return;
  if (token.is_prop) {
    const n = await knex('combatants')
      .where({ combat_id: combat.id, token_id: token.id }).del();
    if (!n) return;
    await closeSortOrderGaps(combat.id);
  } else {
    const added = await autoAddCombatant(token);
    if (!added) return;
  }
  await broadcastRoster(req, combat);
}

module.exports = {
  router,
  publicCombat,
  shapeCombatantFor,
  loadRoster,
  activeCombatForScene,
  autoAddCombatant,
  afterTokensDeleted,
  syncPropFlag,
  broadcastRoster,
  defaultHpOverride,
  MAX_COMBATANTS_PER_COMBAT,
  MAX_ACTIVE_COMBATS_PER_SCENE,
};
