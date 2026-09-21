// PROOF OF CONCEPT. Isolated from the VTT application source. Never deployed.
//
// A narrow pass-through in front of the app's existing media route. The Worker
// does NOT authorise anything: the app still verifies the signed token, checks
// the asset row, meters R2 and serves the bytes. The Worker only
//   1. accepts one exact request shape,
//   2. proves to the app that the request came through this proxy (secret header),
//   3. maps the app's answer to a fixed, reviewed set of responses.
//
// It logs nothing (no console calls), keeps no cache, and follows no redirects.

const PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// base64url(payload) "." base64url(HMAC-SHA-256). The app's token is about 156 chars.
const TOKEN = /^[A-Za-z0-9_-]{16,512}\.[A-Za-z0-9_-]{32,128}$/;
// One strong or weak entity tag, printable ASCII, no inner quote.
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;
// The four raster types the upload path accepts (src/services/storage.js).
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const DEFAULTS = {
  headerTimeoutMs: 15_000, // time to first response headers
  totalTimeoutMs: 45_000, // whole exchange, including body streaming
  maxBytes: 14 * 1024 * 1024, // upload cap is 13 MiB; one MiB of slack
};

// Re-asserted on every response so the browser never depends on the upstream.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
};

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// Returns null when the deployment is misconfigured; callers answer 500 without detail.
function readConfig(env) {
  if (!env) return null;
  const secret = env.MEDIA_PROXY_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  let origin;
  try {
    origin = new URL(env.UPSTREAM_ORIGIN);
  } catch {
    return null;
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password) return null;
  if (origin.port || origin.search || origin.hash || origin.pathname !== '/') return null;
  const host = origin.hostname;
  if (!host.includes('.') || host.includes(':') || /^[0-9.]+$/.test(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return {
    origin,
    secret,
    headerTimeoutMs: boundedInt(env.UPSTREAM_HEADER_TIMEOUT_MS, DEFAULTS.headerTimeoutMs, 1, 60_000),
    totalTimeoutMs: boundedInt(env.UPSTREAM_TOTAL_TIMEOUT_MS, DEFAULTS.totalTimeoutMs, 1, 120_000),
    maxBytes: boundedInt(env.MAX_RESPONSE_BYTES, DEFAULTS.maxBytes, 1, 64 * 1024 * 1024),
  };
}

function errorResponse(status, code, method, extra) {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  const body = method === 'HEAD' ? null : JSON.stringify({ error: code });
  return new Response(body, { status, headers });
}

function validRetryAfter(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 86_400 ? String(n) : null;
}

function cacheControlFor(value) {
  const m = typeof value === 'string' ? /^private, max-age=([0-9]{1,3})$/.exec(value) : null;
  return m && Number(m[1]) <= 300 ? value : 'private, no-store';
}

function mediaType(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

function discard(upstream) {
  try {
    const cancelled = upstream.body && upstream.body.cancel();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
  } catch {
    /* nothing to release */
  }
}

// Pass-through with a byte ceiling. It never buffers more than one chunk.
function limitedPassThrough(max, onDone) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        onDone();
        controller.error(new Error('response_too_large'));
      } else {
        controller.enqueue(chunk);
      }
    },
    flush() {
      onDone();
    },
    cancel() {
      onDone();
    },
  });
}

export function createHandler({ fetchImpl }) {
  return async function handle(request, env) {
    const method = request.method;
    const cfg = readConfig(env);
    if (!cfg) return errorResponse(500, 'misconfigured', method);
    if (method !== 'GET' && method !== 'HEAD') {
      return errorResponse(405, 'method_not_allowed', method, { allow: 'GET, HEAD' });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'bad_request', method);
    }
    const route = PATH.exec(url.pathname);
    if (!route) return errorResponse(404, 'not_found', method);
    if (!url.search.startsWith('?t=') || !TOKEN.test(url.search.slice(3))) {
      return errorResponse(400, 'bad_request', method);
    }
    const token = url.search.slice(3);

    const ifNoneMatch = (request.headers.get('if-none-match') || '').trim();
    const conditional = ETAG.test(ifNoneMatch) ? ifNoneMatch : null;

    // Fresh outbound headers: nothing is copied from the browser request.
    const target = new URL(`/media/${route[1]}`, cfg.origin);
    target.search = `?t=${token}`;
    const outbound = new Headers({
      'x-media-proxy-auth': cfg.secret,
      accept: 'image/png, image/jpeg, image/webp, image/gif',
      'accept-encoding': 'identity',
      'user-agent': 'vtt-media-proxy/0.1',
    });
    if (conditional) outbound.set('if-none-match', conditional);

    const controller = new AbortController();
    let timedOut = false;
    const headerTimer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.headerTimeoutMs);
    const totalTimer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.totalTimeoutMs);
    const done = () => { clearTimeout(headerTimer); clearTimeout(totalTimer); };

    let upstream;
    try {
      upstream = await fetchImpl(target.toString(), {
        method,
        headers: outbound,
        redirect: 'manual', // a redirect would carry the secret elsewhere
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      done();
      return timedOut
        ? errorResponse(504, 'upstream_timeout', method)
        : errorResponse(502, 'upstream_unreachable', method);
    }
    clearTimeout(headerTimer);
    const status = upstream.status;

    if (status === 200) {
      const type = mediaType(upstream.headers.get('content-type'));
      if (!IMAGE_TYPES.has(type)) {
        discard(upstream); done();
        return errorResponse(502, 'unexpected_content_type', method);
      }
      const lengthHeader = upstream.headers.get('content-length');
      let declared = null;
      if (lengthHeader !== null) {
        if (!/^[0-9]{1,9}$/.test(lengthHeader)) {
          discard(upstream); done();
          return errorResponse(502, 'upstream_response_invalid', method);
        }
        declared = Number(lengthHeader);
        if (declared > cfg.maxBytes) {
          discard(upstream); done();
          return errorResponse(502, 'upstream_response_too_large', method);
        }
      }
      const headers = new Headers({
        ...SECURITY_HEADERS,
        'content-type': type,
        'cache-control': cacheControlFor(upstream.headers.get('cache-control')),
      });
      if (declared !== null) headers.set('content-length', String(declared));
      const etag = upstream.headers.get('etag');
      if (etag && ETAG.test(etag)) headers.set('etag', etag);
      if (method === 'HEAD') {
        discard(upstream); done();
        return new Response(null, { status: 200, headers });
      }
      const body = upstream.body ? upstream.body.pipeThrough(limitedPassThrough(cfg.maxBytes, done)) : null;
      return new Response(body, { status: 200, headers });
    }

    discard(upstream);
    done();

    if (status === 304) {
      if (!conditional) return errorResponse(502, 'unexpected_upstream_status', method);
      const headers = new Headers({
        ...SECURITY_HEADERS,
        'cache-control': cacheControlFor(upstream.headers.get('cache-control')),
      });
      const etag = upstream.headers.get('etag');
      if (etag && ETAG.test(etag)) headers.set('etag', etag);
      return new Response(null, { status: 304, headers });
    }
    if (status === 403) return errorResponse(403, 'forbidden', method);
    if (status === 404) return errorResponse(404, 'not_found', method);

    const retry = validRetryAfter(upstream.headers.get('retry-after'));
    const retryHeader = retry ? { 'retry-after': retry } : undefined;
    if (status === 429) return errorResponse(429, 'rate_limited', method, retryHeader);
    if (status >= 300 && status < 400) return errorResponse(502, 'unexpected_upstream_redirect', method);
    if (status === 503) return errorResponse(503, 'upstream_unavailable', method, retryHeader);
    if (status === 504) return errorResponse(504, 'upstream_timeout', method);
    if (status >= 500) return errorResponse(502, 'upstream_error', method);
    return errorResponse(502, 'unexpected_upstream_status', method);
  };
}

const handle = createHandler({ fetchImpl: (input, init) => fetch(input, init) });

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
