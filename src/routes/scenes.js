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
} = require('../services/validators');

// mergeParams: this router is mounted at .../:id/scenes, and :id (the campaign)
// lives on the parent router's params.
const router = express.Router({ mergeParams: true });

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

    // True hiding: a hidden token is filtered out of what a PLAYER receives, not
    // merely dimmed client-side. Sending it and hiding it in CSS would leak — a
    // player reading the socket/JSON would see it. The GM (owner) gets everything.
    const isOwner = req.campaign.owner_id === req.user.id;
    const q = knex('tokens').where({ scene_id: scene.id });
    if (!isOwner) q.where('hidden', false);
    const tokens = await q.orderBy('created_at', 'asc');

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
    if (sockets) {
      const becameHidden = row.hidden === true;
      const becameVisible = token.hidden === true && row.hidden === false;
      if (becameHidden) {
        // Tell players to drop it (if they could see it before), GM to update it.
        sockets.broadcastToPlayers(req.campaign.id, 'token:deleted', { id: row.id, scene_id: scene.id });
        sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
      } else if (becameVisible) {
        sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
        sockets.broadcastToPlayers(req.campaign.id, 'token:created', shaped);
      } else {
        // Not a visibility change (resize/lock on an already-visible token, or an
        // edit to an already-hidden one): update whoever can legitimately see it.
        if (row.hidden) sockets.broadcastToOwner(req.campaign.id, 'token:updated', shaped);
        else sockets.broadcastToken(req.campaign.id, 'token:updated', shaped);
      }
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
      sockets.broadcastToken(req.campaign.id, 'token:deleted-batch', {
        ids: deletedIds, scene_id: scene.id,
      });
    }

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
// field is validated exactly as it is on placement, `created_by` and `scene_id`
// are set server-side (never from the body), and actor_id is forced NULL. The
// worst a hostile client can do is create tokens it is already allowed to create
// via the normal placement endpoint.
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

      // Hand-listed columns only. scene_id / created_by / actor_id come from the
      // server, never from the body — a forged value in the spec is ignored.
      rows.push({
        scene_id: scene.id,
        actor_id: null,
        created_by: req.user.id,
        name: name.value,
        img_url: img.value,
        x: x.value,
        y: y.value,
        width: width.value,
        height: height.value,
        hidden,
        locked: false,          // a pasted token starts unlocked
      });
    }

    const inserted = await knex('tokens').insert(rows).returning('*');
    const shaped = inserted.map(publicToken);

    const sockets = req.app.get('campaignSockets');
    if (sockets) {
      for (const t of shaped) {
        if (t.hidden) sockets.broadcastToOwner(req.campaign.id, 'token:created', t);
        else sockets.broadcastToken(req.campaign.id, 'token:created', t);
      }
    }

    return res.status(201).json({ tokens: shaped });
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
  SIZE_PRESETS,
};
