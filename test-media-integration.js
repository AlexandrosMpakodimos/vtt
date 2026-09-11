// Media gateway — INTEGRATION test through the real application wiring.
//   Usage: SKIP_HIBP=1 MEDIA_HOST=media.test MEDIA_TOKEN_SECRET=testsecret \
//          BASE_URL=http://127.0.0.1:3000 node test-media-integration.js
//   (server started with those same MEDIA_* env vars: npm run dev:test)
//
// Unlike test-media-gateway.js (which calls the service functions directly),
// this drives the ACTUAL mounted routes over HTTP: it proves the router is wired
// into server.js, that middleware ordering and auth apply, that the host
// restriction and security headers are enforced by the real stack, and that a
// request on the wrong host is refused. This is the "integration test through
// the real application wiring, not a separately mounted test router" the review
// asked for.
//
// The media route serves ONLY on MEDIA_HOST. Over HTTP we simulate origin by
// setting the Host header: a request with Host=media.test is "on the media
// origin"; the default Host (127.0.0.1) is "on the app origin".

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const MEDIA_HOST = process.env.MEDIA_HOST || 'media.test';
const http = require('http');
const knex = require('./src/db');

// A raw HTTP request that CAN override the Host header — fetch() cannot, it
// derives Host from the URL, so the host-restriction probes must use this. Set
// `cookie` to carry a session.
function rawReq(method, path, { host, cookie } = {}) {
  const u = new URL(BASE + path);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(host ? { Host: host } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let pass = 0; let fail = 0; const out = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; out.push(`  ok    ${name}`); } else { fail += 1; out.push(`  FAIL  ${name}  ${detail}`); }
}
function note(n, d) { out.push(`  NOTE  ${n}  ${d}`); }

function agent() {
  let cookie = '';
  const a = {
    get cookie() { return cookie; },
    async req(method, path, { body, host, raw } = {}) {
      const headers = { Origin: BASE };
      if (host) headers.Host = host;
      if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null; let text = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) { try { data = await res.json(); } catch { /* */ } } else { try { text = await res.text(); } catch { /* */ } }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
  return a;
}

async function register(a, tag) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@x.com`;
  const username = `${tag}${Math.random().toString(16).slice(2, 8)}`;
  await a.req('POST', '/api/auth/register', { body: { email, username, password: 'correct-horse-battery-9' } });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  await a.req('POST', '/api/auth/login', { body: { email, password: 'correct-horse-battery-9' } });
  const u = await knex('users').where({ email }).first();
  return u;
}

async function main() {
  // Guard: server up?
  try { await fetch(BASE + '/'); } catch {
    console.log('  FAIL  server not reachable at', BASE, '- start it with npm run dev:test');
    console.log('\n0 passed, 1 failed'); process.exit(1);
  }

  if (!process.env.MEDIA_HOST) {
    note('mode', 'MEDIA_HOST not set on the SERVER — gateway inactive; host/serve probes will note-skip');
  }

  const gm = agent();
  const user = await register(gm, 'mgi');

  // Build a ready asset directly (no bucket needed for the token/host/header
  // checks; the actual byte-serving path is noted when no bucket is configured).
  const [camp] = await knex('campaigns').insert({ name: `mgi-${Date.now()}`, owner_id: user.id }).returning('id');
  const campaignId = camp.id || camp;
  await knex('campaign_members').insert({ campaign_id: campaignId, user_id: user.id, status: 'active' }).catch(() => {});
  const pub = (process.env.R2_PUBLIC_BASE_URL || 'https://pub.r2.dev').replace(/\/+$/, '');
  const [asset] = await knex('assets').insert({
    campaign_id: campaignId, user_id: user.id, storage_key: 'c/mgi/map/x.png',
    url: `${pub}/c/mgi/map/x.png`, kind: 'map', status: 'ready', mime: 'image/png', bytes: 100, bytes_verified: true,
  }).returning('id');
  const assetId = asset.id || asset;

  console.log('\n--- the token endpoint is mounted and requires auth (app origin) ---');
  const anon = agent();
  const noauth = await anon.req('GET', `/api/media/${assetId}/token`);
  t('an unauthenticated token request is refused', noauth.status === 401 || noauth.status === 403, `got ${noauth.status}`);

  const tokenRes = await gm.req('GET', `/api/media/${assetId}/token`);
  if (process.env.MEDIA_HOST) {
    t('an authorised viewer gets a token (200)', tokenRes.status === 200, `got ${tokenRes.status}`);
    t('the token url points at the media host',
      tokenRes.data && typeof tokenRes.data.url === 'string' && tokenRes.data.url.includes(MEDIA_HOST),
      tokenRes.data && tokenRes.data.url);
    t('the token url carries a token param', tokenRes.data && /[?&]t=/.test(tokenRes.data.url || ''));
  } else {
    note('token', 'MEDIA_HOST unset on server: token url has no media host (gateway inactive)');
  }

  console.log('\n--- a viewer with no access is refused a token ---');
  const outsider = agent();
  await register(outsider, 'out');
  const outTok = await outsider.req('GET', `/api/media/${assetId}/token`);
  t('an outsider cannot mint a token (404)', outTok.status === 404, `got ${outTok.status}`);

  console.log('\n--- the media route enforces the HOST restriction ---');
  // On the APP origin (default host), /media/:id must NOT serve — refuses to
  // collapse the two origins. Expect 404. (fetch derives Host from the URL, so
  // the app origin is what a normal request hits.)
  const onAppOrigin = await gm.req('GET', `/media/${assetId}?t=whatever`);
  t('/media on the app origin is refused (404)', onAppOrigin.status === 404, `got ${onAppOrigin.status}`);

  // The token mint endpoint must NOT run on the media host. Needs Host override
  // AND a session, so use rawReq with the agent's cookie.
  const tokenOnMediaHost = await rawReq('GET', `/api/media/${assetId}/token`, { host: MEDIA_HOST, cookie: gm.cookie });
  t('the token endpoint refuses to run on the media host (400)', tokenOnMediaHost.status === 400, `got ${tokenOnMediaHost.status}`);

  console.log('\n--- on the media host, a bad/absent token is refused (403), not served ---');
  const badTok = await rawReq('GET', `/media/${assetId}?t=forged`, { host: MEDIA_HOST });
  t('a forged token on the media host is 403', badTok.status === 403, `got ${badTok.status}`);
  const noTok = await rawReq('GET', `/media/${assetId}`, { host: MEDIA_HOST });
  t('a missing token on the media host is 403', noTok.status === 403, `got ${noTok.status}`);

  console.log('\n--- a valid token on the media host serves bytes with safe headers ---');
  if (process.env.MEDIA_HOST && tokenRes.data && tokenRes.data.url) {
    const tParam = (tokenRes.data.url.split('t=')[1] || '').split('&')[0];
    const served = await rawReq('GET', `/media/${assetId}?t=${tParam}`, { host: MEDIA_HOST });
    // Without a real bucket the byte read fails (502) but the AUTH + HOST + header
    // path is still exercised; with a bucket it is 200. Either way it must NOT be
    // 403/404 (which would mean auth/host failed).
    const authPassed = served.status === 200 || served.status === 502 || served.status === 429;
    t('a valid token passes auth+host on the media host', authPassed, `got ${served.status}`);
    if (served.status === 200) {
      t('served with nosniff', served.headers['x-content-type-options'] === 'nosniff');
      t('served with a restrictive media CSP', /default-src 'none'/.test(served.headers['content-security-policy'] || ''));
      t('served with cross-origin resource policy', (served.headers['cross-origin-resource-policy'] || '') === 'cross-origin');
      note('serve', 'bucket configured — real bytes served through the metered path');
    } else {
      note('serve', `no bucket: auth/host verified, byte read returned ${served.status} (expected without R2)`);
    }
  } else {
    note('serve', 'MEDIA_HOST unset on server — cannot exercise the serve path');
  }

  // cleanup
  await knex('assets').where({ id: assetId }).del();
  await knex('campaign_members').where({ campaign_id: campaignId }).del();
  await knex('campaigns').where({ id: campaignId }).del();

  console.log('\n' + out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
