// Media gateway routes.
//
// Two endpoints, deliberately on two ORIGINS backed by one process:
//
//   APP ORIGIN   GET /api/media/:id/token
//     The session lives here. It checks the viewer may see this asset (the same
//     membership rules the rest of the app uses) and mints a short-lived media
//     token. The browser then points an <img> at the media origin with that
//     token. This is the only place a session is consulted.
//
//   MEDIA ORIGIN GET /media/:id?t=<token>
//     A separate origin (MEDIA_HOST), so its responses cannot read app cookies —
//     the defence-4 boundary, preserved. It trusts the signed token, not a
//     session. It meters a Class B op on a cache miss, serves validated raster
//     bytes with nosniff and a restrictive CSP, and never proxies an arbitrary
//     key. Unknown/al­tered ids or tokens are local 404/403s that touch no R2.
//
// The gateway is only active when MEDIA_HOST is configured; otherwise these
// routes stand down and existing delivery is unchanged.

const express = require('express');
const knex = require('../db');
const { requireAuth } = require('../middleware/auth');
const gateway = require('../services/mediaGateway');
const budget = require('../services/storageBudget');

const router = express.Router();

// --- APP ORIGIN: mint a token after a real visibility check --------------
// Requires a session. Refuses to run on the media host (tokens are minted where
// the session is, not where bytes are served).
router.get('/api/media/:id/token', requireAuth, async (req, res, next) => {
  try {
    if (gateway.onMediaHost(req)) {
      return res.status(400).json({ error: 'token is minted on the application origin' });
    }
    const asset = await gateway.resolveVisible(req.params.id, req.user.id);
    if (!asset) return res.status(404).json({ error: 'not found' });
    const token = gateway.mintMediaToken({ assetId: asset.id, viewerId: req.user.id });
    return res.json({
      id: asset.id,
      url: `${gateway.MEDIA_ORIGIN}/media/${asset.id}?t=${token}`,
      expires_in: gateway.TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    return next(err);
  }
});

// --- MEDIA ORIGIN: verify token, meter, serve bytes ----------------------
// No session. Serves ONLY on the media host, so a stray hit on the app origin
// cannot collapse the two origins. The token carries the asset id and (for
// private media) the viewer; visibility was established at mint time, and the
// token's signature + short TTL is what is trusted here.
router.get('/media/:id', async (req, res, next) => {
  try {
    if (!gateway.isEnabled()) return res.status(404).end();
    // Must be the media host. If this fired on the app origin, refuse — the
    // separate-origin boundary is a security property, not a nicety.
    if (!gateway.onMediaHost(req)) return res.status(404).end();

    const claim = gateway.verifyMediaToken(req.query.t);
    if (!claim || claim.assetId !== req.params.id) {
      return res.status(403).end();
    }

    // The token is a signed, short-lived BEARER capability whose audience was
    // authorised at mint time (see mintMediaToken). The media origin cannot
    // re-run a per-viewer session check cross-origin, and does not need to: it
    // confirms the asset still exists and is ready, then serves. Full visibility
    // revocation within the token's few-minute TTL is the documented limit — a
    // cached image already in a browser cannot be recalled either.
    const asset = await knex('assets')
      .where({ id: claim.assetId, status: 'ready' })
      .whereNotNull('storage_key')
      .first();
    if (!asset) return res.status(404).end();

    let obj;
    try {
      obj = await gateway.fetchBytes(asset);
    } catch (err) {
      if (err.budgetExceeded) {
        // Class B allowance reached: do not fall back to a direct R2 URL (that
        // would bypass metering). Serve nothing rather than an unmetered read.
        res.set('Retry-After', '3600');
        return res.status(429).json({ error: 'read_budget_reached' });
      }
      return res.status(502).end();
    }

    // Validated raster only, trusted type from our own records, no sniffing, no
    // active content. A restrictive CSP on the media response means even if a
    // byte sequence were somehow interpreted as a document, it could do nothing.
    res.set('Content-Type', obj.mime || asset.mime || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if (obj.etag) res.set('ETag', `"${obj.etag}"`);
    // Private media: allow the browser to cache for the token window, but not a
    // shared/CDN cache (authorisation must keep working).
    res.set('Cache-Control', 'private, max-age=300');
    return res.status(200).end(obj.bytes);
  } catch (err) {
    return next(err);
  }
});

module.exports = { router };
