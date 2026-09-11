// The media gateway: the metered, authorised path by which image BYTES reach a
// browser once direct R2 access is closed.
//
// WHY THIS EXISTS
// Serving objects straight from a public bucket means every image read happens
// where neither the operation budget nor any authorisation can see it. A player
// who left a campaign keeps working image URLs; a scraper can pull the whole
// bucket; and none of it is counted against the free-tier operation allowance.
// This gateway puts a server between the browser and R2 so that each read is
// (a) authorised against the same visibility rules the rest of the app uses and
// (b) charged a Class B operation before R2 is touched.
//
// THE SEPARATE-ORIGIN BOUNDARY IS PRESERVED, NOT DROPPED
// The original design served objects from the bucket's own hostname so that
// anything which slipped through executed with no access to session cookies
// (defence 4). That boundary stays. This gateway is intended to run on a
// DEDICATED MEDIA HOSTNAME (e.g. media.example.com) that happens to be backed by
// the same Express process — a separate origin from the application, so a media
// response still cannot read app cookies. `enforceMediaHost` refuses to serve
// media on the application origin, so a misconfiguration cannot silently
// collapse the two origins into one. Authorisation therefore CANNOT depend on a
// session cookie on the media origin; it uses a short-lived, per-asset media
// token minted by the app origin (see mintMediaToken) instead.
//
// WHAT IT WILL NOT DO
//   - It never proxies an arbitrary key or URL. The only input is a server-known
//     asset ID; an unknown or malformed ID is a local 404 that touches no R2.
//   - It never redirects to a presigned GET — that would move the read back off
//     the metered path.
//   - It does not serve active content: only the raster types the upload path
//     already validated, with nosniff and a restrictive media CSP.

const crypto = require('crypto');
const knex = require('../db');
const storage = require('./storage');
const budget = require('./storageBudget');

// The media hostname. When unset, the gateway is not enabled (reads continue on
// whatever path the deployment currently uses). When set, media is served ONLY
// for requests whose Host matches, and never on the app origin.
const MEDIA_HOST = (process.env.MEDIA_HOST || '').toLowerCase().replace(/:.*$/, '');

// Public origin used when generating browser-facing media URLs. Production
// defaults to HTTPS on MEDIA_HOST. Local development may override this with an
// explicit origin such as http://media.test:3000 while keeping the Host gate
// bound to MEDIA_HOST=media.test.
const MEDIA_ORIGIN = (() => {
  if (!MEDIA_HOST) return '';
  const configured = String(process.env.MEDIA_ORIGIN || '').trim();
  if (!configured) return `https://${MEDIA_HOST}`;
  let parsed;
  try { parsed = new URL(configured); } catch {
    throw new Error('MEDIA_ORIGIN must be an absolute http(s) origin');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MEDIA_ORIGIN must use http:// or https://');
  }
  return parsed.origin;
})();

// Secret for minting/verifying media tokens. Distinct from the session secret:
// a media token authorises reading ONE asset for a short window, nothing else.
// Falls back to SESSION_SECRET so a deployment that has not set it still works,
// but a dedicated MEDIA_TOKEN_SECRET is recommended.
const TOKEN_SECRET = process.env.MEDIA_TOKEN_SECRET || process.env.SESSION_SECRET || '';
const TOKEN_TTL_SECONDS = 300;

function isEnabled() { return !!MEDIA_HOST; }

// Host gate. Media is served only on the dedicated media host, so the separate-
// origin boundary cannot be lost to a stray route on the app origin. Returns
// true if this request is on the media host.
function onMediaHost(req) {
  if (!MEDIA_HOST) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:.*$/, '');
  return host === MEDIA_HOST;
}

// A media token is a SHORT-LIVED SIGNED BEARER CAPABILITY for exactly one
// asset. This model is chosen so the SAME token works in two places a
// viewer-bound token cannot both serve:
//
//   - HTTP responses, where the requesting viewer is known, and
//   - SOCKET BROADCASTS, where one payload is emitted to many recipients at
//     once. A viewer-bound token would need a different token per recipient in a
//     single broadcast, which is impossible; a bearer token minted once works
//     for everyone in the room.
//
// SAFETY OF THE BEARER MODEL. Visibility is enforced at MINT time, not at fetch
// time: a token is only ever minted and embedded in a URL by a code path that
// has ALREADY authorised the audience. An HTTP response rewrites a URL only for
// the authenticated caller who was allowed to receive that row; a broadcast
// rewrites only within a room whose membership already bounds who may see the
// image (private NPC data is excluded from player broadcasts BEFORE this stage).
// So a token never reaches someone who was not entitled to the underlying image.
//
// SCOPE:   one asset id. A token for asset A cannot fetch asset B.
// EXPIRY:  TOKEN_TTL_SECONDS (default 300s). After that the URL 403s and the
//          client re-fetches the data (which mints a fresh token). This bounds
//          the bearer window: a leaked URL is useless within minutes.
// REFRESH: implicit. Clients do not refresh tokens; they re-request the data
//          (asset list, scene, token list) which carries freshly-minted URLs.
// LOGGING: the token MUST NOT be logged — it is a capability. The media origin
//          logs the asset id and outcome, never the query string.
// NOT A CREDENTIAL: it carries no account identity and grants nothing beyond
//          reading one image for a few minutes. It must not become a session.
//
// The optional `viewerId` is recorded in the signature only for AUDIT binding on
// private HTTP fetches where a single viewer is known; it is absent for
// broadcast tokens, and the media route does not require it.
function mintMediaToken({ assetId, viewerId }) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${assetId}.${viewerId || ''}.${exp}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifyMediaToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload;
  try { payload = Buffer.from(body, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  // Constant-time compare.
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [assetId, viewerId, expStr] = payload.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return { assetId, viewerId: viewerId || null, exp };
}

// Visibility: may this viewer read this asset? Expressed in terms of the SAME
// membership the rest of the app uses, not a new uploader-only rule.
//
//   campaign-scoped asset  → any ACTIVE member of that campaign
//   avatar / cover         → public-media: any authenticated viewer. Avatars
//                            already appear in member rosters and covers on the
//                            campaign browser, so they are intentionally shown
//                            outside a single campaign. Still metered here.
//
// Returns the asset row if visible, else null. `viewerId` may be null only for
// public-media kinds.
async function resolveVisible(assetId, viewerId) {
  if (!assetId) return null;
  const asset = await knex('assets')
    .where({ id: assetId, status: 'ready' })
    .first();
  if (!asset) return null;

  const PUBLIC_MEDIA = asset.kind === 'avatar' || asset.kind === 'cover';
  if (PUBLIC_MEDIA) {
    // Public media still requires an authenticated viewer (so it is metered per
    // real user and cannot be scraped anonymously), but not campaign membership.
    return viewerId ? asset : null;
  }

  if (!viewerId) return null;
  if (!asset.campaign_id) {
    // A non-public personal asset (should be rare) is uploader-only.
    return asset.user_id === viewerId ? asset : null;
  }
  // Campaign-scoped: active membership (owner counts as a member).
  const campaign = await knex('campaigns')
    .where({ id: asset.campaign_id }).whereNull('deleted_at').first();
  if (!campaign) return null;
  if (campaign.owner_id === viewerId) return asset;
  const member = await knex('campaign_members')
    .where({ campaign_id: asset.campaign_id, user_id: viewerId, status: 'active' })
    .first();
  return member ? asset : null;
}

// A bounded LRU byte cache with single-flight coalescing. A cached hit serves
// without an R2 GET (still authorised first). A miss reserves a Class B permit,
// GETs from R2 once even under concurrent demand, and caches the bytes. Private
// bytes are cached too but ONLY served after authorisation — possession of a
// cached buffer is never itself permission.
const CACHE_MAX_BYTES = Number(process.env.MEDIA_CACHE_BYTES) || 64 * 1024 * 1024;
const cache = new Map(); // key -> { bytes: Buffer, mime, etag, size }
let cacheBytes = 0;
const inflight = new Map(); // key -> Promise

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU touch.
  cache.delete(key); cache.set(key, hit);
  return hit;
}

function cachePut(key, entry) {
  if (entry.size > CACHE_MAX_BYTES) return; // never cache a single object bigger than the whole cache
  cache.set(key, entry);
  cacheBytes += entry.size;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    const old = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= old ? old.size : 0;
  }
}

// Fetch an object's bytes, coalescing concurrent misses and metering the R2 GET.
// Returns { bytes, mime, etag } or throws budgetExceeded / a read error.
async function fetchBytes(asset) {
  const key = asset.storage_key;
  const cached = cacheGet(key);
  if (cached) return cached;

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    // Meter the read BEFORE touching R2. A GET is Class B.
    await budget.charge('get');
    // A full-object read. readHead is for the 16-byte magic check; here we want
    // the whole object. Use a range-less GET via the storage layer.
    const obj = await storage.getObject(key);
    const entry = {
      bytes: obj.bytes, mime: asset.mime || obj.mime, etag: obj.etag, size: obj.bytes.length,
    };
    cachePut(key, entry);
    return entry;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes, limit: CACHE_MAX_BYTES };
}

// --- URL rewriting: stored R2 URL -> tokenised gateway URL ----------------
//
// The six image columns (actors.img_url, tokens.img_url, scenes.img_url,
// items.img_url, campaigns.img_url, users.avatar_url) and assets.url store the
// PUBLIC R2 URL by value — the schema links by value, not by foreign key, on
// purpose. To route a read through the gateway we must turn that stored URL back
// into the asset id the token binds to. The link is the storage_key embedded in
// the URL: an upload's public URL is `${PUBLIC_BASE}/${storage_key}`, and
// storage_key is unique. So we strip the base, look the key up, and mint a token
// for that asset id.
//
// Only OUR hosted uploads are rewritten. An EXTERNAL link (a pasted third-party
// URL) has no storage_key and no row we host; it is returned unchanged — the
// gateway hosts nothing for it, and rewriting it would be a proxy we explicitly
// do not build. So this is idempotent and safe on mixed data: hosted URLs get a
// gateway URL, everything else passes through untouched.

const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// Extract the storage_key from a stored public URL, or null if this URL is not
// one of our hosted objects (external link, already a gateway URL, empty).
function storageKeyFromUrl(url) {
  if (typeof url !== 'string' || !url || !PUBLIC_BASE) return null;
  if (!url.startsWith(`${PUBLIC_BASE}/`)) return null;
  const key = url.slice(PUBLIC_BASE.length + 1);
  // A key has the shape scope/kind/uuid.ext — reject anything with a query or
  // fragment (cache-buster amplification) or traversal.
  if (!key || key.includes('..') || key.includes('?') || key.includes('#')) return null;
  return key;
}

// Resolve a batch of stored URLs to their asset ids in one query. Returns a Map
// url -> assetId for the URLs that are our hosted, ready objects.
async function resolveUrlsToAssetIds(urls) {
  const keys = new Map(); // storage_key -> original url
  for (const u of urls) {
    const k = storageKeyFromUrl(u);
    if (k) keys.set(k, u);
  }
  const out = new Map();
  if (keys.size === 0) return out;
  const rows = await knex('assets')
    .whereIn('storage_key', [...keys.keys()])
    .where({ status: 'ready' })
    .select('id', 'storage_key');
  for (const r of rows) {
    const url = keys.get(r.storage_key);
    if (url) out.set(url, r.id);
  }
  return out;
}

// Turn one stored URL into a tokenised gateway URL for this viewer, or return it
// unchanged if it is not a hosted object or the gateway is disabled. `assetId`
// may be supplied when already known (from a batch resolve) to skip the lookup.
function gatewayUrlFor(assetId, viewerId) {
  const token = mintMediaToken({ assetId, viewerId });
  return `${MEDIA_ORIGIN}/media/${assetId}?t=${token}`;
}

// Rewrite a single URL field. Async because it may need a lookup. Falls back to
// the original URL on any miss — never throws into a response path.
async function rewriteUrl(url, viewerId) {
  if (!isEnabled() || !url) return url;
  const key = storageKeyFromUrl(url);
  if (!key) return url; // external link or already non-hosted
  try {
    const row = await knex('assets')
      .where({ storage_key: key, status: 'ready' }).select('id').first();
    if (!row) return url;
    return gatewayUrlFor(row.id, viewerId);
  } catch {
    return url;
  }
}

// Rewrite many URLs at once (one DB round-trip). Given an array of stored URLs
// and a viewer, returns a Map url -> gatewayUrl (only for hosted objects; others
// are absent, meaning "use the original"). This is what response shapers use so
// a payload with fifty tokens costs one query, not fifty.
async function rewriteBatch(urls, viewerId) {
  const out = new Map();
  if (!isEnabled()) return out;
  const ids = await resolveUrlsToAssetIds(urls.filter(Boolean));
  for (const [url, assetId] of ids) {
    out.set(url, gatewayUrlFor(assetId, viewerId));
  }
  return out;
}

// The set of object keys that hold a stored image URL anywhere in this app's
// payloads. Rewriting is restricted to EXACTLY these keys so the walker can
// never touch a field that merely happens to contain a URL-like string (a chat
// message body, a source_url provenance field, a description). If a new image
// field is ever added, it goes here — deliberately, not by pattern-guessing.
const IMAGE_URL_KEYS = new Set(['img_url', 'avatar_url', 'url']);

// Walk a payload (object or array, nested) and collect every stored image URL
// under a known image key. Bounded depth so a pathological payload cannot cause
// unbounded recursion.
function collectImageUrls(node, out, depth = 0) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const v of node) collectImageUrls(v, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (IMAGE_URL_KEYS.has(k) && typeof v === 'string' && v) out.push(v);
    else if (v && typeof v === 'object') collectImageUrls(v, out, depth + 1);
  }
}

// Apply a url->gatewayUrl map to a payload in place, only under known image keys.
function applyImageUrls(node, map, depth = 0) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const v of node) applyImageUrls(v, map, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (IMAGE_URL_KEYS.has(k) && typeof v === 'string' && map.has(v)) node[k] = map.get(v);
    else if (v && typeof v === 'object') applyImageUrls(v, map, depth + 1);
  }
}

// Rewrite a whole payload (HTTP body or socket broadcast) in place: find every
// stored image URL under a known key, resolve them in ONE query, and swap in
// tokenised gateway URLs. `viewerId` is the audience — a single user for an HTTP
// response, or omitted/undefined for a broadcast (a bearer token whose audience
// is the room). A no-op when the gateway is disabled, so callers invoke it
// unconditionally. Returns the same payload for convenience.
async function rewritePayload(payload, viewerId) {
  if (!isEnabled() || payload == null || typeof payload !== 'object') return payload;
  const urls = [];
  collectImageUrls(payload, urls);
  if (urls.length === 0) return payload;
  const map = await rewriteBatch(urls, viewerId);
  if (map.size > 0) applyImageUrls(payload, map);
  return payload;
}

// Rewrite named URL fields on a list of plain response objects, in place, using
// ONE batch query for the whole list. `fields` are the property names that hold
// a stored image URL (e.g. ['url'] for assets, ['img_url'] for tokens,
// ['avatar_url'] for members). Objects are mutated and also returned. A no-op
// when the gateway is disabled, so a route can call it unconditionally.
async function rewriteObjects(objects, fields, viewerId) {
  if (!isEnabled() || !Array.isArray(objects) || objects.length === 0) return objects;
  const urls = [];
  for (const o of objects) {
    if (!o) continue;
    for (const f of fields) {
      if (typeof o[f] === 'string' && o[f]) urls.push(o[f]);
    }
  }
  if (urls.length === 0) return objects;
  const map = await rewriteBatch(urls, viewerId);
  for (const o of objects) {
    if (!o) continue;
    for (const f of fields) {
      if (map.has(o[f])) o[f] = map.get(o[f]);
    }
  }
  return objects;
}

// Convenience for a single object.
async function rewriteObject(obj, fields, viewerId) {
  if (!obj) return obj;
  await rewriteObjects([obj], fields, viewerId);
  return obj;
}

// Response helper: rewrite image URLs in a payload for the requesting viewer,
// then send it. Routes call `await sendJson(req, res, body)` instead of
// `res.json(body)` wherever the body may carry image URLs. A no-op rewrite when
// the gateway is disabled, so it is always safe to use. Uses req.user.id as the
// audience (a single authenticated viewer), which for an HTTP response is
// exactly right — the caller was already authorised to receive this body.
async function sendJson(req, res, payload, status = 200) {
  const viewerId = req && req.user ? req.user.id : null;
  await rewritePayload(payload, viewerId);
  return res.status(status).json(payload);
}

module.exports = {
  isEnabled, onMediaHost, MEDIA_HOST, MEDIA_ORIGIN,
  mintMediaToken, verifyMediaToken, TOKEN_TTL_SECONDS,
  resolveVisible, fetchBytes, cacheStats,
  storageKeyFromUrl, resolveUrlsToAssetIds, gatewayUrlFor, rewriteUrl, rewriteBatch,
  rewriteObjects, rewriteObject, rewritePayload, sendJson,
  // exported for tests
  _cachePut: cachePut, _cacheGet: cacheGet, _cacheClear: () => { cache.clear(); cacheBytes = 0; },
};
