// Media route gate: host mode and proxy mode, at the route level.
//
//   node scripts/test-local.js test-media-proxy-gate.js
//
// Drives the REAL src/routes/media.js router and the REAL mediaGateway module
// over real HTTP, in two configurations that are loaded one after the other in
// this process: host mode (MEDIA_PROXY_SECRET unset) and proxy mode (set). The
// database is real (fixtures below); storage.getObject is stubbed with a read
// counter, so no object storage is involved. It starts its own loopback
// listeners and does not use the isolated test server.
//
// What it does not cover: the real server.js wiring (custom helmet directives,
// session, passport). tests/integration/test-media-integration.js remains the
// manual check of that wiring in host mode.
//
// FIXTURE OWNERSHIP. Every row this suite COMMITS is marked so that it can be
// recognised and removed without touching anything else:
//   campaigns  name starts with   __vtt_media_proxy_gate_test__
//   users      email ends with    @media-proxy-gate.invalid   (.invalid is reserved)
// Assets are owned through those campaigns and users. Every id the suite creates,
// committed or not, is also recorded in memory (`created`), so teardown can remove
// and verify by exact id and does not depend on the markers alone.
//
// THE CLEANUP-BOUNDARY BLOCK deliberately creates UNMARKED look-alike rows (a
// marker in the middle of a name, in another case, truncated, a name that shares
// only its prefix, and similar email domains) to prove the marker routine leaves
// them alone. Nothing could identify such rows afterwards, so that whole block
// runs inside ONE database transaction that is ALWAYS rolled back. The transaction
// is passed explicitly to the cleanup helper, so every operation in the block uses
// it. An exception, a dropped connection or a killed process cannot leave any of
// it behind: PostgreSQL discards an uncommitted transaction. The HTTP route tests
// run outside that transaction.
//
// CLEANUP. Startup removes only committed rows carrying the markers (left over
// from an interrupted earlier run of THIS suite). A finally block removes this
// run's rows by marker and by recorded id, restores environment variables, stubs,
// the module cache and the budget ledger row, verifies that no recorded fixture
// remains (marked or not), and closes listeners and the database pool.
//
// INTERRUPTION RECOVERY. If this suite is killed mid-run, the rows it had
// committed remain; the look-alike block leaves nothing. That startup cleanup
// cannot protect EARLIER suites in the next full run: for example test-assets.js
// refuses to start while stored test assets exist. After an interruption, run
// this suite once by itself before the next full run:
//   node scripts/test-local.js test-media-proxy-gate.js
// or remove only its rows with the statements in docs/testing.md.

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');

const knex = require('../../src/db');
const storage = require('../../src/services/storage');
const budget = require('../../src/services/storageBudget');

const MARKER = '__vtt_media_proxy_gate_test__';
const EMAIL_SUFFIX = '@media-proxy-gate.invalid';
// Look-alikes exist only inside the rolled-back cleanup-boundary transaction.
const LOOKALIKE_NAME = '__vtt_media_proxy_gate_decoy__'; // shares the marker's prefix; is not the marker
const LOOKALIKE_EMAIL_DOMAIN = '@media-proxy-gate.example';
const RUN = crypto.randomBytes(4).toString('hex');

const TOKEN_SECRET = 'route-gate-token-secret-0123456789abcdef';
const SESSION_SECRET = 'route-gate-session-secret-0123456789abcd';
const PROXY_SECRET = 'route-gate-PROXY-secret-0123456789abcdef';
const COMMA_SECRET = 'route-gate-part-one-0123456789, route-gate-part-two-0123456789';
const WORKER_HOST = 'vtt-media.acct.workers.dev';
const APP_HOST = 'vtt-app.onrender.com';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// --- state to restore ------------------------------------------------------
const ENV_KEYS = ['MEDIA_HOST', 'MEDIA_ORIGIN', 'MEDIA_PROXY_SECRET', 'MEDIA_TOKEN_SECRET', 'SESSION_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalGetObject = storage.getObject;
const originalIsConfigured = storage.isConfigured;
const RELOADED = ['../../src/services/mediaGateway', '../../src/routes/media'].map((p) => require.resolve(p));
const savedCache = new Map(RELOADED.map((k) => [k, require.cache[k]]));
const servers = [];
// Every id this suite creates, committed or not, for exact-id teardown and verification.
const created = { users: [], campaigns: [], assets: [] };
let ledgerBefore = null;
let getCount = 0;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) pass += 1; else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

storage.getObject = async () => { getCount += 1; return { bytes: PNG, mime: 'image/png', etag: 'etag1' }; };
storage.isConfigured = () => true;

// --- helpers ---------------------------------------------------------------
// Fresh gateway and router for a given environment. Only these two modules are
// reloaded; db, storage and the budget module stay shared singletons.
function loadStack(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  for (const k of RELOADED) delete require.cache[k];
  const gw = require('../../src/services/mediaGateway');
  const { router } = require('../../src/routes/media');
  return { gw, router };
}

async function serve(router) {
  const app = express();
  app.use(helmet()); // defaults set CSP and CORP; the media route must override them
  app.use((req, res, next) => {
    const u = req.headers['x-test-user'];
    req.isAuthenticated = () => !!u;
    req.user = u ? { id: u } : undefined;
    next();
  });
  app.use(router);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
    return undefined;
  });
}

function req(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

// A hand-written request, so header lines can be repeated and capitalised freely
// (Node's http client would merge repeated names). Returns the status code only.
function rawStatus(server, path, headerLines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(server.address().port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.setTimeout(5000, () => sock.destroy(new Error('raw request timed out')));
    sock.on('data', (d) => { data += d; });
    sock.on('close', () => resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(data) || [])[1])));
    sock.on('error', reject);
    sock.write(`GET ${path} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\nConnection: close\r\n\r\n`);
  });
}

const throwsFor = (env) => { try { loadStack(env); return null; } catch (e) { return String(e.message); } };

// Fixture creators take the database handle explicitly (knex or a transaction) and
// record every id they create.
async function mkUser(tag, suffix = EMAIL_SUFFIX, db = knex) {
  const [u] = await db('users').insert({
    email: `${tag}-${RUN}${suffix}`,
    username: `mpg${tag.slice(0, 3)}${RUN}`,
    password_hash: 'x',
  }).returning('id');
  created.users.push(u.id);
  return u.id;
}
async function mkCampaign(name, ownerId, db = knex) {
  const [c] = await db('campaigns').insert({ name, owner_id: ownerId }).returning('id');
  const id = c.id || c;
  created.campaigns.push(id);
  return id;
}
async function mkAsset(fields, db = knex) {
  const [a] = await db('assets').insert({
    url: 'u', kind: 'map', status: 'ready', mime: 'image/png', bytes: 100, bytes_verified: true, ...fields,
  }).returning('id');
  const id = a.id || a;
  created.assets.push(id);
  return id;
}

async function initLedger() {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0, class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"), period_end: knex.raw("now() + interval '29 days'"),
  });
}

// Removes ONLY rows carrying this suite's markers, using the handle it is given
// (knex, or the transaction of the cleanup-boundary block). Each subquery is rebuilt
// per statement because query builders are single-use.
const ownCampaigns = (db = knex) => db('campaigns')
  .whereRaw('left(name, ?) = ?', [MARKER.length, MARKER])
  .select('id');
const ownUsers = (db = knex) => db('users')
  .whereRaw('right(email, ?) = ?', [EMAIL_SUFFIX.length, EMAIL_SUFFIX])
  .select('id');
async function removeOwnRows(db = knex) {
  await db('assets').whereIn('campaign_id', ownCampaigns(db)).orWhereIn('user_id', ownUsers(db)).del();
  await db('campaign_members').whereIn('campaign_id', ownCampaigns(db)).del();
  await db('campaigns').whereIn('id', ownCampaigns(db)).del();
  await db('users').whereIn('id', ownUsers(db)).del();
}
const countOwnRows = async () => {
  const c = await ownCampaigns(); const u = await ownUsers();
  const a = await knex('assets').whereIn('campaign_id', ownCampaigns()).orWhereIn('user_id', ownUsers()).select('id');
  return c.length + u.length + a.length;
};
// Exact-id removal and check of everything this suite created, marked or not.
async function removeCreatedById() {
  await knex('assets').whereIn('id', created.assets).del();
  await knex('campaign_members').whereIn('campaign_id', created.campaigns).del();
  await knex('campaigns').whereIn('id', created.campaigns).del();
  await knex('users').whereIn('id', created.users).del();
}
async function countCreatedRemaining() {
  const n = async (table, ids) => Number((await knex(table).whereIn('id', ids).count({ n: '*' }).first()).n);
  return (await n('assets', created.assets)) + (await n('campaigns', created.campaigns)) + (await n('users', created.users));
}

// --- the tests -------------------------------------------------------------
async function runTests() {
  await initLedger();
  await removeOwnRows(); // leftovers of an interrupted earlier run of THIS suite only

  console.log('\n--- cleanup is narrow: only marked rows are removed (in a transaction that is always rolled back) ---');
  {
    const ROLLBACK = new Error('intentional rollback of the cleanup-boundary block');
    try {
      await knex.transaction(async (trx) => {
        // What an interrupted run would have left behind, then look-alikes that must survive.
        const leftoverUser = await mkUser('left', EMAIL_SUFFIX, trx);
        const leftoverCampaign = await mkCampaign(`${MARKER}${RUN}`, leftoverUser, trx);
        const leftoverAsset = await mkAsset({ campaign_id: leftoverCampaign, user_id: leftoverUser, storage_key: `c/mpg-${RUN}/map/left.png` }, trx);
        const lookalikeOwner = await mkUser('decoy', LOOKALIKE_EMAIL_DOMAIN, trx); // a similar email domain
        const lookalikeUser = await mkUser('look', `${EMAIL_SUFFIX}.example`, trx); // starts like the marker domain
        const lookalikeCampaigns = [];
        for (const name of [`x${MARKER}${RUN}`, `${MARKER.toUpperCase()}${RUN}`, `${MARKER.slice(0, -2)}${RUN}`, `${LOOKALIKE_NAME}${RUN}`]) {
          lookalikeCampaigns.push(await mkCampaign(name, lookalikeUser, trx));
        }

        await removeOwnRows(trx); // the same transaction as every statement above and below

        t('a marked leftover campaign and its asset are removed',
          (await trx('campaigns').where({ id: leftoverCampaign }).first()) === undefined
          && (await trx('assets').where({ id: leftoverAsset }).first()) === undefined);
        t('a marked leftover user is removed', (await trx('users').where({ id: leftoverUser }).first()) === undefined);
        const survivors = await trx('campaigns').whereIn('id', lookalikeCampaigns).select('id');
        t('campaigns with the marker in the middle, in another case, truncated, or sharing only its prefix survive',
          survivors.length === 4, `survivors=${survivors.length}`);
        t('users whose emails only resemble the marker domain survive',
          (await trx('users').whereIn('id', [lookalikeOwner, lookalikeUser]).select('id')).length === 2);
        throw ROLLBACK; // always: nothing in this block is ever committed
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    t('the block committed nothing: none of the rows it created exist', created.users.length > 0 && (await countCreatedRemaining()) === 0);
  }

  const owner2 = await mkUser('owner');
  const cid = await mkCampaign(`${MARKER}${RUN}`, owner2);
  const mk2 = (extra) => mkAsset({
    campaign_id: cid, user_id: owner2, storage_key: `c/mpg-${RUN}/map/${crypto.randomBytes(4).toString('hex')}.png`, ...extra,
  });
  const ready = await mk2({});
  const pending = await mk2({ status: 'pending' });
  const noKey = await mk2({ storage_key: null });

  // ---------------------------------------------------------------- host mode
  console.log('\n--- host mode (no proxy secret): today\'s behaviour is unchanged ---');
  {
    const { gw, router } = loadStack({ MEDIA_HOST: 'media.test', MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET });
    const server = await serve(router);
    const tok = gw.mintMediaToken({ assetId: ready, viewerId: owner2 });
    const path = `/media/${ready}?t=${tok}`;
    gw._cacheClear(); getCount = 0;
    const onMedia = await req(server, path, { Host: 'media.test:3001' });
    t('host mode: valid token on the media host serves the image', onMedia.status === 200 && onMedia.body.equals(PNG), `got ${onMedia.status}`);
    t('host mode: served with nosniff', onMedia.headers['x-content-type-options'] === 'nosniff');
    t('host mode: media CSP overrides the helmet default', onMedia.headers['content-security-policy'] === "default-src 'none'; sandbox");
    t('host mode: CORP is cross-origin, overriding helmet', onMedia.headers['cross-origin-resource-policy'] === 'cross-origin');
    t('host mode: private cache window', onMedia.headers['cache-control'] === 'private, max-age=300');
    t('host mode: no cookie is set', onMedia.headers['set-cookie'] === undefined);
    t('host mode: the app host is refused (404)', (await req(server, path, { Host: 'app.test' })).status === 404);
    t('host mode: a proxy header is ignored, not honoured', (await req(server, path, { Host: 'app.test', 'X-Media-Proxy-Auth': PROXY_SECRET })).status === 404);
    t('host mode: token endpoint refuses on the media host (400)', (await req(server, `/api/media/${ready}/token`, { Host: 'media.test', 'X-Test-User': owner2 })).status === 400);
    const minted = await req(server, `/api/media/${ready}/token`, { Host: 'app.test', 'X-Test-User': owner2 });
    t('host mode: token endpoint mints on the app host', minted.status === 200 && /\/media\//.test(JSON.parse(minted.body).url));
    await closeServer(server);

    const blank = loadStack({ MEDIA_HOST: 'media.test', MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET, MEDIA_PROXY_SECRET: '' });
    const blankServer = await serve(blank.router);
    const blankTok = blank.gw.mintMediaToken({ assetId: ready, viewerId: owner2 });
    t('a blank MEDIA_PROXY_SECRET (as in .env.example) means host mode',
      (await req(blankServer, `/media/${ready}?t=${blankTok}`, { Host: 'media.test' })).status === 200
      && (await req(blankServer, `/media/${ready}?t=${blankTok}`, { Host: 'app.test' })).status === 404);
    await closeServer(blankServer);
  }

  // -------------------------------------------------------------- proxy mode
  console.log('\n--- proxy mode: the secret header replaces the Host check ---');
  {
    const { gw, router } = loadStack({ MEDIA_HOST: WORKER_HOST, MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET, MEDIA_PROXY_SECRET: PROXY_SECRET });
    const server = await serve(router);
    const tokFor = (id) => gw.mintMediaToken({ assetId: id, viewerId: owner2 });
    const path = `/media/${ready}?t=${tokFor(ready)}`;
    const good = { Host: APP_HOST, 'X-Media-Proxy-Auth': PROXY_SECRET };

    console.log('  (proxy authentication)');
    gw._cacheClear(); getCount = 0;
    const ok = await req(server, path, good);
    t('proxy mode: valid header and token serve the image', ok.status === 200 && ok.body.equals(PNG), `got ${ok.status}`);
    t('proxy mode: nosniff, media CSP, CORP, private cache, ETag',
      ok.headers['x-content-type-options'] === 'nosniff' && ok.headers['content-security-policy'] === "default-src 'none'; sandbox"
      && ok.headers['cross-origin-resource-policy'] === 'cross-origin' && ok.headers['cache-control'] === 'private, max-age=300'
      && ok.headers.etag === '"etag1"');
    t('proxy mode: the response declares Content-Length equal to the body (what the Worker relies on)',
      ok.headers['content-length'] === String(PNG.length) && ok.headers['transfer-encoding'] === undefined);
    t('proxy mode: the secret is never echoed in any response header', !JSON.stringify(ok.headers).includes(PROXY_SECRET));
    t('proxy mode: no cookie is set', ok.headers['set-cookie'] === undefined);
    t('proxy mode: no header is a 404, like a wrong host today', (await req(server, path, { Host: APP_HOST })).status === 404);
    t('proxy mode: a wrong secret is 404', (await req(server, path, { ...good, 'X-Media-Proxy-Auth': `${PROXY_SECRET}x` })).status === 404);
    t('proxy mode: a truncated secret is 404', (await req(server, path, { ...good, 'X-Media-Proxy-Auth': PROXY_SECRET.slice(0, -1) })).status === 404);
    t('proxy mode: an empty secret is 404', (await req(server, path, { ...good, 'X-Media-Proxy-Auth': '' })).status === 404);
    t('proxy mode: a different-case secret is 404 (values match exactly)', (await req(server, path, { ...good, 'X-Media-Proxy-Auth': PROXY_SECRET.toUpperCase() })).status === 404);
    t('proxy mode: the exact old Host, without the header, admits nothing', (await req(server, path, { Host: WORKER_HOST })).status === 404);
    t('proxy mode: the media Host in another case, without the header, is still 404 (no Host fallback)', (await req(server, path, { Host: WORKER_HOST.toUpperCase() })).status === 404);
    t('proxy mode: Host is ignored when the secret is right', (await req(server, path, { 'X-Media-Proxy-Auth': PROXY_SECRET, Host: 'anything.example' })).status === 200);
    t('proxy mode: the header name matches in any capitalisation', (await rawStatus(server, path, [`Host: ${APP_HOST}`, `X-MEDIA-PROXY-AUTH: ${PROXY_SECRET}`])) === 200);

    console.log('  (duplicate proxy headers are refused outright)');
    const H = (name, value) => `${name}: ${value}`;
    t('two identical correct headers are 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', PROXY_SECRET), H('X-Media-Proxy-Auth', PROXY_SECRET)])) === 404);
    t('two correct headers with mixed-case names are 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', PROXY_SECRET), H('x-media-proxy-auth', PROXY_SECRET)])) === 404);
    t('first wrong, second right is 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', 'wrong'), H('x-media-proxy-auth', PROXY_SECRET)])) === 404);
    t('first right, second wrong is 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('x-media-proxy-auth', PROXY_SECRET), H('X-MEDIA-PROXY-AUTH', 'wrong')])) === 404);
    t('a correct header plus an empty one is 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', PROXY_SECRET), 'X-Media-Proxy-Auth:'])) === 404);
    t('three headers in three capitalisations are 404', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', PROXY_SECRET), H('x-media-proxy-auth', PROXY_SECRET), H('X-MEDIA-PROXY-AUTH', PROXY_SECRET)])) === 404);
    t('the request line still works with a single header (control)', (await rawStatus(server, path, [`Host: ${APP_HOST}`, H('X-Media-Proxy-Auth', PROXY_SECRET)])) === 200);

    console.log('  (asset authorization is unchanged behind the proxy)');
    t('proxy mode: a missing token is 403', (await req(server, `/media/${ready}`, good)).status === 403);
    t('proxy mode: a repeated t parameter is 403', (await req(server, `/media/${ready}?t=${tokFor(ready)}&t=${tokFor(ready)}`, good)).status === 403);
    t('proxy mode: a forged token is 403', (await req(server, `/media/${ready}?t=${tokFor(ready)}x`, good)).status === 403);
    t('proxy mode: a token for another asset is 403', (await req(server, `/media/${ready}?t=${tokFor(pending)}`, good)).status === 403);
    const expiredPayload = `${ready}.${owner2}.${Math.floor(Date.now() / 1000) - 10}`;
    const expired = `${Buffer.from(expiredPayload).toString('base64url')}.${crypto.createHmac('sha256', TOKEN_SECRET).update(expiredPayload).digest('base64url')}`;
    t('proxy mode: an expired token is 403', (await req(server, `/media/${ready}?t=${expired}`, good)).status === 403);
    t('proxy mode: a valid token for a pending asset is 404', (await req(server, `/media/${pending}?t=${tokFor(pending)}`, good)).status === 404);
    t('proxy mode: a valid token for an asset with no storage key is 404', (await req(server, `/media/${noKey}?t=${tokFor(noKey)}`, good)).status === 404);
    const doomed = await mk2({});
    const doomedPath = `/media/${doomed}?t=${tokFor(doomed)}`;
    t('proxy mode: an asset serves before deletion', (await req(server, doomedPath, good)).status === 200);
    await knex('assets').where({ id: doomed }).del(); // the app deletes the row
    t('proxy mode: the same still-valid token is 404 after deletion (live row check; a request that reaches the origin)', (await req(server, doomedPath, good)).status === 404);

    console.log('  (metering and cache are unchanged behind the proxy)');
    await initLedger(); gw._cacheClear(); getCount = 0;
    await req(server, path, good);
    let snap = await budget.snapshot();
    t('proxy mode: a cache miss makes one R2 read and charges one Class B', getCount === 1 && snap.class_b.used === 1, `gets=${getCount} used=${snap.class_b.used}`);
    await req(server, path, good);
    snap = await budget.snapshot();
    t('proxy mode: a cache hit makes no R2 read and charges nothing', getCount === 1 && snap.class_b.used === 1);
    gw._cacheClear(); getCount = 0;
    const bCeil = budget.LIMITS.maxClassB - budget.LIMITS.maintClassB;
    await knex('storage_budget').where({ id: true }).update({ class_b_used: bCeil });
    const refused = await req(server, path, good);
    t('proxy mode: an exhausted budget is 429 with Retry-After and no R2 read',
      refused.status === 429 && refused.headers['retry-after'] === '3600' && getCount === 0, `status=${refused.status} gets=${getCount}`);
    t('proxy mode: the 429 body is the fixed budget message', JSON.parse(refused.body).error === 'read_budget_reached');
    await initLedger();

    console.log('  (the token endpoint)');
    t('proxy mode: the token endpoint mints for a browser (no proxy header)', (await req(server, `/api/media/${ready}/token`, { 'X-Test-User': owner2 })).status === 200);
    t('proxy mode: the token endpoint refuses when the proxy header is present (400)', (await req(server, `/api/media/${ready}/token`, { 'X-Test-User': owner2, 'X-Media-Proxy-Auth': PROXY_SECRET })).status === 400);
    t('proxy mode: the token endpoint still requires a session (401)', (await req(server, `/api/media/${ready}/token`, {})).status === 401);
    const mintedUrl = JSON.parse((await req(server, `/api/media/${ready}/token`, { 'X-Test-User': owner2 })).body).url;
    t('proxy mode: minted URLs point at the Worker host over HTTPS', new URL(mintedUrl).host === WORKER_HOST && new URL(mintedUrl).protocol === 'https:', mintedUrl);
    await closeServer(server);
  }

  // A secret that itself contains ", ": Node's parsed headers would turn two
  // headers into exactly this string. The explicit duplicate check must still refuse.
  console.log('\n--- a secret containing ", " cannot be forged by two headers ---');
  {
    const { gw, router } = loadStack({ MEDIA_HOST: WORKER_HOST, MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET, MEDIA_PROXY_SECRET: COMMA_SECRET });
    const server = await serve(router);
    const path = `/media/${ready}?t=${gw.mintMediaToken({ assetId: ready, viewerId: owner2 })}`;
    const [partOne, partTwo] = COMMA_SECRET.split(', ');
    t('a single header carrying the whole secret is accepted', (await rawStatus(server, path, [`Host: ${APP_HOST}`, `X-Media-Proxy-Auth: ${COMMA_SECRET}`])) === 200);
    t('two headers whose joined text equals the secret are refused',
      (await rawStatus(server, path, [`Host: ${APP_HOST}`, `X-Media-Proxy-Auth: ${partOne}`, `x-media-proxy-auth: ${partTwo}`])) === 404);
    await closeServer(server);
  }

  // -------------------------------------------------- configuration safety
  console.log('\n--- configuration is validated at load; gateway off means off ---');
  {
    const base = { MEDIA_HOST: WORKER_HOST, MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET };
    const shortMsg = throwsFor({ ...base, MEDIA_PROXY_SECRET: 'short' });
    t('a short proxy secret refuses to load', /at least 32/.test(shortMsg || ''), String(shortMsg));
    t('the short-secret refusal does not print the secret', !String(shortMsg).includes('short'));

    const sameTokenMsg = throwsFor({ ...base, MEDIA_PROXY_SECRET: TOKEN_SECRET });
    t('a proxy secret equal to MEDIA_TOKEN_SECRET refuses to load', /media token secret/.test(sameTokenMsg || ''), String(sameTokenMsg));
    t('that refusal does not print the secret', !String(sameTokenMsg).includes(TOKEN_SECRET));

    const sameSessionMsg = throwsFor({ ...base, MEDIA_PROXY_SECRET: SESSION_SECRET });
    t('a proxy secret equal to SESSION_SECRET refuses to load (token secret set separately)', /SESSION_SECRET/.test(sameSessionMsg || ''), String(sameSessionMsg));
    t('that refusal does not print the secret', !String(sameSessionMsg).includes(SESSION_SECRET));

    const fallbackMsg = throwsFor({ MEDIA_HOST: WORKER_HOST, SESSION_SECRET, MEDIA_PROXY_SECRET: SESSION_SECRET });
    t('with no MEDIA_TOKEN_SECRET the token secret resolves to SESSION_SECRET, and an equal proxy secret is refused as the media token secret', /media token secret/.test(fallbackMsg || ''), String(fallbackMsg));

    t('three distinct secrets load', throwsFor({ ...base, MEDIA_PROXY_SECRET: PROXY_SECRET }) === null);

    const { gw, router } = loadStack({ MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET, MEDIA_PROXY_SECRET: PROXY_SECRET });
    const server = await serve(router);
    const tok = gw.mintMediaToken({ assetId: ready, viewerId: owner2 });
    t('no MEDIA_HOST: the gateway is off even with a correct proxy header (404)', (await req(server, `/media/${ready}?t=${tok}`, { 'X-Media-Proxy-Auth': PROXY_SECRET })).status === 404);
    await closeServer(server);
  }
}

// --- teardown, and proof that it restored everything ------------------------
async function teardown() {
  const errors = [];
  const step = async (fn) => { try { await fn(); } catch (e) { errors.push(e.message); } };
  await step(() => Promise.all(servers.map(closeServer)));
  await step(() => removeOwnRows());
  await step(removeCreatedById); // exact ids, so unmarked fixtures are covered too
  await step(async () => {
    if (ledgerBefore) {
      const { id, ...columns } = ledgerBefore; // eslint-disable-line no-unused-vars
      await knex('storage_budget').where({ id: true }).update(columns);
    }
  });
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  storage.getObject = originalGetObject;
  storage.isConfigured = originalIsConfigured;
  for (const [k, v] of savedCache) { if (v === undefined) delete require.cache[k]; else require.cache[k] = v; }
  return errors;
}

async function main() {
  let crashed = null;
  try {
    if (!(await knex('storage_budget').where({ id: true }).first())) throw new Error('run migrations first');
    ledgerBefore = await knex('storage_budget').where({ id: true }).first();
    await runTests();
  } catch (e) {
    crashed = e;
  } finally {
    const errors = await teardown();
    console.log('\n--- teardown restored everything this suite touched ---');
    t('teardown completed without errors', errors.length === 0, errors.join('; '));
    t('environment variables are restored', ENV_KEYS.every((k) => process.env[k] === savedEnv[k]));
    t('storage stubs are restored', storage.getObject === originalGetObject && storage.isConfigured === originalIsConfigured);
    t('module cache entries are restored', [...savedCache].every(([k, v]) => require.cache[k] === v));
    t('every listener is closed', servers.length > 0 && servers.every((s) => !s.listening));
    t('no row carrying this suite\'s markers remains', (await countOwnRows().catch(() => -1)) === 0);
    t('no fixture this suite created remains, marked or not (checked by recorded id)',
      created.users.length > 0 && created.campaigns.length > 0 && created.assets.length > 0 && (await countCreatedRemaining().catch(() => -1)) === 0);
    const ledgerAfter = await knex('storage_budget').where({ id: true }).first().catch(() => null);
    t('the budget ledger row is restored exactly', ledgerBefore !== null && JSON.stringify(ledgerAfter) === JSON.stringify(ledgerBefore));
    await knex.destroy();
    if (crashed) { console.log('crashed:', crashed); fail += 1; }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
}

main();
