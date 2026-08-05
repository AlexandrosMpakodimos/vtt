// Actors (characters) + inventory (M4), mounted under /api/campaigns/:id/actors
// so that requireAuth / requireMember / requireOwner, req.campaign and
// req.isOwner apply exactly as they do to the campaign and scene routes.
//
// Inventory lives in this file rather than its own because inventory is
// ACTOR-SCOPED: an inventory row is only ever addressable through the actor that
// owns it, and that two-step scoping (campaign -> actor -> inventory row) is
// what blocks cross-campaign and cross-actor IDOR, exactly as
// campaign -> scene -> fog region does in scenes.js. The item CATALOGUE, which
// is campaign-scoped rather than actor-scoped, is routes/items.js.
//
// ---------------------------------------------------------------------------
// Two orthogonal rules, deliberately not collapsed into one column
// ---------------------------------------------------------------------------
//
//   AUTHORISATION is derived from actors.user_id  — who may WRITE this actor.
//   DISCLOSURE    is derived from actors.is_npc   — who may READ its statistics.
//
// They are not redundant. A GM-run player character is is_npc = false with
// user_id = NULL: nobody owns it, but its stats are party-visible. An abandoned
// character (its player deleted their account, so the FK SET NULL fired) lands
// in exactly that state and behaves correctly without special handling.
//
// The disclosure rule is the third confidentiality pattern in this project, and
// the existing two do not cover it:
//
//   tokens.hidden — the row NEVER leaves the server (filtered out per recipient)
//   fog_of_war    — the row is sent to everyone, deliberately (presentation only)
//   actors        — the row is sent to everyone, PROJECTED (shaped per recipient)
//
// A monster token is visible on the battle map — players can see the goblin —
// but its armour class and hit points must not be. So the row is neither
// withheld nor sent whole: players receive { id, campaign_id, user_id, name,
// img_url, is_npc, size } and nothing else. This has to hold on BOTH transports.
// M3's V2 was an authorisation boundary enforced correctly over HTTP that leaked
// entirely over the socket broadcast, so every actor broadcast below sends two
// different payloads rather than one payload to one room.
//
// ---------------------------------------------------------------------------
// The HP bar
// ---------------------------------------------------------------------------
// tokens.bar1_value / bar1_max have existed since M2 and no route has ever
// written them. From M4 they stay that way for LINKED tokens: an actor-linked
// token's bar is DERIVED from actors.hp_current / hp_max, so there is exactly
// one source of truth and healing a character fixes every token of them on every
// scene at once. bar1_* remains the manual bar for UNLINKED tokens (a door with
// 30 hit points, a barricade), which is the job it always looked like it was for.
//
// Whether a PLAYER sees a monster's HP bar is not a separate decision and needs
// no per-token toggle: HP is simply not in the projection, so an NPC token
// renders no bar for a player and a full bar for the GM. The confidentiality
// mechanism and the HP-display mechanism are the same mechanism.
//
// "This goblin has 7 hp for THIS FIGHT only, don't touch the actor" is
// combatants.hp_override, already designed in SCHEMA_REFERENCE and landing in
// M5. M4 deliberately does not grow a second answer to it.

const express = require('express');
const knex = require('../db');
const { validateImgFrame, validateImgScale, validateSpellSource } = require('../services/validators');
const { requireMember } = require('../middleware/campaignAuth');
const {
  validUuid, validateImageUrl, validateBool,
  validateActorInt, ACTOR_INT_FIELDS,
  validateShortText, validateLongText, validateActorSize,
  validateJsonBlob, validateQuantity, validateSortOrder,
} = require('../services/validators');
const { withAtomicCap } = require('../services/atomicCap');
const { shapeItemFor } = require('./items');
const { contentWriteLimiter } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });

// Same policy as scenes.js: reads are unlimited (an open sheet polls them),
// writes are rate-bounded. The caps below bound total state; this bounds rate.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// Caps. All CHOSEN, not measured — abuse prevention, not gameplay limits, and
// not memory protection (these are rows in Postgres). Every one is enforced
// atomically per the standing constraint.
const MAX_ACTORS_PER_CAMPAIGN = 200;
// A player may hold several characters at once. One would be wrong: characters
// DIE, and a cap of one would force either deleting the sheet (losing the
// record) or leaving the player stuck. Familiars, companions, hirelings and a
// replacement character mid-campaign are ordinary, not edge cases.
//
// There is deliberately no "active character" concept and no is_active column.
// It would be a rules concept enforced by the database — a new column outside
// SCHEMA_REFERENCE, an "exactly one active per (campaign, user)" invariant that
// the standing constraint would require to be atomic, a switch endpoint, a
// broadcast, and probes — and it dissolves on inspection: which sheet opens by
// default is client state, which actor a token represents is already per-token
// via tokens.actor_id, and whose turn it is is combat.turn_index in M5.
const MAX_PLAYER_ACTORS_PER_CAMPAIGN = 3;
const MAX_INVENTORY_ROWS_PER_ACTOR = 200;

// Spellbook rows per character. Chosen, not measured — a full 5e caster's known
// list is dozens; 300 is abuse prevention with room to spare.
const MAX_SPELLBOOK_ROWS_PER_ACTOR = 300;
// database-decisions.md names the 3-item attunement cap as application logic,
// not a DB constraint. It is the first cap in this project scoped to a single
// row's owner rather than to a campaign or a scene.
const MAX_ATTUNED_ITEMS = 3;
// A ceiling on the STACK, not just on one request. validateQuantity bounds the
// increment; without this the merge below could accumulate past it — two adds of
// 9999 stored 19998, so the validator's own bound was not a bound at all, and
// far enough down that road the int4 column overflows into an unhandled 22003.
const MAX_ITEM_STACK = 9999;

// ---------------------------------------------------------------------------
// Response shapes — explicit allow-lists, mirroring SAFE_COLUMNS discipline
// ---------------------------------------------------------------------------

function publicActor(a) {
  if (!a) return null;
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    user_id: a.user_id,
    folder_id: a.folder_id,
    name: a.name,
    img_url: a.img_url,
    // M6 framing. Postgres returns DECIMAL as a string; coerced so the client
    // can apply the transform without parsing. Alongside img_url in BOTH the
    // full row and the projection, because a player who receives the picture
    // must receive how it is framed or it renders differently for them than for
    // the GM.
    img_offset_x: a.img_offset_x === undefined ? undefined : Number(a.img_offset_x),
    img_offset_y: a.img_offset_y === undefined ? undefined : Number(a.img_offset_y),
    img_scale: a.img_scale === undefined ? undefined : Number(a.img_scale),
    is_npc: a.is_npc,
    level: a.level,
    class: a.class,
    race: a.race,
    size: a.size,
    hp_current: a.hp_current,
    hp_max: a.hp_max,
    hp_temp: a.hp_temp,
    armor_class: a.armor_class,
    speed: a.speed,
    strength: a.strength,
    dexterity: a.dexterity,
    constitution: a.constitution,
    intelligence: a.intelligence,
    wisdom: a.wisdom,
    charisma: a.charisma,
    death_save_successes: a.death_save_successes,
    death_save_failures: a.death_save_failures,
    notes: a.notes,
    data: a.data,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

// What a PLAYER receives for an NPC. Enough to render a token that is already
// visible to them on the canvas — a name, a portrait, a footprint — and nothing
// mechanical. No hp, no armour class, no ability scores, no notes, no data.
function projectedActor(a) {
  if (!a) return null;
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    user_id: a.user_id,
    name: a.name,
    img_url: a.img_url,
    // Framing travels WITH the picture. The projection already discloses
    // img_url — a monster's token has to render — so withholding how that
    // picture is framed would disclose nothing extra and would make the same
    // token look different on a player's screen than on the GM's. It describes
    // the image, not the creature.
    img_offset_x: a.img_offset_x === undefined ? undefined : Number(a.img_offset_x),
    img_offset_y: a.img_offset_y === undefined ? undefined : Number(a.img_offset_y),
    img_scale: a.img_scale === undefined ? undefined : Number(a.img_scale),
    is_npc: a.is_npc,
    size: a.size,
  };
}

// The single seam through which every actor payload passes, on both transports.
// One function, called from the list route, the detail route, the scene load in
// scenes.js, and every broadcast — so "what a player may see of an actor" has
// exactly one definition and cannot drift between HTTP and socket.
//
// Player characters are NOT projected: the party shares a table and members can
// read each other's sheets. That is a deliberate non-claim, recorded rather than
// left to be assumed — actor sheets are not private BETWEEN PLAYERS, only NPC
// statistics are private from players. (It is also the only thing the socket
// layer can express: broadcastToPlayers emits to the room minus the GM's
// sockets, so GM/not-GM is the only distinction available. A per-player
// visibility rule would need new socket machinery, not a new column.)
function shapeActorFor(isOwner, actor) {
  if (isOwner) return publicActor(actor);
  return actor && actor.is_npc ? projectedActor(actor) : publicActor(actor);
}

// An actor is only addressable through the campaign it belongs to. Scoping the
// lookup to the campaign is what stops a member of campaign A reading or
// mutating an actor in campaign B by guessing its id (cross-campaign IDOR) —
// the same two-step scoping loadSceneInCampaign and loadFogInScene apply.
async function loadActorInCampaign(actorId, campaignId) {
  if (!validUuid(actorId)) return null;
  return knex('actors').where({ id: actorId, campaign_id: campaignId }).first();
}

// May this user WRITE this actor? The GM may write any actor in their campaign;
// a player may write only an actor they control. Note this is derived from
// user_id and NOT from hit points: a character at 0 hp keeps their owner and
// keeps write access. Making authorisation depend on a gameplay number is how a
// dying player ends up locked out of editing their own notes.
function mayWriteActor({ isOwner, actor, userId }) {
  if (isOwner) return true;
  return !!actor && actor.user_id === userId;
}

// Fields the GM may write. `id`, `campaign_id`, `created_at` and `updated_at`
// appear nowhere and are never taken from a body.
const GM_WRITABLE = [
  'name', 'img_url', 'is_npc', 'user_id', 'level', 'class', 'race', 'size',
  'hp_current', 'hp_max', 'hp_temp', 'armor_class', 'speed',
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'death_save_successes', 'death_save_failures', 'notes', 'data',
  'img_offset_x', 'img_offset_y', 'img_scale',
];

// Fields a PLAYER may write on their own actor. A restricted list, not
// "everything except the privileged columns", and the reasoning is worth
// recording: the alternative was to let players write anything non-privileged
// and catch cheating afterwards with a change history. That history is audit
// logging, which is on this project's out-of-scope list, and it is the more
// expensive of the two answers — prevention is one array of column names,
// surveillance is a table, a retention sweep, an authorisation surface and its
// own probe suite. If a player should not be able to raise their own strength,
// the fix is to refuse the write, not to log it.
//
// So: the player owns their character's CONDITION and description. The GM owns
// its CAPABILITIES.
//
// KNOWN AND ACCEPTED: `data` is player-writable and currency lives in `data`
// (database-decisions.md keeps gold out of the columns), so a player can set
// their own gold. Removing `data` would also remove their ability to record
// spell slots and proficiencies, which is most of what the bucket is for. If
// gold must become GM-controlled it has to LEAVE `data` and become a real
// column — a schema deviation and a separate decision, flagged not folded in.
// `data` is size-bounded by validateJsonBlob regardless.
const PLAYER_WRITABLE = [
  'name', 'img_url', 'hp_current', 'hp_temp',
  'death_save_successes', 'death_save_failures', 'notes', 'data',
  // Framing follows img_url: a player who may set the portrait may frame it.
  'img_offset_x', 'img_offset_y', 'img_scale',
];

// Validate one allow-listed actor field. Returns { column, value } or { error }.
async function validateActorField(field, raw, campaignId) {
  if (Object.prototype.hasOwnProperty.call(ACTOR_INT_FIELDS, field)) {
    const r = validateActorInt(field, raw);
    return r.error ? r : { column: field, value: r.value };
  }
  switch (field) {
    case 'name': {
      if (typeof raw !== 'string' || !raw.trim()) return { error: 'name is required' };
      if (raw.trim().length > 100) return { error: 'name is too long (max 100 characters)' };
      return { column: 'name', value: raw.trim() };
    }
    case 'img_url': {
      const r = validateImageUrl(raw, 'img_url');
      return r.error ? r : { column: 'img_url', value: r.value };
    }
    // M6 image framing. On BOTH allow-lists, because whoever may set the
    // portrait may frame it — a player who can upload their own character's
    // picture and then cannot stop it cropping their head off has been given
    // half a feature. It also discloses nothing: framing describes the picture,
    // and the picture is already whatever the projection allows.
    case 'img_offset_x':
    case 'img_offset_y': {
      const r = validateImgFrame(raw, field);
      return r.error ? r : { column: field, value: r.value };
    }
    case 'img_scale': {
      const r = validateImgScale(raw);
      return r.error ? r : { column: 'img_scale', value: r.value };
    }
    case 'class':
    case 'race': {
      const r = validateShortText(raw, field, 50);
      return r.error ? r : { column: field, value: r.value };
    }
    case 'size': {
      const r = validateActorSize(raw);
      return r.error ? r : { column: 'size', value: r.value };
    }
    case 'notes': {
      const r = validateLongText(raw, 'notes', 5000);
      return r.error ? r : { column: 'notes', value: r.value };
    }
    case 'data': {
      const r = validateJsonBlob(raw, 'data');
      // node-pg infers a plain object into jsonb correctly, but stringifying is
      // what M3 learned to do explicitly for fog points; being explicit here
      // costs nothing and removes a class of driver-inference surprise.
      return r.error ? r : { column: 'data', value: JSON.stringify(r.value) };
    }
    case 'is_npc': {
      const r = validateBool(raw, 'is_npc');
      return r.error ? r : { column: 'is_npc', value: r.value };
    }
    case 'user_id': {
      // Assigning a character to a player. NULL detaches it (GM-controlled).
      if (raw === null || raw === '') return { column: 'user_id', value: null };
      if (!validUuid(raw)) return { error: 'user_id must be a valid id' };
      // The target must be an ACTIVE member of this campaign. Without this check
      // the GM could hand a character to an arbitrary user id — including a
      // banned member or a stranger — and that user would gain write access to a
      // row inside a campaign they cannot otherwise reach.
      const campaign = await knex('campaigns').where({ id: campaignId }).first();
      if (campaign && campaign.owner_id === raw) return { column: 'user_id', value: raw };
      const member = await knex('campaign_members')
        .where({ campaign_id: campaignId, user_id: raw }).first();
      if (!member || member.status !== 'active') {
        return { error: 'user_id must be an active member of this campaign' };
      }
      return { column: 'user_id', value: raw };
    }
    default:
      return { error: `${field} is not writable` };
  }
}

// Announce an actor change on BOTH tiers, as two different payloads.
//
// This is the socket half of the projection. Emitting one payload to the whole
// campaign room would be M3's V2 defect again in a new place: the boundary would
// hold on HTTP and leak completely on the socket, and clients would be filtering
// server data they should never have received. The GM's payload and the players'
// payload are built from the same row by the same shapeActorFor seam.
// May PLAYERS know this actor exists at all?
//
// V1 of the M4 audit (break-actors.js, L9/L10). This gate did not exist in the
// first build: every actor was listed to every member and every actor:updated
// was broadcast room-wide, on the reasoning that "a player can already see the
// goblin standing on the battle map, so hiding its existence would be a fiction
// the canvas immediately contradicts."
//
// That reasoning is sound for an NPC WITH A VISIBLE TOKEN and false for every
// other NPC. A monster the GM has prepped and not yet introduced has no token;
// a monster staged for an ambush has a HIDDEN one — which is the single case
// tokens.hidden exists for. The old rule announced "Assassin" to the whole table
// the moment the GM created it, and the hidden token that followed was then
// pointlessly secret. A player reading the socket, or simply polling
// GET /actors, learned every creature in the GM's prep notes by name.
//
// The rule now matches what the SCENE LOAD already did correctly: a player
// learns about an NPC exactly when a token of it reaches them. The scene load
// gets this for free by building its actors array from the already-filtered
// token list; the list, detail and broadcast paths need the test written out.
//
// Player characters are unaffected — the party shares a table and reads each
// other's sheets.
async function playersMayKnowActor(campaign, actor) {
  if (!actor) return false;
  if (!actor.is_npc) return true;
  if (!campaign.active_scene_id) return false;
  const seen = await knex('tokens')
    .where({ actor_id: actor.id, scene_id: campaign.active_scene_id, hidden: false })
    .first();
  return !!seen;
}

// The set form, so a list does not run one query per row.
async function npcIdsOnTheBoard(campaign) {
  if (!campaign.active_scene_id) return new Set();
  const rows = await knex('tokens')
    .where({ scene_id: campaign.active_scene_id, hidden: false })
    .whereNotNull('actor_id')
    .distinct('actor_id');
  return new Set(rows.map((r) => r.actor_id));
}

// Announce an actor change on BOTH tiers, as two different payloads.
//
// This is the socket half of the projection. Emitting one payload to the whole
// campaign room would be M3's V2 defect again in a new place: the boundary would
// hold on HTTP and leak completely on the socket, and clients would be filtering
// server data they should never have received. The GM's payload and the players'
// payload are built from the same row by the same shapeActorFor seam — and the
// players' half is sent only when playersMayKnowActor allows it (V1 above).
async function broadcastActor(req, actor) {
  const sockets = req.app.get('campaignSockets');
  if (!sockets) return;
  await sockets.broadcastToOwner(req.campaign.id, 'actor:updated', shapeActorFor(true, actor));
  if (!(await playersMayKnowActor(req.campaign, actor))) return;
  await sockets.broadcastToPlayers(req.campaign.id, 'actor:updated', shapeActorFor(false, actor));
}

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

// POST /api/campaigns/:id/actors — create a character.
//
// Any active member may create. A PLAYER's actor is forced to user_id = self and
// is_npc = false: those two fields are what authorisation and disclosure are
// derived from, so accepting them from a player's body would let them mint an
// NPC (hiding its stats from the rest of the table) or assign a character to
// somebody else. A GM may set both.
router.post('/', requireMember, async (req, res, next) => {
  try {
    const body = req.body || {};
    const isOwner = req.isOwner === true;

    const insertRow = { campaign_id: req.campaign.id };

    // name is the only required field; everything else has a column default.
    const name = await validateActorField('name', body.name, req.campaign.id);
    if (name.error) return res.status(400).json({ error: name.error });
    insertRow.name = name.value;

    const optional = isOwner
      ? GM_WRITABLE.filter((f) => f !== 'name')
      : PLAYER_WRITABLE.filter((f) => f !== 'name');

    // A player aiming at a GM-owned field is REFUSED here, exactly as it is on
    // PATCH. Until 2026-08-02 this path silently ignored them, which was the one
    // remaining inconsistency in the actor routes: the same request that earns a
    // 403 on PATCH earned a 201 on create, with the value quietly discarded.
    //
    // The two exclusions below are NOT an oversight. `user_id` and `is_npc` are
    // SERVER-SET for a player, not merely unwritable — they are forced to the
    // caller's own id and to false regardless of what arrives. Forcing is a
    // strictly stronger guarantee than refusing, and it lets a well-behaved
    // client echo a whole actor object back without being rejected for carrying
    // fields the server was going to overwrite anyway. The mass-assignment
    // probes that assert "create forces user_id to the caller" test exactly that
    // and must keep passing.
    //
    // Consequence worth stating: a player now creates a character SHELL — name,
    // portrait, current HP, notes — and the GM fills in its capabilities. That
    // is the permission model this milestone chose (the player owns their
    // character's condition, the GM owns what it can do), applied honestly at
    // the moment of creation rather than accepted and then discarded.
    if (!isOwner) {
      const SERVER_SET = ['user_id', 'is_npc'];
      const refused = Object.keys(body).filter(
        (k) => GM_WRITABLE.includes(k)
          && !PLAYER_WRITABLE.includes(k)
          && !SERVER_SET.includes(k),
      );
      if (refused.length) {
        return res.status(403).json({
          error: `only the GM may set: ${refused.join(', ')}`,
        });
      }
    }

    for (const field of optional) {
      if (body[field] === undefined) continue;
      const r = await validateActorField(field, body[field], req.campaign.id);
      if (r.error) return res.status(400).json({ error: r.error });
      insertRow[r.column] = r.value;
    }

    // Server-set, never from the body. A player's own id and a plain PC.
    if (!isOwner) {
      insertRow.user_id = req.user.id;
      insertRow.is_npc = false;
    }

    let rows;
    try {
      if (isOwner) {
        rows = await withAtomicCap({
          table: 'actors',
          where: { campaign_id: req.campaign.id },
          max: MAX_ACTORS_PER_CAMPAIGN,
          capMessage: `a campaign may hold at most ${MAX_ACTORS_PER_CAMPAIGN} actors`,
          insert: insertRow,
        });
      } else {
        // Two caps, both inside ONE transaction. Checking the campaign-wide cap
        // outside it would reintroduce exactly the race the per-player cap
        // closes: a player's create must satisfy both rules at the same instant.
        rows = await withAtomicCap({
          table: 'actors',
          where: { campaign_id: req.campaign.id, user_id: req.user.id },
          max: MAX_PLAYER_ACTORS_PER_CAMPAIGN,
          capMessage: `you may hold at most ${MAX_PLAYER_ACTORS_PER_CAMPAIGN} characters in a campaign`,
          insert: insertRow,
          extraCaps: [{
            where: { campaign_id: req.campaign.id },
            max: MAX_ACTORS_PER_CAMPAIGN,
            capMessage: `a campaign may hold at most ${MAX_ACTORS_PER_CAMPAIGN} actors`,
          }],
        });
      }
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    const actor = rows[0];
    await broadcastActor(req, actor);
    return res.status(201).json({ actor: shapeActorFor(true, actor) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/actors — list. Shaped per viewer: the GM sees every
// sheet in full; a player sees player characters in full, NPCs projected, and
// only those NPCs they are allowed to know exist at all.
//
// Two filters, load-bearing, answering different questions:
//   playersMayKnowActor — MAY I KNOW THIS EXISTS?  (drops the row entirely)
//   shapeActorFor       — WHAT MAY I SEE OF IT?    (drops its statistics)
//
// The first was missing from the first build and cost V1: the GM's unplaced and
// ambush NPCs were listed to the table by name.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const rows = await knex('actors')
      .where({ campaign_id: req.campaign.id })
      .orderBy('created_at', 'asc');

    if (req.isOwner === true) {
      return res.json({ actors: rows.map((a) => publicActor(a)) });
    }

    // One query for the whole list rather than one per row.
    const onTheBoard = await npcIdsOnTheBoard(req.campaign);
    const visible = rows.filter((a) => !a.is_npc || onTheBoard.has(a.id));
    return res.json({ actors: visible.map((a) => shapeActorFor(false, a)) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/actors/:actorId — one sheet, shaped per viewer.
//
// An NPC a player may not know about answers 404, not 403, for the same reason a
// non-active scene does: a 403 would confirm the creature exists and let a player
// enumerate the GM's prep by probing ids. To a player, an unintroduced monster is
// indistinguishable from one that was never created.
router.get('/:actorId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorInCampaign(req.params.actorId, req.campaign.id);
    if (!actor) return res.status(404).json({ error: 'actor not found' });
    if (req.isOwner === true) return res.json({ actor: publicActor(actor) });
    if (!(await playersMayKnowActor(req.campaign, actor))) {
      return res.status(404).json({ error: 'actor not found' });
    }
    return res.json({ actor: shapeActorFor(false, actor) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/actors/:actorId — edit a sheet.
// GM: any actor, any allow-listed field. Player: their own actor, and only the
// fields in PLAYER_WRITABLE.
router.patch('/:actorId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorInCampaign(req.params.actorId, req.campaign.id);
    if (!actor) return res.status(404).json({ error: 'actor not found' });

    const isOwner = req.isOwner === true;
    if (!mayWriteActor({ isOwner, actor, userId: req.user.id })) {
      // A member already knows the campaign exists and, for a PC, already sees
      // the sheet, so an honest 403 leaks nothing here — matching requireOwner's
      // treatment of a member who is not the owner.
      return res.status(403).json({ error: 'you do not control that character' });
    }

    const body = req.body || {};
    const allowed = isOwner ? GM_WRITABLE : PLAYER_WRITABLE;

    // A player aiming at a GM-only field is REFUSED, not silently ignored. This
    // differs from the placement routes, where a non-allow-listed field is
    // dropped, and the difference is deliberate: silently accepting a request to
    // set strength to 20 and returning 200 tells the player it worked. Refusing
    // is the honest answer, and it is the whole reason this list exists rather
    // than a change history.
    if (!isOwner) {
      const refused = Object.keys(body).filter(
        (k) => GM_WRITABLE.includes(k) && !PLAYER_WRITABLE.includes(k),
      );
      if (refused.length) {
        return res.status(403).json({
          error: `only the GM may change: ${refused.join(', ')}`,
        });
      }
    }

    const updates = {};
    for (const field of allowed) {
      if (body[field] === undefined) continue;
      const r = await validateActorField(field, body[field], req.campaign.id);
      if (r.error) return res.status(400).json({ error: r.error });
      updates[r.column] = r.value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('actors').where({ id: actor.id }).update(updates).returning('*');
    await broadcastActor(req, row);
    return res.json({ actor: shapeActorFor(isOwner, row) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/actors/:actorId
// GM deletes any character; a player deletes only their own.
router.delete('/:actorId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorInCampaign(req.params.actorId, req.campaign.id);
    if (!actor) return res.status(404).json({ error: 'actor not found' });

    const isOwner = req.isOwner === true;
    if (!mayWriteActor({ isOwner, actor, userId: req.user.id })) {
      return res.status(403).json({ error: 'you do not control that character' });
    }

    // Which tokens will be un-linked by the FK, and where. Counted BEFORE the
    // delete, for the same reason DELETE /:sceneId counts its tokens and fog
    // first: afterwards there is nothing left to count. The client needs this
    // because a foreign key cannot notify anyone — tokens.actor_id goes NULL
    // silently and every open canvas would otherwise keep rendering a character
    // that no longer exists.
    const affected = await knex('tokens')
      .where({ actor_id: actor.id })
      .select('id', 'scene_id', 'hidden');

    // M6: the spellbook cascades away with the character. Counted here with the
    // rest of the blast radius, because SCHEMA_REFERENCE flagged this cascade
    // when the spell tables were still unbuilt, and a route whose whole design
    // is to NAME what it destroys would otherwise have gained a silent third
    // casualty — the same gap DELETE /:sceneId had when combats landed.
    const spellbookRows = Number((await knex('actor_spells')
      .where({ actor_id: actor.id }).count({ n: '*' }).first()).n);

    await knex('actors').where({ id: actor.id }).del();

    const sockets = req.app.get('campaignSockets');
    if (sockets) {
      // actor:deleted carries a bare id. It goes room-wide for a player
      // character, but to the GM ALONE for an NPC — the same reasoning that made
      // scene:deleted GM-only in M3: a player has no business learning the id of
      // something they were never allowed to read. Players still converge,
      // because the token refresh below reaches them.
      if (actor.is_npc) {
        await sockets.broadcastToOwner(req.campaign.id, 'actor:deleted', { id: actor.id });
      } else {
        sockets.broadcastRoom(req.campaign.id, 'actor:deleted', { id: actor.id });
      }
      // Then tell every affected canvas that these tokens are now unlinked.
      // broadcastScene applies the active-scene gate, so a player hears nothing
      // about tokens on a map they cannot open; a hidden token stays GM-only.
      for (const t of affected) {
        const payload = { id: t.id, scene_id: t.scene_id, actor_id: null };
        if (t.hidden) await sockets.broadcastToOwner(req.campaign.id, 'token:unlinked', payload);
        else await sockets.broadcastScene(req.campaign.id, t.scene_id, 'token:unlinked', payload);
      }
    }

    // spellbook_entries is ADDITIVE: tokens_unlinked keeps its name and meaning,
    // so the existing probe reading it is untouched.
    return res.json({
      deleted: true,
      id: actor.id,
      tokens_unlinked: affected.length,
      spellbook_entries: spellbookRows,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// inventory  (actor-scoped: /api/campaigns/:id/actors/:actorId/inventory)
// ---------------------------------------------------------------------------
//
// Inventory changes broadcast a bare NOTIFICATION — { actor_id }, no payload —
// and clients re-fetch through the authorised read path above.
//
// That is a deliberate departure from "load heavy, update light", and it buys
// something specific: an inventory row joins to an ITEM, and an item may be
// unidentified, so a payload-carrying broadcast would need the item projection
// applied correctly on the socket path as well as the HTTP path. Sending no data
// at all means there is no second place for that projection to drift or leak —
// the read endpoint remains the only thing that ever shapes item data. Inventory
// is sheet-only state that changes rarely, so the extra round-trip costs
// nothing. Actor HP is the opposite case (canvas-visible, changes constantly),
// which is why actor:updated carries a full projected payload instead.
function notifyInventory(req, actorId) {
  const sockets = req.app.get('campaignSockets');
  if (!sockets) return;
  sockets.broadcastRoom(req.campaign.id, 'inventory:changed', { actor_id: actorId });
}

// Resolve the actor and check write authority in one place, since all four
// inventory routes need exactly the same two steps.
async function loadActorForInventory(req, res, { write }) {
  const isOwner = req.isOwner === true;
  const actor = await loadActorInCampaign(req.params.actorId, req.campaign.id);
  if (!actor) { res.status(404).json({ error: 'actor not found' }); return null; }

  // V2 of the M4 audit. This gate did not exist in the first build: the read
  // route checked only that the actor belonged to the campaign, so a player who
  // knew an NPC's id — which they legitimately do for any monster on the board,
  // from the scene load — could issue one GET and receive the creature's whole
  // bag. `shapeItemFor` still hid UNIDENTIFIED items, but that is the wrong
  // control to be relying on: the ordinary workflow marks mundane loot
  // identified at creation, so most of an encounter's loot list was readable
  // before the fight.
  //
  // V2 is V1's shape in a new place. V1 was a rule enforced on the scene load
  // and missing from list, detail and broadcast. This is a rule enforced on
  // list, detail and broadcast and missing from a sibling route that reaches the
  // same actors through a different door. One resource, several doors, the lock
  // fitted to some of them.
  //
  // The rule is deliberately stricter than playersMayKnowActor: a player may
  // read a PLAYER CHARACTER's bag (the party shares a table — already a recorded
  // non-claim) and never an NPC's, whether or not its token is on the board. A
  // visible goblin is not an invitation to read its pockets.
  if (!isOwner && actor.is_npc) {
    res.status(404).json({ error: 'actor not found' });
    return null;
  }

  // 403 here, not 404, and that is not the oracle V1 closed: by this line the
  // actor is a player character, which is already in this member's actor list,
  // so the refusal confirms nothing they cannot already read. NPCs — the GM's
  // prep, and the thing worth hiding — took the 404 above.
  if (write && !mayWriteActor({ isOwner, actor, userId: req.user.id })) {
    res.status(403).json({ error: 'you do not control that character' });
    return null;
  }
  return actor;
}

// GET .../inventory — the bag, with each item shaped for the viewer.
//
// A player reading their OWN bag still gets unidentified items projected: the
// character is carrying a mysterious sword, and carrying it is not the same as
// knowing what it is. That is the whole point of the identified flag, and it is
// why the projection is applied by viewer rather than by ownership.
router.get('/:actorId/inventory', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: false });
    if (!actor) return undefined;

    // Explicit column lists on the join — never select *, which would pull every
    // item column into scope and make the projection below a filter on data that
    // had already been assembled.
    const rows = await knex('inventory')
      .join('items', 'items.id', 'inventory.item_id')
      .where('inventory.actor_id', actor.id)
      .orderBy([{ column: 'inventory.sort_order', order: 'asc' },
        { column: 'inventory.created_at', order: 'asc' }])
      .select(
        'inventory.id as inv_id',
        'inventory.actor_id',
        'inventory.item_id',
        'inventory.quantity',
        'inventory.equipped',
        'inventory.attuned',
        'inventory.sort_order',
        'inventory.created_at',
        'inventory.updated_at',
        'items.id as i_id',
        'items.campaign_id as i_campaign_id',
        'items.folder_id as i_folder_id',
        'items.name as i_name',
        'items.img_url as i_img_url',
        'items.type as i_type',
        'items.weight as i_weight',
        'items.description as i_description',
        'items.properties as i_properties',
        'items.identified as i_identified',
        'items.created_at as i_created_at',
        'items.updated_at as i_updated_at',
      );

    const isOwner = req.isOwner === true;
    const inventory = rows.map((r) => ({
      id: r.inv_id,
      actor_id: r.actor_id,
      item_id: r.item_id,
      quantity: r.quantity,
      equipped: r.equipped,
      attuned: r.attuned,
      sort_order: r.sort_order,
      created_at: r.created_at,
      updated_at: r.updated_at,
      item: shapeItemFor(isOwner, {
        id: r.i_id,
        campaign_id: r.i_campaign_id,
        folder_id: r.i_folder_id,
        name: r.i_name,
        img_url: r.i_img_url,
        type: r.i_type,
        weight: r.i_weight,
        description: r.i_description,
        properties: r.i_properties,
        identified: r.i_identified,
        created_at: r.i_created_at,
        updated_at: r.i_updated_at,
      }),
    }));

    return res.json({ inventory });
  } catch (err) {
    return next(err);
  }
});

// POST .../inventory — put an item in the bag (or add to an existing stack).
//
// Atomic by construction. The UNIQUE (actor_id, item_id) constraint from the
// migration turns "does a row already exist? then increment, else insert" —
// which is read-then-write, and therefore forbidden by the standing constraint —
// into one INSERT ... ON CONFLICT DO UPDATE that the database resolves.
router.post('/:actorId/inventory', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;

    const body = req.body || {};
    if (!validUuid(body.item_id)) return res.status(400).json({ error: 'item_id is required' });

    // The item must belong to THIS campaign. Without this, a member of campaign
    // A could put an item from campaign B into their bag by id — a cross-campaign
    // BOLA that would also leak the foreign item's name and stats back through
    // the inventory read above.
    const item = await knex('items')
      .where({ id: body.item_id, campaign_id: req.campaign.id }).first();
    if (!item) return res.status(404).json({ error: 'item not found' });

    const qty = validateQuantity(body.quantity);
    if (qty.error) return res.status(400).json({ error: qty.error });
    const sort = validateSortOrder(body.sort_order);
    if (sort.error) return res.status(400).json({ error: sort.error });

    // The row cap and the upsert run in ONE serialisable transaction. The first
    // build checked the count outside any transaction and justified it with "the
    // overshoot is bounded by another cap anyway" — which made this the only cap
    // in the project that was not atomic, against a standing constraint written
    // without carve-outs. withAtomicCap's `conflict` branch counts the row as
    // adding 0 when there is an existing stack to merge into, so topping up a
    // full bag is still allowed.
    //
    // Hand-listed columns only; actor_id and item_id come from the resolved rows
    // above, never from the body. LEAST() bounds the RESULT of the merge, not
    // just the increment.
    let row;
    try {
      const rows = await withAtomicCap({
        table: 'inventory',
        where: { actor_id: actor.id },
        max: MAX_INVENTORY_ROWS_PER_ACTOR,
        capMessage: `a character may carry at most ${MAX_INVENTORY_ROWS_PER_ACTOR} distinct items`,
        insert: {
          actor_id: actor.id,
          item_id: item.id,
          quantity: qty.value,
          sort_order: sort.value,
        },
        conflict: {
          columns: ['actor_id', 'item_id'],
          match: { actor_id: actor.id, item_id: item.id },
          merge: {
            quantity: knex.raw('LEAST(inventory.quantity + ?, ?)', [qty.value, MAX_ITEM_STACK]),
            updated_at: knex.fn.now(),
          },
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    notifyInventory(req, actor.id);
    return res.status(201).json({
      inventory: {
        id: row.id,
        actor_id: row.actor_id,
        item_id: row.item_id,
        quantity: row.quantity,
        equipped: row.equipped,
        attuned: row.attuned,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      item: shapeItemFor(req.isOwner === true, item),
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH .../inventory/:invId — quantity / equipped / attuned / sort_order.
//
// Equipping does NOT modify the character's stats: items are "GM interprets" by
// explicit decision (database-decisions.md), so no armour class is recalculated
// and no bonus is applied here. The flag is a display state.
router.patch('/:actorId/inventory/:invId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;

    if (!validUuid(req.params.invId)) return res.status(404).json({ error: 'inventory row not found' });
    // Scoped to the actor: an inventory row is only addressable through the
    // character that carries it.
    const row = await knex('inventory')
      .where({ id: req.params.invId, actor_id: actor.id }).first();
    if (!row) return res.status(404).json({ error: 'inventory row not found' });

    const body = req.body || {};
    const updates = {};

    if (body.quantity !== undefined) {
      const q = validateQuantity(body.quantity);
      if (q.error) return res.status(400).json({ error: q.error });
      updates.quantity = q.value;
    }
    if (body.sort_order !== undefined) {
      const s = validateSortOrder(body.sort_order);
      if (s.error) return res.status(400).json({ error: s.error });
      updates.sort_order = s.value;
    }
    if (body.equipped !== undefined) {
      const b = validateBool(body.equipped, 'equipped');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.equipped = b.value;
    }

    let attuning = null;
    if (body.attuned !== undefined) {
      const b = validateBool(body.attuned, 'attuned');
      if (b.error) return res.status(400).json({ error: b.error });
      attuning = b.value;
    }

    // Attuning UP is a "no more than N of X" rule and goes through the atomic
    // cap. Attuning DOWN can never breach a cap, so it is a plain update and is
    // folded in with the rest below.
    if (attuning === false) updates.attuned = false;

    if (Object.keys(updates).length === 0 && attuning !== true) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    let updated = row;

    if (Object.keys(updates).length > 0) {
      updates.updated_at = knex.fn.now();
      const [r] = await knex('inventory').where({ id: row.id }).update(updates).returning('*');
      updated = r;
    }

    if (attuning === true) {
      try {
        const rows = await withAtomicCap({
          table: 'inventory',
          // The capped SET: this character's attuned items.
          where: { actor_id: actor.id, attuned: true },
          max: MAX_ATTUNED_ITEMS,
          capMessage: `a character may attune to at most ${MAX_ATTUNED_ITEMS} items`,
          update: {
            where: { id: row.id },
            patch: { attuned: true, updated_at: knex.fn.now() },
          },
        });
        updated = rows[0];
      } catch (err) {
        if (err.capExceeded) return res.status(409).json({ error: err.message });
        if (err.rowMissing) return res.status(404).json({ error: 'inventory row not found' });
        throw err;
      }
    }

    notifyInventory(req, actor.id);
    return res.json({
      inventory: {
        id: updated.id,
        actor_id: updated.actor_id,
        item_id: updated.item_id,
        quantity: updated.quantity,
        equipped: updated.equipped,
        attuned: updated.attuned,
        sort_order: updated.sort_order,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// DELETE .../inventory/:invId — drop an item from the bag.
router.delete('/:actorId/inventory/:invId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;

    if (!validUuid(req.params.invId)) return res.status(404).json({ error: 'inventory row not found' });
    const removed = await knex('inventory')
      .where({ id: req.params.invId, actor_id: actor.id }).del();
    if (!removed) return res.status(404).json({ error: 'inventory row not found' });

    notifyInventory(req, actor.id);
    return res.json({ deleted: true, id: req.params.invId });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// SPELLBOOK (M6)
// ---------------------------------------------------------------------------
//
// These live HERE, beside inventory, rather than in routes/spells.js, and that
// placement is the design rather than an accident of convenience.
//
// A spellbook row reaches `actors` through a new door, and the rule it must not
// bypass is the one M4's V2 was: a player may read a PLAYER CHARACTER's
// spellbook — the party shares a table, an already-recorded non-claim — and
// never an NPC's. Knowing which spells the lich has prepared is the Game
// Master's preparation in exactly the sense a monster's pockets are.
//
// `loadActorForInventory` is already that gate, written for bags. Reusing it
// unchanged is the whole point: the alternative is exporting it into another
// router or re-deriving the rule there, and re-deriving an authorisation rule is
// what produced M3's V2 and what Section "three copies of one rule" had to undo
// during M5. One definition, four callers.
//
// The function's name is now narrower than its job. Renaming it would touch
// audited code and its probes for a cosmetic gain, so it keeps the name and this
// comment records why.

// GET .../spells — a character's spellbook, with each spell attached.
router.get('/:actorId/spells', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: false });
    if (!actor) return undefined;

    // Explicit column lists on the join — never select *, which would pull every
    // column of both tables into scope and invite one into a payload.
    const rows = await knex('actor_spells as as_')
      .join('spells as s', 's.id', 'as_.spell_id')
      .where('as_.actor_id', actor.id)
      .orderBy([{ column: 's.level' }, { column: 's.name' }])
      .select(
        'as_.actor_id', 'as_.spell_id', 'as_.prepared', 'as_.source',
        'as_.created_at', 'as_.updated_at',
        's.name as s_name', 's.level as s_level', 's.description as s_description',
        's.properties as s_properties', 's.campaign_id as s_campaign_id',
        's.created_at as s_created_at', 's.updated_at as s_updated_at',
      );

    return res.json({
      spells: rows.map((r) => ({
        actor_id: r.actor_id,
        spell_id: r.spell_id,
        prepared: r.prepared,
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        // The catalogue row has no tier variant — there is no `identified`
        // equivalent for spells, deliberately. See the spells migration header.
        spell: {
          id: r.spell_id,
          campaign_id: r.s_campaign_id,
          name: r.s_name,
          level: r.s_level,
          description: r.s_description,
          properties: r.s_properties,
          created_at: r.s_created_at,
          updated_at: r.s_updated_at,
        },
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// POST .../spells — a character learns a spell.
//
// requireMember with a per-actor write check, exactly as inventory does: a
// player fills their own spellbook, the GM fills anybody's.
router.post('/:actorId/spells', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;

    const body = req.body || {};
    if (!validUuid(body.spell_id)) return res.status(400).json({ error: 'spell_id is required' });

    // Scoped to THIS campaign, so a spell id from another campaign is a 404
    // rather than a cross-campaign read.
    const spell = await knex('spells')
      .where({ id: body.spell_id, campaign_id: req.campaign.id }).first();
    if (!spell) return res.status(404).json({ error: 'spell not found' });

    const prep = body.prepared === undefined
      ? { value: false } : validateBool(body.prepared, 'prepared');
    if (prep.error) return res.status(400).json({ error: prep.error });
    const src = validateSpellSource(body.source);
    if (src.error) return res.status(400).json({ error: src.error });

    let row;
    try {
      const rows = await withAtomicCap({
        table: 'actor_spells',
        where: { actor_id: actor.id },
        max: MAX_SPELLBOOK_ROWS_PER_ACTOR,
        capMessage: `a character may know at most ${MAX_SPELLBOOK_ROWS_PER_ACTOR} spells`,
        insert: {
          actor_id: actor.id,
          spell_id: spell.id,
          prepared: prep.value,
          source: src.value === undefined ? null : src.value,
        },
        // The composite primary key makes learning a known spell a no-op rather
        // than a duplicate row or a 500. Counted as adding zero, which is
        // correct: nothing new enters the capped set.
        conflict: {
          columns: ['actor_id', 'spell_id'],
          match: { actor_id: actor.id, spell_id: spell.id },
          merge: ['updated_at'],
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    // Carries NO spell data, only ids. The M4 inventory decision, for the same
    // reason: clients re-fetch through the authorised path, so this event cannot
    // become a second disclosure channel that drifts from the first.
    req.app.get('campaignSockets')?.broadcastRoom(req.campaign.id, 'spellbook:changed', {
      actor_id: actor.id,
    });

    return res.status(201).json({ entry: shapeSpellbookRow(row) });
  } catch (err) {
    return next(err);
  }
});

// PATCH .../spells/:spellId — tick or untick "prepared", or correct the source.
//
// `prepared` is a CHECKBOX. The server does not count prepared spells, does not
// validate them against a limit, and does not care that race spells are exempt
// from that limit in the source game. Counting would be the 5e rules engine this
// project excludes; the flag is stored and the Game Master interprets it.
router.patch('/:actorId/spells/:spellId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;
    if (!validUuid(req.params.spellId)) return res.status(404).json({ error: 'spell not found' });

    const existing = await knex('actor_spells')
      .where({ actor_id: actor.id, spell_id: req.params.spellId }).first();
    if (!existing) return res.status(404).json({ error: 'spell not found' });

    const body = req.body || {};
    const updates = {};
    if (body.prepared !== undefined) {
      const b = validateBool(body.prepared, 'prepared');
      if (b.error) return res.status(400).json({ error: b.error });
      updates.prepared = b.value;
    }
    if (body.source !== undefined) {
      const src = validateSpellSource(body.source);
      if (src.error) return res.status(400).json({ error: src.error });
      updates.source = src.value;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('actor_spells')
      .where({ actor_id: actor.id, spell_id: req.params.spellId })
      .update(updates)
      .returning('*');

    req.app.get('campaignSockets')?.broadcastRoom(req.campaign.id, 'spellbook:changed', {
      actor_id: actor.id,
    });

    return res.json({ entry: shapeSpellbookRow(row) });
  } catch (err) {
    return next(err);
  }
});

// DELETE .../spells/:spellId — a character forgets a spell.
router.delete('/:actorId/spells/:spellId', requireMember, async (req, res, next) => {
  try {
    const actor = await loadActorForInventory(req, res, { write: true });
    if (!actor) return undefined;
    if (!validUuid(req.params.spellId)) return res.status(404).json({ error: 'spell not found' });

    const n = await knex('actor_spells')
      .where({ actor_id: actor.id, spell_id: req.params.spellId }).del();
    if (!n) return res.status(404).json({ error: 'spell not found' });

    req.app.get('campaignSockets')?.broadcastRoom(req.campaign.id, 'spellbook:changed', {
      actor_id: actor.id,
    });

    return res.json({ ok: true, spell_id: req.params.spellId });
  } catch (err) {
    return next(err);
  }
});

function shapeSpellbookRow(r) {
  if (!r) return null;
  return {
    actor_id: r.actor_id,
    spell_id: r.spell_id,
    prepared: r.prepared,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

module.exports = {
  router,
  publicActor,
  playersMayKnowActor,
  npcIdsOnTheBoard,
  projectedActor,
  shapeActorFor,
  loadActorInCampaign,
  mayWriteActor,
  GM_WRITABLE,
  PLAYER_WRITABLE,
  MAX_ACTORS_PER_CAMPAIGN,
  MAX_SPELLBOOK_ROWS_PER_ACTOR,
  MAX_PLAYER_ACTORS_PER_CAMPAIGN,
  MAX_INVENTORY_ROWS_PER_ACTOR,
  MAX_ATTUNED_ITEMS,
};
