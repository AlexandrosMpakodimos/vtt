// Content-Security-Policy directives for every response (helmet, src/server.js).
//
// A function of explicit inputs rather than of process.env read in place, so the
// policy can be tested with any environment (tests/unit/test-csp.js).
//
// connect-src [CHANGED 2026-10-06, Fix 2]. It used to add the Cloudflare R2 S3
// endpoints (`<account>.r2.cloudflarestorage.com` and the bucket host) whenever
// R2_ACCOUNT_ID was set, because the browser once PUT uploads straight to the
// bucket through a presigned URL. Fix 1 removed that path: uploads go through
// POST /api/assets/upload and images are read through the media Worker as
// <img> sources (img-src). Nothing in client/ connects to any other origin, so
// the R2 hosts were permissions with no use — removed by rule A (least
// privilege). Not a vulnerability while they were there (the bucket is private
// and the browser holds no credentials), but a policy should list only what the
// page needs.
//
// connect-src is still stated explicitly, because naming it overrides the
// default-src fallback for connections:
//   'self'  the API, and the Socket.IO transport, which is same-origin
//   ws/wss  the WebSocket upgrade — some browsers do not treat these as covered
//           by 'self', and omitting them silently breaks the real-time layer
//           while leaving HTTP working

const helmet = require('helmet');

// Browser-facing media origin. In production the existing `https:` img-src
// allowance already covers a normal HTTPS media hostname. Local development can
// explicitly use an HTTP origin such as http://media.test:3000; add only that
// exact configured origin to img-src rather than allowing arbitrary http:.
function mediaOriginFrom(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.origin : null;
  } catch {
    return null;
  }
}

function cspDirectives({ isProd, mediaOrigin }) {
  const media = mediaOriginFrom(mediaOrigin);
  return {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'img-src': ["'self'", 'https:', 'data:', ...(media ? [media] : [])],
    'connect-src': ["'self'", 'ws:', 'wss:'],
    'style-src': ["'self'", "'unsafe-inline'"], // the dev harness uses an inline <style> block
    // upgrade-insecure-requests only makes sense over HTTPS; dropping it in
    // local http development avoids breaking same-origin sub-resource loading.
    ...(isProd ? {} : { 'upgrade-insecure-requests': null }),
  };
}

module.exports = { cspDirectives, mediaOriginFrom };
