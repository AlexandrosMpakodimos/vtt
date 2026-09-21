// Worker-to-router integration check (LOCAL; NOT deployment evidence).
//
//   npm run test:integration        (from workers/media-proxy/, after `npm ci` here AND at the repository root)
//
// What runs for real: the Worker source (src/index.js), in Node and in workerd; the app's real
// src/routes/media.js router with the merged proxy gate; real Postgres fixtures.
// What is stubbed or synthetic: object storage (storage.getObject returns fixed bytes and a read
// counter), every secret (fixed, obviously synthetic strings), and the network: the Worker's HTTPS
// upstream is mapped to a loopback listener. No Render, no Cloudflare edge, no TLS, no real Host
// forwarding, no sleeping service. Those are deployment-only checks and stay unresolved.
//
// SAFETY. NODE_ENV is forced to "test" before any app module loads, so the app's knexfile refuses
// everything except the dedicated local `vtt_test` database and `vtt_test_runner` role, and never
// falls back to DATABASE_URL. If that configuration is missing the test FAILS; it never skips.
// It does not use the isolated test server.
//
// FIXTURE OWNERSHIP AND RECOVERY. Committed rows are marked:
//   campaigns  name starts with   __vtt_media_worker_integration__
//   users      email ends with    @media-worker-integration.invalid
// Startup removes only marked rows left by an interrupted earlier run. This suite is not registered,
// but leftover assets would still make the registered test-assets suite refuse to start. After an
// interruption run `npm run test:integration` once, or use the SQL in docs/testing.md.
//
// LIFECYCLE. Setup records what it has actually created, step by step. Teardown then closes exactly
// those resources, guards every database operation individually, and ALWAYS restores local state
// (environment, console methods, module-cache entries, installed storage stubs), even when setup or
// the database cleanup failed. A setup failure stays the reported failure; teardown adds a failure
// of its own only if it could not clean up, and then carries the setup failure as its cause.
//
// FAILURE CHECKS. The last suite in this file re-runs this same file as a child process, without
// the runner's forced exit, with (1) a real configuration rejection before Knex is assigned,
// (2) an injected failure after the pool exists, (3) an injected failure after the listener and
// fixtures exist, and (4) an injected failure in the database cleanup. Each child must exit nonzero
// by itself, report that local state was restored and that everything it created was closed, and
// leave the original failure visible in its output. The injections are inert unless the variables
// below are set, and they are refused outside a child run:
//   VTT_WORKER_INTEGRATION_CHILD=1   VTT_WORKER_INTEGRATION_REPORT=1
//   VTT_WORKER_INTEGRATION_FAULT=after-pool | after-fixtures | cleanup-db

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createHandler } from '../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..', '..');
const appRoot = path.resolve(workerRoot, '..', '..');
const appRequire = createRequire(path.join(appRoot, 'package.json'));

const MARKER = '__vtt_media_worker_integration__';
const EMAIL_SUFFIX = '@media-worker-integration.invalid';
const RUN = crypto.randomBytes(4).toString('hex');

// Synthetic credentials. None of these is, or resembles, a real secret.
const TOKEN_SECRET = 'integration-synthetic-token-secret-000000000000';
const SESSION_SECRET = 'integration-synthetic-session-secret-00000000000';
const PROXY_SECRET = 'integration-synthetic-PROXY-secret-0000000000000';
const WRONG_PROXY_SECRET = 'integration-synthetic-WRONG-secret-000000000000000';
const WORKER_HOST = 'vtt-media.integration.workers.dev';
const UPSTREAM = 'https://vtt-app.integration.onrender.com';
const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64 * 1024, 7)]);

const ENV_KEYS = ['NODE_ENV', 'MEDIA_HOST', 'MEDIA_ORIGIN', 'MEDIA_PROXY_SECRET', 'MEDIA_TOKEN_SECRET', 'SESSION_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const APP_MODULES = ['./src/services/mediaGateway.js', './src/routes/media.js'].map((p) => appRequire.resolve(p));
const savedCache = new Map(APP_MODULES.map((k) => [k, appRequire.cache[k]]));
const created = { users: [], campaigns: [], assets: [] };
const consoleCalls = [];
const workerdOutput = { good: '', wrong: '' };
const workerdOutbound = [];
const nodeOutbound = [];
const routerSeen = [];

let knex; let storage; let budget; let gw; let router;
let originalGetObject; let originalIsConfigured; let ledgerBefore = null;
let server; let getCount = 0;
let mfGood; let mfWrong;
let owner; let readyId; let pendingId; let doomedId;
let nodeHandlerGood; let nodeHandlerWrong;
const originalConsole = {};

// --- lifecycle state: what has actually been created --------------------------------
const IS_CHILD = process.env.VTT_WORKER_INTEGRATION_CHILD === '1';
const WANT_REPORT = process.env.VTT_WORKER_INTEGRATION_REPORT === '1';
const FAULT = process.env.VTT_WORKER_INTEGRATION_FAULT || '';
const FAULTS = ['', 'after-pool', 'after-fixtures', 'cleanup-db'];
const state = { consoleReplaced: false, envChanged: false, knexCreated: false, stubsInstalled: false, ledgerSnapshotted: false };
let setupError = null;
let teardownOutcome = null;

// --- helpers -----------------------------------------------------------------
const rawGet = (port, pathAndQuery, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on('error', reject);
  r.end();
});

const ownCampaigns = () => knex('campaigns').whereRaw('left(name, ?) = ?', [MARKER.length, MARKER]).select('id');
const ownUsers = () => knex('users').whereRaw('right(email, ?) = ?', [EMAIL_SUFFIX.length, EMAIL_SUFFIX]).select('id');
async function removeMarkedRows() {
  await knex('assets').whereIn('campaign_id', ownCampaigns()).orWhereIn('user_id', ownUsers()).del();
  await knex('campaign_members').whereIn('campaign_id', ownCampaigns()).del();
  await knex('campaigns').whereIn('id', ownCampaigns()).del();
  await knex('users').whereIn('id', ownUsers()).del();
}
async function removeCreatedById() {
  await knex('assets').whereIn('id', created.assets).del();
  await knex('campaign_members').whereIn('campaign_id', created.campaigns).del();
  await knex('campaigns').whereIn('id', created.campaigns).del();
  await knex('users').whereIn('id', created.users).del();
}
async function countRemaining() {
  const n = async (table, ids) => Number((await knex(table).whereIn('id', ids).count({ n: '*' }).first()).n);
  return (await n('assets', created.assets)) + (await n('campaigns', created.campaigns)) + (await n('users', created.users));
}
async function initLedger() {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0, class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"), period_end: knex.raw("now() + interval '29 days'"),
  });
}
async function mkAsset(fields) {
  const [a] = await knex('assets').insert({
    campaign_id: created.campaigns[0], user_id: owner, url: 'u', kind: 'map', status: 'ready', mime: 'image/png',
    bytes: IMAGE.length, bytes_verified: true, storage_key: `c/mwi-${RUN}/map/${crypto.randomBytes(4).toString('hex')}.png`, ...fields,
  }).returning('id');
  const id = a.id || a;
  created.assets.push(id);
  return id;
}

// One client per runtime, each talking to the same real router through its own network shim.
const ROUTER_PORT = () => server.address().port;
const localUrl = (u) => `http://127.0.0.1:${ROUTER_PORT()}${u.pathname}${u.search}`;

function nodeShim() {
  return async (input, init) => {
    const u = new URL(input);
    assert.equal(u.origin, UPSTREAM, 'the Worker must only ever call its configured HTTPS upstream');
    nodeOutbound.push({ url: String(input), init: { redirect: init.redirect, cache: init.cache, hasSignal: init.signal instanceof AbortSignal, method: init.method, headers: Object.fromEntries(new Headers(init.headers)) } });
    return fetch(localUrl(u), { method: init.method, headers: init.headers, redirect: init.redirect, signal: init.signal });
  };
}

function workerdFor(secret, sink) {
  return new Miniflare({
    modules: true,
    scriptPath: path.join(workerRoot, 'src', 'index.js'),
    compatibilityDate: '2026-01-01',
    bindings: { UPSTREAM_ORIGIN: UPSTREAM, MEDIA_PROXY_SECRET: secret },
    handleRuntimeStdio(stdout, stderr) {
      stdout.on('data', (d) => { workerdOutput[sink] += d; });
      stderr.on('data', (d) => { workerdOutput[sink] += d; });
    },
    outboundService: async (request) => {
      const u = new URL(request.url);
      assert.equal(u.origin, UPSTREAM, 'the Worker must only ever call its configured HTTPS upstream');
      const headers = Object.fromEntries(request.headers);
      workerdOutbound.push({ method: request.method, headers });
      delete headers.host;
      return fetch(localUrl(u), { method: request.method, headers, redirect: 'manual' });
    },
  });
}

// runtime: 'Node' | 'workerd'; wrong: use the Worker whose secret does not match the app's
const openResponses = [];
async function viaWorker(runtime, url, init = {}, { wrong = false } = {}) {
  routerSeen.length = 0;
  const res = runtime === 'Node'
    ? await (wrong ? nodeHandlerWrong : nodeHandlerGood)(new Request(url, init), wrong ? { UPSTREAM_ORIGIN: UPSTREAM, MEDIA_PROXY_SECRET: WRONG_PROXY_SECRET } : { UPSTREAM_ORIGIN: UPSTREAM, MEDIA_PROXY_SECRET: PROXY_SECRET })
    : await (wrong ? mfWrong : mfGood).dispatchFetch(url, init);
  openResponses.push(res);
  return res;
}
const mediaUrl = (id, token) => `https://${WORKER_HOST}/media/${id}?t=${token}`;
const tokenFor = (id) => gw.mintMediaToken({ assetId: id, viewerId: owner });
const FORBIDDEN = ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for', 'cf-connecting-ip'];
const WORKER_HEADERS = ['accept', 'accept-encoding', 'user-agent', 'x-media-proxy-auth', 'if-none-match'];
// Added by the workerd runtime itself, not by the Worker's code: `cache: 'no-store'` becomes
// Cache-Control: no-cache and Pragma: no-cache (per the Fetch specification), and cf-worker identifies
// the calling Worker. None of them carries a client value or a secret.
const RUNTIME_ADDED = { 'cache-control': 'no-cache', pragma: 'no-cache' };


// --- setup and teardown --------------------------------------------------------
async function setup() {
  if (!FAULTS.includes(FAULT)) throw new Error(`unknown VTT_WORKER_INTEGRATION_FAULT "${FAULT}"`);
  if (FAULT && !IS_CHILD) throw new Error('fault injection is reserved for the failure checks');

  for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    originalConsole[k] = console[k];
    console[k] = (...a) => { consoleCalls.push(a.map(String).join(' ')); };
  }
  state.consoleReplaced = true;

  process.env.NODE_ENV = 'test'; // before any app module loads: the knexfile then allows only the dedicated test database
  state.envChanged = true;
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  Object.assign(process.env, { MEDIA_HOST: WORKER_HOST, MEDIA_TOKEN_SECRET: TOKEN_SECRET, SESSION_SECRET, MEDIA_PROXY_SECRET: PROXY_SECRET });

  // If the knexfile rejects the configuration this throws and `knex` stays unassigned: there is no pool to close.
  const db = appRequire('./src/db');
  knex = db;
  state.knexCreated = true;

  storage = appRequire('./src/services/storage');
  budget = appRequire('./src/services/storageBudget');
  originalGetObject = storage.getObject;
  originalIsConfigured = storage.isConfigured;
  storage.getObject = async () => { getCount += 1; return { bytes: IMAGE, mime: 'image/png', etag: 'etag-int' }; };
  storage.isConfigured = () => true;
  state.stubsInstalled = true;

  for (const k of APP_MODULES) delete appRequire.cache[k];
  gw = appRequire('./src/services/mediaGateway');
  ({ router } = appRequire('./src/routes/media'));

  if (!(await knex('storage_budget').where({ id: true }).first())) throw new Error('run migrations for the test database first');
  ledgerBefore = await knex('storage_budget').where({ id: true }).first();
  state.ledgerSnapshotted = true;
  await initLedger();
  await removeMarkedRows(); // leftovers of an interrupted earlier run of THIS suite only

  if (FAULT === 'after-pool') throw new Error('injected fault after pool creation');

  const express = appRequire('express');
  const helmet = appRequire('helmet');
  const app = express();
  app.use(helmet());
  app.use((req, res, next) => {
    routerSeen.push({ method: req.method, url: req.originalUrl, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] });
    const u = req.headers['x-test-user'];
    req.isAuthenticated = () => !!u;
    req.user = u ? { id: u } : undefined;
    next();
  });
  app.use(router);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const [u] = await knex('users').insert({ email: `owner-${RUN}${EMAIL_SUFFIX}`, username: `mwi${RUN}`, password_hash: 'x' }).returning('id');
  owner = u.id; created.users.push(owner);
  const [c] = await knex('campaigns').insert({ name: `${MARKER}${RUN}`, owner_id: owner }).returning('id');
  created.campaigns.push(c.id || c);
  readyId = await mkAsset({});
  pendingId = await mkAsset({ status: 'pending' });
  doomedId = await mkAsset({});

  if (FAULT === 'after-fixtures') throw new Error('injected fault after fixtures and listener');

  nodeHandlerGood = createHandler({ fetchImpl: nodeShim() });
  nodeHandlerWrong = createHandler({ fetchImpl: nodeShim() });
  mfGood = workerdFor(PROXY_SECRET, 'good');
  mfWrong = workerdFor(WRONG_PROXY_SECRET, 'wrong');
  await Promise.all([mfGood.ready, mfWrong.ready]);
}

// Restores local state. Synchronous and guarded item by item, so one failure cannot skip the rest.
function restoreLocalState(errors) {
  const guard = (name, fn) => { try { fn(); } catch (e) { errors.push(`restore ${name}: ${e.message}`); } };
  guard('environment', () => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });
  guard('console', () => { for (const k of Object.keys(originalConsole)) console[k] = originalConsole[k]; });
  guard('storage stubs', () => { if (state.stubsInstalled && storage) { storage.getObject = originalGetObject; storage.isConfigured = originalIsConfigured; } });
  guard('module cache', () => { for (const [k, v] of savedCache) { if (v === undefined) delete appRequire.cache[k]; else appRequire.cache[k] = v; } });
}

async function teardown() {
  const errors = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); } };
  const isDisposed = async (mf) => { try { await mf.dispatchFetch(`https://${WORKER_HOST}/`); return false; } catch { return true; } };
  let remaining = null; let ledgerAfter = null; let workerdClosed = null;
  try {
    await step('dispose workerd (matching secret)', async () => { if (mfGood) await mfGood.dispose(); });
    await step('dispose workerd (wrong secret)', async () => { if (mfWrong) await mfWrong.dispose(); });
    await step('check workerd is disposed', async () => {
      const made = [mfGood, mfWrong].filter(Boolean);
      if (made.length) workerdClosed = (await Promise.all(made.map(isDisposed))).every(Boolean);
    });
    await step('close the router listener', async () => {
      if (server && server.listening) await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    });
    if (state.knexCreated) {
      await step('remove marked rows', async () => {
        if (FAULT === 'cleanup-db') throw new Error('injected fault: database cleanup');
        await removeMarkedRows();
      });
      await step('remove recorded fixtures', removeCreatedById);
      await step('count remaining fixtures', async () => { remaining = await countRemaining(); });
      await step('restore the budget ledger row', async () => {
        if (state.ledgerSnapshotted && ledgerBefore) { const { id, ...columns } = ledgerBefore; await knex('storage_budget').where({ id: true }).update(columns); } // eslint-disable-line no-unused-vars
      });
      await step('read the budget ledger row', async () => { ledgerAfter = await knex('storage_budget').where({ id: true }).first(); });
      await step('close the database pool', async () => { await knex.destroy(); });
    }
  } finally {
    restoreLocalState(errors);
  }
  return {
    errors,
    remaining,
    checks: {
      environment: ENV_KEYS.every((k) => process.env[k] === savedEnv[k]),
      console: state.consoleReplaced ? Object.keys(originalConsole).every((k) => console[k] === originalConsole[k]) : null,
      storageStubs: state.stubsInstalled ? storage.getObject === originalGetObject && storage.isConfigured === originalIsConfigured : null,
      moduleCache: [...savedCache].every(([k, v]) => appRequire.cache[k] === v),
      listenerClosed: server ? !server.listening : null,
      workerdDisposed: workerdClosed,
      poolClosed: state.knexCreated ? !knex.client.pool : null,
      fixturesRemoved: state.knexCreated && remaining !== null ? remaining === 0 : null,
      ledgerRestored: state.ledgerSnapshotted && ledgerAfter ? JSON.stringify(ledgerAfter) === JSON.stringify(ledgerBefore) : null,
    },
  };
}

async function finishTeardown() {
  const result = await teardown();
  if (WANT_REPORT) {
    // Written after the console is restored, straight to stdout, for the failure checks to read.
    process.stdout.write(`TEARDOWN-REPORT ${JSON.stringify({
      fault: FAULT || null,
      setupFailed: !!setupError,
      setupError: setupError ? String(setupError.message) : null,
      created: { consoleReplaced: state.consoleReplaced, envChanged: state.envChanged, pool: state.knexCreated, stubs: state.stubsInstalled, listener: !!server, fixtures: created.users.length > 0, workerd: [!!mfGood, !!mfWrong] },
      checks: result.checks,
      fixturesRemaining: result.remaining,
      teardownErrors: result.errors,
    })}\n`);
  }
  const failedChecks = Object.entries(result.checks).filter(([, v]) => v === false).map(([k]) => k);
  teardownOutcome = { errors: result.errors, failedChecks };
  // A failing after-hook alone does not fail the runner's summary or exit code, so the outcome is
  // asserted by an ordinary test below, and the process is also marked failed here.
  if (result.errors.length || failedChecks.length) process.exitCode = 1;
}


describe('integration against the real media router', () => {
  before(async () => {
    try { await setup(); } catch (e) { setupError = e; process.exitCode = 1; throw e; } // run directly, a failing hook alone would not fail the process
  });
  after(finishTeardown);
  // A failed assertion can leave a response body unread; release it so a failing run ends instead of hanging.
  afterEach(async () => {
    for (const r of openResponses.splice(0)) {
      if (r.body && !r.bodyUsed) await r.body.cancel().catch(() => {});
    }
  });

  // --- the checks, run for the Worker in Node and in workerd --------------------------
  for (const runtime of ['Node', 'workerd']) {
    describe(`Worker (${runtime}) to the real media router`, () => {
      it('a valid token is served end to end with the reviewed response headers', async () => {
        await initLedger(); gw._cacheClear(); getCount = 0;
        const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)));
        assert.equal(res.status, 200);
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(IMAGE), '64 KiB streamed byte for byte');
        assert.equal(res.headers.get('content-type'), 'image/png');
        const declared = res.headers.get('content-length');
        if (runtime === 'Node') assert.equal(declared, String(IMAGE.length));
        // workerd sends a streamed GET without Content-Length (chunked). Absent is acceptable; wrong is not.
        else assert.ok(declared === null || declared === String(IMAGE.length), `content-length ${declared}`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
        assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
        assert.equal(res.headers.get('etag'), '"etag-int"');
        assert.equal(res.headers.get('set-cookie'), null);
      });

      it('the router sees one proxy-authenticated request and none of the browser headers', async () => {
        const hostile = { cookie: 'sid=victim', authorization: 'Bearer x', referer: 'https://app.example/', origin: 'https://app.example', 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9', 'x-media-proxy-auth': 'client-supplied-guess' };
        const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)), { headers: hostile });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
        assert.equal(routerSeen.length, 1);
        const seen = routerSeen[0];
        assert.equal(seen.headers['x-media-proxy-auth'], PROXY_SECRET, 'the Worker, not the client, supplies the proxy header');
        assert.equal(seen.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'x-media-proxy-auth').length, 1, 'exactly one proxy header reaches the gate');
        for (const h of FORBIDDEN) assert.equal(seen.headers[h], undefined, `${h} never reaches the router`);
        const sent = runtime === 'Node' ? nodeOutbound.at(-1).init : workerdOutbound.at(-1);
        const names = Object.keys(sent.headers).filter((h) => h !== 'host');
        const extra = names.filter((h) => !WORKER_HEADERS.includes(h));
        if (runtime === 'Node') assert.deepEqual(extra, [], `only allowlisted headers: ${names}`);
        else {
          assert.deepEqual(extra.sort(), ['cache-control', 'cf-worker', 'pragma'], `only allowlisted and runtime-added headers: ${names}`);
          for (const [h, v] of Object.entries(RUNTIME_ADDED)) assert.equal(sent.headers[h], v, `${h} is the runtime's no-store translation`);
        }
        assert.ok(names.includes('x-media-proxy-auth'));
        if (runtime === 'Node') {
          assert.equal(nodeOutbound.at(-1).init.redirect, 'manual');
          assert.equal(nodeOutbound.at(-1).init.cache, 'no-store');
          assert.equal(nodeOutbound.at(-1).init.hasSignal, true);
          assert.equal(nodeOutbound.at(-1).url, `${UPSTREAM}/media/${readyId}?t=${new URL(nodeOutbound.at(-1).url).searchParams.get('t')}`);
        }
      });

      it('HEAD returns the image headers and no body, and reaches the router as a read of the same asset', async () => {
        const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)), { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal((await res.arrayBuffer()).byteLength, 0);
        assert.equal(res.headers.get('content-type'), 'image/png');
        assert.equal(routerSeen.length, 1);
      });

      it('a forged token is 403 (forbidden) and reads nothing from storage', async () => {
        getCount = 0;
        const res = await viaWorker(runtime, mediaUrl(readyId, `${tokenFor(readyId)}x`));
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: 'forbidden' });
        assert.equal(getCount, 0);
      });

      it('a valid token for a pending asset is 404 (not_found)', async () => {
        const res = await viaWorker(runtime, mediaUrl(pendingId, tokenFor(pendingId)));
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: 'not_found' });
      });

      it('a still-valid token is 404 once the asset row is deleted (a request that reaches the origin)', async () => {
        const url = mediaUrl(doomedId, tokenFor(doomedId));
        const before = await viaWorker(runtime, url);
        assert.equal(before.status, 200);
        await before.arrayBuffer();
        await knex('assets').where({ id: doomedId }).del();
        const after = await viaWorker(runtime, url);
        assert.equal(after.status, 404);
        assert.equal(routerSeen.length, 1, 'the deleted-asset answer came from the router, not the Worker');
        // recreate for the other runtime's pass
        doomedId = await mkAsset({});
      });

      it('requests the Worker rejects never reach the router', async () => {
        const bad = [
          [`https://${WORKER_HOST}/media/${readyId}`, {}, 400],
          [`https://${WORKER_HOST}/media/${readyId}?t=short`, {}, 400],
          [`https://${WORKER_HOST}/media/${readyId}?t=${tokenFor(readyId)}&x=1`, {}, 400],
          [`https://${WORKER_HOST}/media/${readyId}/extra?t=${tokenFor(readyId)}`, {}, 404],
          [`https://${WORKER_HOST}/api/media/${readyId}/token`, {}, 404],
          [mediaUrl(readyId, tokenFor(readyId)), { method: 'POST', body: 'x' }, 405],
        ];
        for (const [url, init, status] of bad) {
          const res = await viaWorker(runtime, url, init);
          assert.equal(res.status, status, url);
          assert.equal(routerSeen.length, 0, `${init.method || 'GET'} ${url} was refused by the Worker itself`);
        }
      });

      it('an exhausted read budget is 429 (rate_limited) with Retry-After and no storage read', async () => {
        gw._cacheClear(); getCount = 0;
        await knex('storage_budget').where({ id: true }).update({ class_b_used: budget.LIMITS.maxClassB - budget.LIMITS.maintClassB });
        const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)));
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '3600');
        assert.deepEqual(await res.json(), { error: 'rate_limited' });
        assert.equal(getCount, 0);
        await initLedger();
      });

      it('metering and the cache are unchanged behind the Worker: one read and one Class B charge, then a cache hit', async () => {
        await initLedger(); gw._cacheClear(); getCount = 0;
        for (let i = 0; i < 2; i += 1) {
          const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)));
          assert.equal(res.status, 200);
          await res.arrayBuffer();
        }
        const snap = await budget.snapshot();
        assert.equal(getCount, 1);
        assert.equal(snap.class_b.used, 1);
      });

      it('a Worker holding the wrong proxy secret is refused by the gate (404) and nothing is read', async () => {
        gw._cacheClear(); getCount = 0;
        const res = await viaWorker(runtime, mediaUrl(readyId, tokenFor(readyId)), {}, { wrong: true });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: 'not_found' });
        assert.equal(getCount, 0);
        assert.equal(routerSeen.length, 1);
      });

      it('a URL minted by the real token endpoint works through the Worker', async () => {
        const minted = await rawGet(ROUTER_PORT(), `/api/media/${readyId}/token`, { 'x-test-user': owner });
        assert.equal(minted.status, 200);
        const { url } = JSON.parse(minted.body);
        const u = new URL(url);
        assert.equal(u.host, WORKER_HOST);
        assert.equal(u.protocol, 'https:');
        const res = await viaWorker(runtime, url);
        assert.equal(res.status, 200);
        await res.arrayBuffer();
      });

      it('the token endpoint still refuses when the proxy header is present (400), so the app origin cannot mint through the proxy path', async () => {
        const res = await rawGet(ROUTER_PORT(), `/api/media/${readyId}/token`, { 'x-test-user': owner, 'x-media-proxy-auth': PROXY_SECRET });
        assert.equal(res.status, 400);
      });
    });
  }

  describe('nothing sensitive is logged or echoed', () => {
    it('no token, secret or asset id appears in Node console output, workerd output or any response header', async () => {
      const token = tokenFor(readyId);
      const res = await viaWorker('Node', mediaUrl(readyId, token));
      await res.arrayBuffer();
      const resW = await viaWorker('workerd', mediaUrl(readyId, token));
      await resW.arrayBuffer();
      const headers = JSON.stringify([...res.headers]) + JSON.stringify([...resW.headers]);
      for (const secret of [PROXY_SECRET, WRONG_PROXY_SECRET, TOKEN_SECRET, SESSION_SECRET, token, readyId]) {
        assert.ok(!headers.includes(secret), 'not in response headers');
        assert.ok(!consoleCalls.join('\n').includes(secret), 'not in Node console output');
        assert.ok(!(workerdOutput.good + workerdOutput.wrong).includes(secret), 'not in workerd stdout or stderr');
      }
      assert.equal(consoleCalls.length, 0, `nothing was written to the console: ${consoleCalls.join(' | ')}`);
    });
  });

});

// Runs after the suite above and its after-hook. If setup failed, that failure is already reported by the
// cancelled tests; this test fails only if teardown itself could not clean up.
describe('teardown left nothing behind', () => {
  it('local state is restored, every created resource is closed, and no fixture remains', () => {
    assert.ok(teardownOutcome, 'the teardown ran');
    const note = setupError ? ` (setup had already failed: ${setupError.message})` : '';
    assert.deepEqual(teardownOutcome.errors, [], `teardown steps completed without errors${note}`);
    assert.deepEqual(teardownOutcome.failedChecks, [], `every teardown check holds${note}`);
  });
});

// --- teardown after failed or partial setup ------------------------------------------
// Re-runs THIS file as a child process with a fault. Without the runner's forced exit, a child that
// leaked a handle would hang and be killed by the timer below, which fails the check.
if (!IS_CHILD) {
  describe('teardown after failed or partial setup (child runs with a fault)', () => {
    const CHILD_LIMIT_MS = 60_000;
    const file = fileURLToPath(import.meta.url);
    const tempHomes = [];
    after(() => { for (const d of tempHomes) fs.rmSync(d, { recursive: true, force: true }); });

    function runChild({ fault, withoutTestConfig = false }) {
      const env = { ...process.env, VTT_WORKER_INTEGRATION_CHILD: '1', VTT_WORKER_INTEGRATION_REPORT: '1' };
      delete env.NODE_TEST_CONTEXT; // set by the test runner in its own children; it would make this child report through the runner and exit 0
      if (fault) env.VTT_WORKER_INTEGRATION_FAULT = fault;
      if (withoutTestConfig) {
        // A real rejection: no test URL, and a home directory with no vtt-test-config.env in it.
        delete env.TEST_DATABASE_URL;
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-worker-noconfig-'));
        tempHomes.push(home);
        env.HOME = home;
        env.USERPROFILE = home;
      }
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test-timeout=30000', file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_LIMIT_MS);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const m = /^TEARDOWN-REPORT (.*)$/m.exec(out);
          resolve({ code, signal, timedOut, out, report: m ? JSON.parse(m[1]) : null });
        });
      });
    }

    const commonAssertions = (res) => {
      assert.equal(res.timedOut, false, 'the child ended by itself: nothing it created was left open');
      assert.notEqual(res.code, 0, `the child exits nonzero (got ${res.code}, signal ${res.signal})`);
      assert.ok(res.report, 'the child reported on its teardown');
      assert.deepEqual(res.report.checks.environment, true, 'environment restored');
      assert.deepEqual(res.report.checks.console, true, 'console methods restored');
      assert.equal(res.report.checks.moduleCache, true, 'module-cache entries restored');
    };

    it('configuration rejection before Knex is assigned: exits nonzero, restores state, has nothing to close', async () => {
      const res = await runChild({ withoutTestConfig: true });
      commonAssertions(res);
      const r = res.report;
      assert.equal(r.setupFailed, true);
      assert.match(r.setupError, /Test database configuration refused/, 'the original failure is the one reported');
      assert.ok(res.out.includes('Test database configuration refused'), 'and it stays visible in the output');
      assert.deepEqual(r.created, { consoleReplaced: true, envChanged: true, pool: false, stubs: false, listener: false, fixtures: false, workerd: [false, false] }, 'no pool, stubs, listener, fixtures or workerd existed');
      assert.equal(r.checks.storageStubs, null);
      assert.equal(r.checks.poolClosed, null);
      assert.deepEqual(r.teardownErrors, [], 'teardown itself had nothing to complain about');
    });

    it('a failure after pool creation but before setup completes: exits nonzero, restores state, closes the pool', async () => {
      const res = await runChild({ fault: 'after-pool' });
      commonAssertions(res);
      const r = res.report;
      assert.equal(r.setupFailed, true);
      assert.match(r.setupError, /injected fault after pool creation/);
      assert.ok(res.out.includes('injected fault after pool creation'));
      assert.equal(r.created.pool, true);
      assert.equal(r.created.stubs, true);
      assert.equal(r.created.listener, false);
      assert.deepEqual(r.created.workerd, [false, false]);
      assert.equal(r.checks.storageStubs, true, 'the installed storage stubs were restored');
      assert.equal(r.checks.poolClosed, true, 'the pool was closed');
      assert.equal(r.checks.ledgerRestored, true, 'the budget ledger row was restored');
      assert.equal(r.fixturesRemaining, 0);
      assert.deepEqual(r.teardownErrors, []);
    });

    it('a failure after the listener and fixtures exist: exits nonzero, removes the fixtures, closes listener and pool', async () => {
      const res = await runChild({ fault: 'after-fixtures' });
      commonAssertions(res);
      const r = res.report;
      assert.equal(r.setupFailed, true);
      assert.match(r.setupError, /injected fault after fixtures and listener/);
      assert.equal(r.created.listener, true);
      assert.equal(r.created.fixtures, true);
      assert.deepEqual(r.created.workerd, [false, false]);
      assert.equal(r.checks.listenerClosed, true);
      assert.equal(r.checks.poolClosed, true);
      assert.equal(r.checks.storageStubs, true);
      assert.equal(r.fixturesRemaining, 0, 'the committed fixtures were removed');
      assert.deepEqual(r.teardownErrors, []);
    });

    it('a database cleanup failure after a complete setup: exits nonzero, still restores state and closes everything', async () => {
      const res = await runChild({ fault: 'cleanup-db' });
      commonAssertions(res);
      const r = res.report;
      assert.equal(r.setupFailed, false, 'setup succeeded and the checks ran');
      assert.deepEqual(r.created.workerd, [true, true]);
      assert.ok(r.teardownErrors.some((e) => e.includes('injected fault: database cleanup')), 'the cleanup failure is reported');
      assert.ok(res.out.includes('injected fault: database cleanup'));
      assert.equal(r.checks.storageStubs, true);
      assert.equal(r.checks.listenerClosed, true);
      assert.equal(r.checks.workerdDisposed, true);
      assert.equal(r.checks.poolClosed, true);
      assert.equal(r.fixturesRemaining, 0, 'the recorded-id removal still ran after the marker removal failed');
    });
  });
}
