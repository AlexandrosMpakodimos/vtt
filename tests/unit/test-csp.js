// Content-Security-Policy directives (src/config/csp.js). No server, no database:
//     node tests/unit/test-csp.js
//
// [2026-10-06, Fix 2] connect-src used to add the Cloudflare R2 S3 hosts whenever
// R2_ACCOUNT_ID was set, for the browser's presigned PUT that Fix 1 removed.
// Production sets R2_ACCOUNT_ID and R2_BUCKET (the SERVER talks to R2), so this
// suite sets them too: the policy must not widen because of them. The live
// header is checked again over HTTP in tests/integration/test-landing-server.js.

const helmet = require('helmet');

process.env.R2_ACCOUNT_ID = 'acct0123456789';
process.env.R2_BUCKET = 'vtt-prod-media';
const { cspDirectives, mediaOriginFrom } = require('../../src/config/csp');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) pass += 1; else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// What the browser receives, through helmet's own serialiser.
function header(opts) {
  let value = '';
  const res = { setHeader: (k, v) => { if (k.toLowerCase() === 'content-security-policy') value = v; } };
  helmet.contentSecurityPolicy({ directives: cspDirectives(opts) })({}, res, () => {});
  return value;
}
const directive = (csp, name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '');

for (const isProd of [true, false]) {
  const csp = header({ isProd, mediaOrigin: 'https://vtt-media.trucksart.workers.dev' });
  const label = isProd ? 'production' : 'development';
  t(`${label}: connect-src is exactly 'self' ws: wss:`, directive(csp, 'connect-src') === "connect-src 'self' ws: wss:", directive(csp, 'connect-src'));
  t(`${label}: no R2 host anywhere in the policy, although R2_ACCOUNT_ID and R2_BUCKET are set`,
    !/r2\.cloudflarestorage\.com|acct0123456789|vtt-prod-media/.test(csp), csp);
  t(`${label}: scripts stay limited to 'self'`, directive(csp, 'script-src') === "script-src 'self'", directive(csp, 'script-src'));
  t(`${label}: frames are refused`, directive(csp, 'frame-ancestors') === "frame-ancestors 'self'", directive(csp, 'frame-ancestors'));
  t(`${label}: images may come from https: (the media Worker)`, /^img-src 'self' https: data:/.test(directive(csp, 'img-src')), directive(csp, 'img-src'));
}
t('upgrade-insecure-requests only in production',
  /upgrade-insecure-requests/.test(header({ isProd: true })) && !/upgrade-insecure-requests/.test(header({ isProd: false })));
t('a local http media origin is added to img-src as an exact origin',
  directive(header({ isProd: false, mediaOrigin: 'http://media.test:3001/some/path' }), 'img-src') === "img-src 'self' https: data: http://media.test:3001");
t('a malformed media origin adds nothing', mediaOriginFrom('not a url') === null && mediaOriginFrom('javascript:alert(1)') === null);

console.log(`\ncsp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
