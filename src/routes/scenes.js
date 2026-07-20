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
} = require('../services/validators');

// mergeParams: this router is mounted at .../:id/scenes, and :id (the campaign)
// lives on the parent router's params.
const router = express.Router({ mergeParams: true });

// A player may place at most this many tokens per scene this pass. The GM is
// exempt. This is a "no more than N of X" rule, so per the standing constraint
// from the M2 audit it is enforced ATOMICALLY (serialisable transaction), never
// read-then-write.
const MAX_PLAYER_TOKENS_PER_SCENE = 1;

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
    bar1_value: t.bar1_value,
    bar1_max: t.bar1_max,
    conditions: t.conditions,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// Load a live scene that belongs to a given campaign. Scoping the lookup to the
// campaign is what stops a member of campaign A from reading/mutating a scene in
// campaign B by guessing its id (cross-campaign IDOR).
async function loadSceneInCampaign(sceneId, campaignId) {
  if (!validUuid(sceneId)) return null;
  return knex('scenes').where({ id: sceneId, campaign_id: campaignId }).first();
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
    const [row] = await knex('scenes')
      .insert({
        campaign_id: req.campaign.id,
        name: n.value,
        img_url: img.value,
        width: w.value,
        height: h.value,
      })
      .returning('*');

    return res.status(201).json({ scene: publicScene(row) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/scenes — any active member lists the campaign's scenes.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const rows = await knex('scenes')
      .where({ campaign_id: req.campaign.id })
      .orderBy('created_at', 'asc');
    return res.json({ scenes: rows.map(publicScene) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/scenes/:sceneId — a full scene load: the scene plus all
// its tokens. This is the "load heavy" half; live moves after this arrive as
// socket deltas.
router.get('/:sceneId', requireMember, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const tokens = await knex('tokens')
      .where({ scene_id: scene.id })
      .orderBy('created_at', 'asc');

    return res.json({ scene: publicScene(scene), tokens: tokens.map(publicToken) });
  } catch (err) {
    return next(err);
  }
});

// ---- tokens ----

// POST /api/campaigns/:id/scenes/:sceneId/tokens — place a token.
// GM: unlimited. Player: at most MAX_PLAYER_TOKENS_PER_SCENE, enforced
// atomically. actor_id stays NULL this pass (standalone token: name + image).
router.post('/:sceneId/tokens', requireMember, async (req, res, next) => {
  try {
    const scene = await loadSceneInCampaign(req.params.sceneId, req.campaign.id);
    if (!scene) return res.status(404).json({ error: 'scene not found' });

    const body = req.body || {};
    const isOwner = req.campaign.owner_id === req.user.id;

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

    const insertRow = {
      scene_id: scene.id,
      actor_id: null,
      created_by: req.user.id,
      name: name.value,
      img_url: img.value,
      x: x.value,
      y: y.value,
      width: width.value,
      height: height.value,
    };

    let token;
    if (isOwner) {
      // GM: no cap, a plain insert.
      const [row] = await knex('tokens').insert(insertRow).returning('*');
      token = row;
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

    // Broadcast the placement to everyone in the campaign room (including the
    // placer) so every open canvas gets the authoritative row. The socket layer
    // owns the room; we reach it through the same handle the kick/ban routes use.
    req.app.get('campaignSockets')?.broadcastToken(req.campaign.id, 'token:created', shaped);

    return res.status(201).json({ token: shaped });
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

    req.app.get('campaignSockets')?.broadcastToken(req.campaign.id, 'token:deleted', {
      id: token.id, scene_id: scene.id,
    });

    return res.json({ ok: true, id: token.id });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicToken,
  publicScene,
  tokenMovePolicy,
  loadSceneInCampaign,
  validateGridCoord,
  validateTokenSize,
  MAX_PLAYER_TOKENS_PER_SCENE,
};
