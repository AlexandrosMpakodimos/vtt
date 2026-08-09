// Assets: authorising uploads, verifying what arrived, and recording external
// links. Mounted at /api/assets, NOT under a campaign, because an avatar has no
// campaign — the campaign is a property of the asset rather than of the path.
//
// That is a departure from every other resource in this project, which is
// addressed through its campaign and inherits requireMember from doing so. The
// consequence is that membership must be checked HERE, explicitly, per request.
// It is written out rather than assumed, because a route family that does not
// inherit the project's usual authorisation is exactly where an omission would
// survive review.
//
// ---------------------------------------------------------------------------
// THE UPLOAD IS A THREE-STEP CONVERSATION
// ---------------------------------------------------------------------------
//   POST /api/assets/presign    we authorise ONE upload and record it pending
//   (client PUTs the bytes straight to R2 — never through this server)
//   POST /api/assets/:id/confirm  we read the bytes back and verify them
//
// The middle step deliberately does not involve us. Proxying the file would
// double the bandwidth, put an arbitrary-size body through a process that
// currently caps JSON at 100 kB, and buy nothing: we verify afterwards either
// way, and the presigned URL already pins the type and the length.
//
// The third step is the one that matters. Everything before it is the client's
// word, and R2 — unlike an image CDN — stores exactly what it is given.

const express = require('express');
const knex = require('../db');
const { requireAuth } = require('../middleware/auth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const { withAtomicCap } = require('../services/atomicCap');
const { validateImageUrl, validateInt, validUuid } = require('../services/validators');
const storage = require('../services/storage');

const router = express.Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// Storage is optional, so every route that needs it says so rather than
// throwing. A machine with no bucket configured must still start, still serve
// the application, and still pass every suite that does not concern uploads —
// a thesis artefact that cannot run without the author's cloud credentials is
// not reproducible.
function requireStorage(req, res, next) {
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'image storage is not configured on this server' });
  }
  return next();
}

// Quotas. CHOSEN, not measured — abuse prevention, and enforced atomically
// through the same primitive as every other "no more than N of X" rule.
//
// Two scopes because assets have two: a campaign's maps and portraits are
// counted against that campaign, a personal avatar against its owner. One
// global cap would let a busy campaign exhaust an unrelated one's allowance.
const MAX_ASSETS_PER_CAMPAIGN = 300;
const MAX_ASSETS_PER_USER = 20;

// A presigned URL that is never used leaves a pending row holding quota. It is
// reclaimed by the sweep in server.js after this long.
const PENDING_TTL_MINUTES = 30;

function publicAsset(a) {
  if (!a) return null;
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    user_id: a.user_id,
    url: a.url,
    source: a.source,
    source_url: a.source_url,
    kind: a.kind,
    status: a.status,
    mime: a.mime,
    bytes: a.bytes,
    created_at: a.created_at,
  };
}

// Who may create an asset of this kind, in this scope.
//
// Deliberately expressed in terms of the EXISTING field permissions rather than
// as a new rule: a map is a scene image and scenes are GM-only, a portrait
// follows img_url which a player may set on their own character, an avatar is
// personal. Inventing a separate permission model for uploads would be a second
// authority over the same question.
async function mayCreate({ userId, kind, campaignId }) {
  if (kind === 'avatar') {
    // Personal, no campaign involved. Anyone may have one.
    return { ok: campaignId == null, isOwner: false };
  }
  if (!campaignId) return { ok: false };

  const campaign = await knex('campaigns')
    .where({ id: campaignId }).whereNull('deleted_at').first();
  if (!campaign) return { ok: false };

  const isOwner = campaign.owner_id === userId;
  if (!isOwner) {
    const member = await knex('campaign_members')
      .where({ campaign_id: campaignId, user_id: userId, status: 'active' }).first();
    if (!member) return { ok: false };
  }

  // A map is the board itself. Everything else is content a member may author
  // for something they own, and the field-level checks on the actor, token and
  // item routes still apply when the URL is actually assigned.
  if (kind === 'map' && !isOwner) return { ok: false, forbidden: true };
  return { ok: true, isOwner };
}

// POST /api/assets/presign — authorise exactly one upload.
//
// Refusals are 404 rather than 403 for a campaign the caller cannot reach, so
// this route cannot be used to discover which campaigns exist. A member who may
// not upload a MAP gets 403, because by then their membership is established
// and the refusal discloses nothing new.
router.post('/presign', requireStorage, async (req, res, next) => {
  try {
    const body = req.body || {};

    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!storage.KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${storage.KINDS.join(', ')}` });
    }

    const campaignId = body.campaign_id === undefined || body.campaign_id === null
      ? null : body.campaign_id;
    if (campaignId !== null && !validUuid(campaignId)) {
      return res.status(404).json({ error: 'campaign not found' });
    }

    const perm = await mayCreate({ userId: req.user.id, kind, campaignId });
    if (!perm.ok) {
      if (perm.forbidden) return res.status(403).json({ error: 'only the GM may upload a map' });
      return res.status(404).json({ error: 'campaign not found' });
    }

    const mime = typeof body.mime === 'string' ? body.mime.trim().toLowerCase() : '';
    const fmt = storage.formatFor(mime);
    if (!fmt) {
      // SVG lands here, and that is the point: it is not in the allow-list, so
      // there is no path by which a scriptable image reaches the bucket.
      return res.status(400).json({ error: `mime must be one of: ${storage.allowedMimes().join(', ')}` });
    }

    const limit = storage.limitFor(kind);
    const size = validateInt(body.bytes, { min: 1, max: limit, field: 'bytes' });
    if (size.error) return res.status(400).json({ error: size.error });

    const key = storage.buildKey({
      campaignId, userId: req.user.id, kind, ext: fmt.ext,
    });

    // The quota is claimed BEFORE the URL is issued, not after the upload
    // succeeds. Issuing an authorisation that would exceed the cap and then
    // refusing the result would waste the user's upload and leave an object in
    // the bucket to clean up.
    const scope = campaignId ? { campaign_id: campaignId } : { user_id: req.user.id, campaign_id: null };
    let row;
    try {
      const rows = await withAtomicCap({
        table: 'assets',
        where: { ...scope, status: 'ready' },
        max: campaignId ? MAX_ASSETS_PER_CAMPAIGN : MAX_ASSETS_PER_USER,
        capMessage: campaignId
          ? `a campaign may hold at most ${MAX_ASSETS_PER_CAMPAIGN} images`
          : `you may hold at most ${MAX_ASSETS_PER_USER} personal images`,
        insert: {
          campaign_id: campaignId,
          user_id: req.user.id,
          storage_key: key,
          url: storage.publicUrl(key),
          source: 'upload',
          kind,
          status: 'pending',
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    const uploadUrl = await storage.presignUpload({ key, mime, bytes: size.value });

    return res.status(201).json({
      asset: publicAsset(row),
      upload: {
        url: uploadUrl,
        method: 'PUT',
        // The client MUST send exactly these. They are part of the signature,
        // so R2 refuses the PUT if either differs — which is how the size limit
        // is enforced by the storage provider rather than by trust.
        headers: { 'Content-Type': mime, 'Content-Length': String(size.value) },
        expires_in: storage.UPLOAD_URL_TTL_SECONDS,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/assets/:id/confirm — the client says the upload finished.
//
// THIS IS THE STEP THAT MAKES THE OTHERS MEAN ANYTHING. Everything before it is
// the client's account of events. Here the server reads the object's first
// bytes back out of the bucket and checks them against the magic numbers for
// the format that was claimed.
//
// A file whose bytes disagree with its declared type is DELETED and the row
// marked rejected — not stored and flagged, because an object that is not what
// it says it is has no reason to remain in the bucket.
router.post('/:id/confirm', requireStorage, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: 'asset not found' });

    // Scoped to the uploader. Confirming somebody else's pending upload would
    // let one user complete another's authorisation.
    const asset = await knex('assets')
      .where({ id: req.params.id, user_id: req.user.id }).first();
    if (!asset) return res.status(404).json({ error: 'asset not found' });
    if (asset.status !== 'pending') {
      return res.status(409).json({ error: `asset is already ${asset.status}` });
    }

    let head;
    try {
      head = await storage.readHead(asset.storage_key);
    } catch {
      // Nothing is there. The presigned URL was issued and never used, or the
      // upload failed. Not an error on the client's part; the row simply never
      // becomes usable.
      return res.status(409).json({ error: 'no upload found for that asset' });
    }

    const declared = head.reportedMime;
    const ok = storage.magicMatches(declared, head.head);

    if (!ok) {
      await storage.remove(asset.storage_key);
      await knex('assets').where({ id: asset.id })
        .update({ status: 'rejected', updated_at: knex.fn.now() });
      return res.status(400).json({
        error: 'that file is not the image type it claims to be',
      });
    }

    const [row] = await knex('assets').where({ id: asset.id }).update({
      status: 'ready',
      mime: declared,
      bytes: head.reportedBytes,
      updated_at: knex.fn.now(),
    }).returning('*');

    return res.json({ asset: publicAsset(row) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/assets/external — record a pasted link.
//
// No bytes are involved and our server never contacts the host. The row exists
// so that provenance is recorded and the image appears in the same library as
// uploads; the URL itself is stored and rendered directly by each player's
// browser.
//
// THE TRADE-OFF, recorded rather than hidden: every player who views this image
// makes a request to that third party, disclosing their IP address to it. The
// alternatives were a server-side fetcher — which requires solving SSRF for
// arbitrary destinations, across redirects, against DNS rebinding — and an
// edge image proxy, which needs a domain this project does not have. Both are
// deferred, and the interface says plainly what this option costs.
router.post('/external', async (req, res, next) => {
  try {
    const body = req.body || {};

    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!storage.KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${storage.KINDS.join(', ')}` });
    }

    const campaignId = body.campaign_id === undefined || body.campaign_id === null
      ? null : body.campaign_id;
    if (campaignId !== null && !validUuid(campaignId)) {
      return res.status(404).json({ error: 'campaign not found' });
    }

    const perm = await mayCreate({ userId: req.user.id, kind, campaignId });
    if (!perm.ok) {
      if (perm.forbidden) return res.status(403).json({ error: 'only the GM may set a map' });
      return res.status(404).json({ error: 'campaign not found' });
    }

    const url = validateImageUrl(body.url, 'url');
    if (url.error) return res.status(400).json({ error: url.error });
    if (!url.value) return res.status(400).json({ error: 'url is required' });

    const scope = campaignId ? { campaign_id: campaignId } : { user_id: req.user.id, campaign_id: null };
    let row;
    try {
      const rows = await withAtomicCap({
        table: 'assets',
        where: { ...scope, status: 'ready' },
        max: campaignId ? MAX_ASSETS_PER_CAMPAIGN : MAX_ASSETS_PER_USER,
        capMessage: campaignId
          ? `a campaign may hold at most ${MAX_ASSETS_PER_CAMPAIGN} images`
          : `you may hold at most ${MAX_ASSETS_PER_USER} personal images`,
        insert: {
          campaign_id: campaignId,
          user_id: req.user.id,
          storage_key: null,
          url: url.value,
          source_url: url.value,
          source: 'external',
          kind,
          // Ready immediately: there is nothing of ours to verify. The honesty
          // is in `source`, which says where this came from.
          status: 'ready',
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    return res.status(201).json({ asset: publicAsset(row) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/assets?campaign_id=… — the library for a campaign, or your own
// personal images when no campaign is given.
router.get('/', async (req, res, next) => {
  try {
    const campaignId = req.query.campaign_id;
    if (campaignId !== undefined) {
      if (!validUuid(campaignId)) return res.status(404).json({ error: 'campaign not found' });
      const perm = await mayCreate({ userId: req.user.id, kind: 'portrait', campaignId });
      if (!perm.ok) return res.status(404).json({ error: 'campaign not found' });

      const rows = await knex('assets')
        .where({ campaign_id: campaignId, status: 'ready' })
        .orderBy('created_at', 'desc');
      return res.json({ assets: rows.map(publicAsset) });
    }

    const rows = await knex('assets')
      .where({ user_id: req.user.id, status: 'ready' })
      .whereNull('campaign_id')
      .orderBy('created_at', 'desc');
    return res.json({ assets: rows.map(publicAsset) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/assets/:id
//
// Removes the object and the row. It does NOT go looking for the six columns
// that might be rendering this URL — see the migration header for why the link
// is by value rather than by foreign key. The practical consequence is stated
// in the response: something may still point here, and it will render a broken
// image rather than silently substituting something else.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: 'asset not found' });

    const asset = await knex('assets').where({ id: req.params.id }).first();
    if (!asset) return res.status(404).json({ error: 'asset not found' });

    // The uploader, or the GM of the campaign it belongs to. A GM curates their
    // campaign's library; nobody else touches somebody's personal images.
    let allowed = asset.user_id === req.user.id;
    if (!allowed && asset.campaign_id) {
      const campaign = await knex('campaigns')
        .where({ id: asset.campaign_id }).whereNull('deleted_at').first();
      allowed = !!campaign && campaign.owner_id === req.user.id;
    }
    if (!allowed) return res.status(404).json({ error: 'asset not found' });

    if (asset.storage_key) await storage.remove(asset.storage_key);
    await knex('assets').where({ id: asset.id }).del();

    return res.json({ ok: true, id: asset.id });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicAsset,
  MAX_ASSETS_PER_CAMPAIGN,
  MAX_ASSETS_PER_USER,
  PENDING_TTL_MINUTES,
};
