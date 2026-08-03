// Items (M4) — the campaign's item CATALOGUE, mounted under
// /api/campaigns/:id/items. What a given character is CARRYING is inventory,
// which is actor-scoped and lives in routes/actors.js.
//
// Items are a flat, campaign-scoped list: no bag nesting, no parent_item_id
// (database-decisions.md). Mechanical properties live in the `properties` JSONB
// and are never interpreted by the server — equipping a breastplate does not
// change anybody's armour class, because "items don't auto-modify stats when
// equipped" is an explicit recorded decision, not an omission.
//
// ---------------------------------------------------------------------------
// identified — the second confidentiality projection in this milestone
// ---------------------------------------------------------------------------
// The GM may hold an item's statistics back until the party identifies it in
// fiction. This is NOT automated: nothing here resolves an identify spell, no
// check is rolled, no condition is tracked. It is a boolean the GM flips, and
// the server's only job is to make sure that while it is false the item's
// details do not leave the server for a player.
//
// Two consequences worth stating plainly, because they are what makes this a
// real boundary rather than a UI convention:
//
//   1. The NAME is the spoiler. An unidentified item called "Flame Tongue"
//      leaks through its own name, so the projection drops `name` as well as
//      `description` and `properties`. A player receives { id, campaign_id,
//      type, img_url, identified:false } and the client renders a derived label
//      ("Unidentified weapon") from `type`, which is already one of four
//      categories and gives nothing away that holding the object would not.
//
//      A dedicated `unidentified_name` column ("a plain steel longsword") would
//      read better and is a clean additive change later. It was left out of M4
//      to avoid a sixth schema deviation for flavour text.
//
//   2. `img_url` is NOT withheld, deliberately. The GM chooses the picture; if
//      they attach a flaming-sword illustration to an unidentified sword, that
//      is their disclosure to make. Recorded here so the thesis does not
//      overclaim the mechanism — the same treatment the fog chapter gives to
//      "fog is a presentation control, not a confidentiality boundary".
//
// Unlike fog, this IS a confidentiality boundary: an unidentified item's stats
// genuinely never leave the server for a player, on either transport.

const express = require('express');
const knex = require('../db');
const { requireMember, requireOwner } = require('../middleware/campaignAuth');
const {
  validUuid, validateImageUrl, validateBool,
  validateShortText, validateLongText, validateJsonBlob,
  validateItemType, validateItemWeight,
} = require('../services/validators');
const { withAtomicCap } = require('../services/atomicCap');
const { contentWriteLimiter } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// Chosen, not measured — abuse prevention, enforced atomically per the standing
// constraint. A long campaign's item list is dozens, not hundreds.
const MAX_ITEMS_PER_CAMPAIGN = 500;

function publicItem(i) {
  if (!i) return null;
  return {
    id: i.id,
    campaign_id: i.campaign_id,
    folder_id: i.folder_id,
    name: i.name,
    img_url: i.img_url,
    type: i.type,
    // Postgres DECIMAL arrives as a string over the wire; coerce so clients get
    // a number to render, exactly as publicToken does for token coordinates.
    weight: i.weight === null || i.weight === undefined ? 0 : Number(i.weight),
    description: i.description,
    properties: i.properties,
    identified: i.identified,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

// What a PLAYER receives for an unidentified item. No name, no weight, no
// description, no properties.
function unidentifiedItem(i) {
  if (!i) return null;
  return {
    id: i.id,
    campaign_id: i.campaign_id,
    type: i.type,
    img_url: i.img_url,
    identified: false,
  };
}

// The single seam every item payload passes through, on both transports and in
// both routers (routes/actors.js imports this for the inventory join). One
// definition of "what a player may see of an item" means HTTP and socket cannot
// disagree — which is the specific failure M3's V2 was.
function shapeItemFor(isOwner, item) {
  if (isOwner) return publicItem(item);
  return item && item.identified ? publicItem(item) : unidentifiedItem(item);
}

// An item is only addressable through its campaign (cross-campaign IDOR block),
// the same two-step scoping used for scenes, fog and actors.
async function loadItemInCampaign(itemId, campaignId) {
  if (!validUuid(itemId)) return null;
  return knex('items').where({ id: itemId, campaign_id: campaignId }).first();
}

// Announce an item change on both tiers as two different payloads. The
// identified toggle is the payoff moment of the feature — the instant the party
// identifies the sword, every open sheet should show its stats — so unlike
// inventory this event carries data rather than a re-fetch notification. That
// makes the projection load-bearing on the socket path, which is why it goes
// through the same shapeItemFor seam as the HTTP responses.
async function broadcastItem(req, item, event = 'item:updated') {
  const sockets = req.app.get('campaignSockets');
  if (!sockets) return;
  await sockets.broadcastToOwner(req.campaign.id, event, shapeItemFor(true, item));
  await sockets.broadcastToPlayers(req.campaign.id, event, shapeItemFor(false, item));
}

// POST /api/campaigns/:id/items — the GM authors an item.
//
// GM-only: players do not write the catalogue. A player acquiring an item is an
// inventory operation (POST .../actors/:actorId/inventory), which references an
// item the GM has already created. Letting players author items would let anyone
// mint a +5 sword and put it in their own bag.
router.post('/', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};

    const name = validateShortText(body.name, 'name', 100);
    if (name.error) return res.status(400).json({ error: name.error });
    if (!name.value) return res.status(400).json({ error: 'name is required' });

    const type = validateItemType(body.type);
    if (type.error) return res.status(400).json({ error: type.error });

    const img = validateImageUrl(body.img_url, 'img_url');
    if (img.error) return res.status(400).json({ error: img.error });

    const weight = validateItemWeight(body.weight);
    if (weight.error) return res.status(400).json({ error: weight.error });

    const description = validateLongText(body.description, 'description', 5000);
    if (description.error) return res.status(400).json({ error: description.error });

    const properties = validateJsonBlob(body.properties, 'properties');
    if (properties.error) return res.status(400).json({ error: properties.error });

    // Defaults to false — SECRET — when the GM says nothing. That satisfies both
    // the schema's "booleans default false" convention and secure-by-default:
    // forgetting the flag yields the non-disclosing outcome. An ordinary mundane
    // item is marked identified in the same request that creates it.
    let identified = false;
    if (body.identified !== undefined) {
      const b = validateBool(body.identified, 'identified');
      if (b.error) return res.status(400).json({ error: b.error });
      identified = b.value;
    }

    // Hand-listed columns only; campaign_id comes from the resolved campaign.
    let rows;
    try {
      rows = await withAtomicCap({
        table: 'items',
        where: { campaign_id: req.campaign.id },
        max: MAX_ITEMS_PER_CAMPAIGN,
        capMessage: `a campaign may hold at most ${MAX_ITEMS_PER_CAMPAIGN} items`,
        insert: {
          campaign_id: req.campaign.id,
          name: name.value,
          img_url: img.value,
          type: type.value,
          weight: weight.value,
          description: description.value,
          properties: JSON.stringify(properties.value),
          identified,
        },
      });
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    const item = rows[0];
    await broadcastItem(req, item, 'item:created');
    return res.status(201).json({ item: publicItem(item) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/items — the catalogue, shaped per viewer.
//
// Unidentified items are still LISTED to players, projected, rather than
// filtered out. Filtering them would be the stronger boundary, but it would also
// be incoherent with inventory: a player carrying a mysterious sword must be able
// to see that they are carrying SOMETHING. Existence is disclosed; statistics
// are not. Recorded explicitly so the thesis claims exactly this and no more.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const rows = await knex('items')
      .where({ campaign_id: req.campaign.id })
      .orderBy('created_at', 'asc');
    return res.json({ items: rows.map((i) => shapeItemFor(req.isOwner === true, i)) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/items/:itemId — one item, shaped per viewer.
router.get('/:itemId', requireMember, async (req, res, next) => {
  try {
    const item = await loadItemInCampaign(req.params.itemId, req.campaign.id);
    if (!item) return res.status(404).json({ error: 'item not found' });
    return res.json({ item: shapeItemFor(req.isOwner === true, item) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/items/:itemId — GM edits, including the identified
// toggle. This is the endpoint that reveals an item to the table.
router.patch('/:itemId', requireOwner, async (req, res, next) => {
  try {
    const item = await loadItemInCampaign(req.params.itemId, req.campaign.id);
    if (!item) return res.status(404).json({ error: 'item not found' });

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const r = validateShortText(body.name, 'name', 100);
      if (r.error) return res.status(400).json({ error: r.error });
      if (!r.value) return res.status(400).json({ error: 'name is required' });
      updates.name = r.value;
    }
    if (body.type !== undefined) {
      const r = validateItemType(body.type);
      if (r.error) return res.status(400).json({ error: r.error });
      updates.type = r.value;
    }
    if (body.img_url !== undefined) {
      const r = validateImageUrl(body.img_url, 'img_url');
      if (r.error) return res.status(400).json({ error: r.error });
      updates.img_url = r.value;
    }
    if (body.weight !== undefined) {
      const r = validateItemWeight(body.weight);
      if (r.error) return res.status(400).json({ error: r.error });
      updates.weight = r.value;
    }
    if (body.description !== undefined) {
      const r = validateLongText(body.description, 'description', 5000);
      if (r.error) return res.status(400).json({ error: r.error });
      updates.description = r.value;
    }
    if (body.properties !== undefined) {
      const r = validateJsonBlob(body.properties, 'properties');
      if (r.error) return res.status(400).json({ error: r.error });
      updates.properties = JSON.stringify(r.value);
    }
    if (body.identified !== undefined) {
      const r = validateBool(body.identified, 'identified');
      if (r.error) return res.status(400).json({ error: r.error });
      updates.identified = r.value;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    updates.updated_at = knex.fn.now();

    const [row] = await knex('items').where({ id: item.id }).update(updates).returning('*');
    await broadcastItem(req, row);
    return res.json({ item: publicItem(row) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id/items/:itemId — GM removes an item from the
// catalogue. The FK is ON DELETE CASCADE, so it also leaves every bag that held
// it. The count of affected inventory rows is taken BEFORE the delete (the same
// blast-radius discipline DELETE /:sceneId uses) and returned, so a client's
// confirmation can name what is destroyed rather than saying "are you sure?".
router.delete('/:itemId', requireOwner, async (req, res, next) => {
  try {
    const item = await loadItemInCampaign(req.params.itemId, req.campaign.id);
    if (!item) return res.status(404).json({ error: 'item not found' });

    const held = await knex('inventory').where({ item_id: item.id }).count({ n: '*' }).first();
    const inventoryRows = Number(held.n);

    await knex('items').where({ id: item.id }).del();

    const sockets = req.app.get('campaignSockets');
    // A bare id, and it is safe on both tiers: an unidentified item's id is
    // already known to any player carrying it, and an id alone carries no
    // statistics. Clients drop it from every open catalogue and bag.
    if (sockets) sockets.broadcastRoom(req.campaign.id, 'item:deleted', { id: item.id });

    return res.json({ deleted: true, id: item.id, inventory_rows_removed: inventoryRows });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicItem,
  unidentifiedItem,
  shapeItemFor,
  loadItemInCampaign,
  MAX_ITEMS_PER_CAMPAIGN,
};
