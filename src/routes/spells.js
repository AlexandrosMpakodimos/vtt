// Spells catalogue (M6), mounted under /api/campaigns/:id/spells so that
// requireAuth / requireMember / requireOwner, req.campaign and req.isOwner apply
// exactly as they do to every other resource.
//
// This is routes/items.js with a different noun, and the resemblance is the
// point: a campaign-scoped catalogue the GM authors, addressed only through its
// campaign, capped atomically, broadcast on both tiers.
//
// ---------------------------------------------------------------------------
// THE DOORS QUESTION, asked before design as M5 established
// ---------------------------------------------------------------------------
// Spells reach `actors` through a join, which is a new door onto a table with
// existing disclosure rules. So: which rules does an actor_spells row bypass?
//
// The answer is ONE, and it is already solved. A player must not read an NPC's
// spellbook — knowing the lich has prepared Counterspell is exactly the
// preparation M4's V2 was about — and `loadActorForInventory` is precisely that
// gate, written for bags and reused here unchanged. The spellbook routes live in
// routes/actors.js beside inventory for that reason: sharing the gate is the
// whole design, and moving them here would mean either exporting it or
// re-deriving it, and re-deriving an authorisation rule is what produced M3's
// V2.
//
// The CATALOGUE itself has no confidentiality rule at all, and that is a
// decision rather than an omission — see the migration header. There is no
// `identified` equivalent: a player needs to read what a spell does in order to
// cast it, and hiding the catalogue would answer a question the spellbook gate
// already answers, with a second mechanism that could drift from the first.

const express = require('express');
const knex = require('../db');
const { requireMember, requireOwner } = require('../middleware/campaignAuth');
const { withAtomicCap } = require('../services/atomicCap');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const {
  validateSpellName, validateSpellLevel, validateLongText, validateJsonBlob,
  validateInt, validUuid,
} = require('../services/validators');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// Chosen, not measured — abuse prevention, enforced atomically per the standing
// constraint. Matched to MAX_ITEMS_PER_CAMPAIGN because a catalogue is a
// catalogue; a campaign's spell list is dozens, not hundreds.
const MAX_SPELLS_PER_CAMPAIGN = 500;

// Every payload passes through here. No tier variant, because there is none —
// see the header.
function publicSpell(s) {
  if (!s) return null;
  return {
    id: s.id,
    campaign_id: s.campaign_id,
    name: s.name,
    level: s.level,
    description: s.description,
    properties: s.properties,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// A spell is only addressable through its campaign — the two-step scoping that
// blocks cross-campaign IDOR everywhere else in this project.
async function loadSpellInCampaign(spellId, campaignId) {
  if (!validUuid(spellId)) return null;
  return knex('spells').where({ id: spellId, campaign_id: campaignId }).first();
}

// One payload, one room. Unlike items there is no tier split to make, so this
// deliberately does NOT use the two-broadcast pattern — writing one where none
// is needed would suggest a confidentiality rule exists here when it does not.
async function broadcastSpell(req, spell, event = 'spell:updated') {
  const sockets = req.app.get('campaignSockets');
  if (!sockets) return;
  sockets.broadcastRoom(req.campaign.id, event, publicSpell(spell));
}

// Validate the writable fields. Shared by create and update so the two cannot
// diverge — the create/PATCH asymmetry M4 had to resolve after the fact.
function validateSpellBody(body, { partial }) {
  const updates = {};

  if (!partial || body.name !== undefined) {
    const n = validateSpellName(body.name);
    if (n.error) return { error: n.error };
    updates.name = n.value;
  }
  if (body.level !== undefined) {
    const l = validateSpellLevel(body.level);
    if (l.error) return { error: l.error };
    updates.level = l.value;
  }
  if (body.description !== undefined) {
    const d = validateLongText(body.description, 'description', 5000);
    if (d.error) return { error: d.error };
    updates.description = d.value;
  }
  if (body.properties !== undefined) {
    const p = validateJsonBlob(body.properties, 'properties');
    if (p.error) return { error: p.error };
    // Stringified explicitly, as M3 learned to do for fog points — node-pg
    // infers correctly, but being explicit removes a class of driver surprise.
    updates.properties = JSON.stringify(p.value);
  }
  return { updates };
}

// POST /api/campaigns/:id/spells — the GM authors a spell.
//
// GM-only, for the same reason players do not author items: a player who could
// mint a spell could give themselves Wish. Learning a spell is a spellbook
// operation against a spell the GM has already created.
router.post('/', requireOwner, async (req, res, next) => {
  try {
    const v = validateSpellBody(req.body || {}, { partial: false });
    if (v.error) return res.status(400).json({ error: v.error });

    let rows;
    try {
      rows = await withAtomicCap({
        table: 'spells',
        where: { campaign_id: req.campaign.id },
        max: MAX_SPELLS_PER_CAMPAIGN,
        capMessage: `a campaign may hold at most ${MAX_SPELLS_PER_CAMPAIGN} spells`,
        // Explicit column list — never the raw body.
        insert: { campaign_id: req.campaign.id, ...v.updates },
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    await broadcastSpell(req, rows[0], 'spell:created');
    return res.status(201).json({ spell: publicSpell(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/spells — the catalogue, readable by every member.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const q = knex('spells').where({ campaign_id: req.campaign.id });

    // Optional level filter. A convenience for the spellbook UI, and the only
    // query the level index exists for.
    if (req.query.level !== undefined) {
      const l = validateInt(req.query.level, { min: 0, max: 9, field: 'level' });
      if (l.error) return res.status(400).json({ error: l.error });
      q.andWhere({ level: l.value });
    }

    const rows = await q.orderBy([{ column: 'level' }, { column: 'name' }]);
    return res.json({ spells: rows.map(publicSpell) });
  } catch (err) {
    return next(err);
  }
});

router.get('/:spellId', requireMember, async (req, res, next) => {
  try {
    const spell = await loadSpellInCampaign(req.params.spellId, req.campaign.id);
    if (!spell) return res.status(404).json({ error: 'spell not found' });
    return res.json({ spell: publicSpell(spell) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:spellId', requireOwner, async (req, res, next) => {
  try {
    const spell = await loadSpellInCampaign(req.params.spellId, req.campaign.id);
    if (!spell) return res.status(404).json({ error: 'spell not found' });

    const v = validateSpellBody(req.body || {}, { partial: true });
    if (v.error) return res.status(400).json({ error: v.error });
    if (!Object.keys(v.updates).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    v.updates.updated_at = knex.fn.now();

    const [row] = await knex('spells')
      .where({ id: spell.id, campaign_id: req.campaign.id })
      .update(v.updates)
      .returning('*');

    await broadcastSpell(req, row);
    return res.json({ spell: publicSpell(row) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/spells/:spellId
//
// Removes it from every spellbook by cascade. The response NAMES that blast
// radius, as DELETE /items and DELETE /:sceneId do: a confirmation that says
// what will be destroyed is the difference between an informed click and a bare
// "are you sure?".
router.delete('/:spellId', requireOwner, async (req, res, next) => {
  try {
    const spell = await loadSpellInCampaign(req.params.spellId, req.campaign.id);
    if (!spell) return res.status(404).json({ error: 'spell not found' });

    const known = Number((await knex('actor_spells')
      .where({ spell_id: spell.id }).count({ n: '*' }).first()).n);

    await knex('spells').where({ id: spell.id, campaign_id: req.campaign.id }).del();

    const sockets = req.app.get('campaignSockets');
    sockets?.broadcastRoom(req.campaign.id, 'spell:deleted', { id: spell.id });

    return res.json({ ok: true, id: spell.id, deleted: { spellbook_entries: known } });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicSpell,
  loadSpellInCampaign,
  MAX_SPELLS_PER_CAMPAIGN,
};
