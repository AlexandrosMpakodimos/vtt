// Functional suite for the landing page's server change: the GET
// /api/auth/reset-password redirect swap (commit 3), plus the page caching and
// security headers on browser files (2026-10-01). Run against a real
// PostgreSQL with the server up.
//   Usage: SKIP_HIBP=1 node tests/integration/test-landing-server.js   (server must be running)
//
// What this covers (design spec §6, verification plan §A.4):
//   - valid token  -> 302 Location: /?reset=<raw>
//   - garbage token -> 302 Location: /?reset_error=1
//   - missing token -> 302 Location: /?reset_error=1
//   - expired token -> 302 Location: /?reset_error=1
//   - POST /reset-password with the raw token sets a new password (200)
//   - the new password logs in (200)
//   - reusing the now-used token via GET -> 302 /?reset_error=1
//
// The redirect (not a rendered form) is the whole point: the old inline-scripted
// form was blocked by the app's own CSP. Authority stays with POST, which
// re-validates the token regardless — so this suite drives the POST too.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const crypto = require('crypto');
const knex = require('../../src/db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}  ${detail}`); }
}

// Cookie-jar client (house pattern from test-campaigns.js).
function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* html or empty */ }
      return { status: res.status, data };
    },
  };
}

// A raw fetch that does NOT follow redirects, so we can read the 302 + Location
// the GET route now emits.
async function getNoRedirect(path) {
  const res = await fetch(BASE + path, { method: 'GET', redirect: 'manual', headers: { Origin: BASE } });
  return { status: res.status, location: res.headers.get('location') };
}

async function makeVerifiedUser(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  const r = await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  return { agent: a, email, password };
}

// Insert a reset token row directly (the mailer path is out of scope for this
// slice — the same shortcut every functional suite takes for verification).
async function insertResetToken(userId, rawToken, expiresAt) {
  await knex('password_reset_tokens').insert({
    user_id: userId,
    token_hash: sha256(rawToken),
    expires_at: expiresAt,
  });
}

async function userIdByEmail(email) {
  const row = await knex('users').where({ email }).first();
  return row ? row.id : null;
}

(async () => {
  const user = await makeVerifiedUser('reset');
  const userId = await userIdByEmail(user.email);
  check('setup: user created and verified', !!userId, user.email);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const oneHour = new Date(Date.now() + 60 * 60 * 1000);
  await insertResetToken(userId, rawToken, oneHour);

  // 1. Valid token -> 302 to /?reset=<raw>
  let g = await getNoRedirect(`/api/auth/reset-password?token=${encodeURIComponent(rawToken)}`);
  check('valid token -> 302', g.status === 302, `status ${g.status}`);
  check('valid token -> Location /?reset=<raw>',
    g.location === `/?reset=${encodeURIComponent(rawToken)}`, g.location || '(none)');

  // 2. Garbage token -> 302 to /?reset_error=1
  g = await getNoRedirect('/api/auth/reset-password?token=garbage-not-a-real-token');
  check('garbage token -> 302', g.status === 302, `status ${g.status}`);
  check('garbage token -> Location /?reset_error=1', g.location === '/?reset_error=1', g.location || '(none)');

  // 3. Missing token -> 302 to /?reset_error=1
  g = await getNoRedirect('/api/auth/reset-password');
  check('missing token -> 302', g.status === 302, `status ${g.status}`);
  check('missing token -> Location /?reset_error=1', g.location === '/?reset_error=1', g.location || '(none)');

  // 4. POST with the raw token resets the password (200, message present).
  const newPassword = 'brand-new-pass-1-correct-horse';
  const p = await user.agent.req('POST', '/api/auth/reset-password', { token: rawToken, password: newPassword });
  check('POST reset -> 200', p.status === 200, JSON.stringify(p.data));
  check('POST reset -> message present', !!(p.data && p.data.message), JSON.stringify(p.data));

  // 5. The used token via GET -> 302 /?reset_error=1 (row is now used_at-stamped).
  g = await getNoRedirect(`/api/auth/reset-password?token=${encodeURIComponent(rawToken)}`);
  check('used token -> 302', g.status === 302, `status ${g.status}`);
  check('used token -> Location /?reset_error=1', g.location === '/?reset_error=1', g.location || '(none)');

  // 6. Login with the NEW password succeeds.
  const fresh = agent();
  let l = await fresh.req('POST', '/api/auth/login', { email: user.email, password: newPassword });
  check('login with new password -> 200', l.status === 200, JSON.stringify(l.data));

  // 7. An expired token -> GET redirects to the error path.
  const expiredRaw = crypto.randomBytes(32).toString('hex');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await insertResetToken(userId, expiredRaw, past);
  g = await getNoRedirect(`/api/auth/reset-password?token=${encodeURIComponent(expiredRaw)}`);
  check('expired token -> 302', g.status === 302, `status ${g.status}`);
  check('expired token -> Location /?reset_error=1', g.location === '/?reset_error=1', g.location || '(none)');

  // [2026-10-01] Pages are revalidated on every visit, so a release is picked
  // up at once instead of a browser reusing an older cached page.
  for (const page of ['/', '/dashboard.html', '/game.html', '/privacy.html']) {
    const res = await fetch(BASE + page);
    check(`${page} is served with Cache-Control: no-cache`, res.headers.get('cache-control') === 'no-cache', res.headers.get('cache-control') || '(none)');
    check(`${page} carries a validator (ETag) so revisits are cheap`, !!res.headers.get('etag'));
  }
  const css = await fetch(BASE + '/css/tokens.css');
  check('stylesheets keep the default caching', css.headers.get('cache-control') !== 'no-cache', css.headers.get('cache-control') || '(none)');

  // [2026-10-01] Every browser file is served through the app, so it carries the
  // security headers. In production, LiteSpeed/Passenger served files from
  // <app root>/public itself, and those responses had none of them; the browser
  // files therefore live in client/, and no public/ may exist at the app root.
  for (const file of ['/dashboard.html', '/game.html', '/index.html', '/privacy.html', '/css/privacy.css', '/js/shared/authgate.js', '/css/tokens.css']) {
    const res = await fetch(BASE + file);
    const csp = res.headers.get('content-security-policy') || '';
    check(`${file}: 200 with a CSP that limits scripts to 'self'`, res.status === 200 && csp.includes("script-src 'self'"), `${res.status} ${csp || '(no CSP)'}`);
    check(`${file}: frame protection and nosniff`, res.headers.get('x-frame-options') === 'SAMEORIGIN' && res.headers.get('x-content-type-options') === 'nosniff');
    // [2026-10-06, Fix 2] The browser connects to this origin and its WebSocket
    // only; the R2 hosts left over from the removed presigned upload are gone.
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src ')) || '';
    check(`${file}: connect-src is exactly 'self' ws: wss: (no object-storage host)`,
      connect === "connect-src 'self' ws: wss:" && !/r2\.cloudflarestorage\.com/.test(csp), connect || '(none)');
  }
  // [2026-10-01, audit C2] Asset writes are behind the same origin check as
  // the auth and campaign routes.
  for (const [method, path] of [['POST', '/api/assets/external'], ['POST', '/api/assets/upload'], ['DELETE', '/api/assets/00000000-0000-4000-8000-000000000000']]) {
    const res = await fetch(BASE + path, { method, headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
    check(`cross-origin ${method} ${path} is refused (403)`, res.status === 403, `got ${res.status}`);
  }
  check('no public/ directory at the app root (the host would serve it around the app)',
    !require('fs').existsSync(require('path').join(__dirname, '..', '..', 'public')));

  // Cleanup: remove this user's reset tokens and the user row.
  await knex('password_reset_tokens').where({ user_id: userId }).del();
  await knex('users').where({ id: userId }).del();

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(results.join('\n'));
  console.error('\nSUITE ERROR:', e);
  await knex.destroy();
  process.exit(1);
});
