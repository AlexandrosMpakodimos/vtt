// Stale-asset sweep vs. upload confirmation: atomicity, races and rollback.
//
// EXCLUSIVE vtt_test use only: stop other test processes and the dev:test server
// (its background maintenance uses the same production sweep), then run:
//   NODE_ENV=test SKIP_HIBP=1 node tests/integration/test-stale-asset-atomicity.js
//
// Against a real Postgres, no isolated test server. The confirm route is
// mounted directly (same technique as test-media-proxy-gate.js) with a stub
// authenticator, so an HTTP round trip drives the real handler. storage.js is
// stubbed (readHead, headSize, remove, isConfigured) so R2 behaviour and
// timing are deterministic and controllable — the property under test is the
// atomicity of cleanupStaleAssets() and the confirm route against each other
// and against themselves, not R2 itself. This mirrors test-storage-cleanup.js's
// own stubbing approach for the sibling worker.
//
// A counted request-arrival barrier in the storage stub lets a test prove the
// handler has entered readHead before it runs the competing sweep. Both arrival
// and release waits are bounded, so the race is deterministic without sleeps or
// an indefinitely hung test process.
//
// Every fixture with a reservation genuinely reserves it in the ledger first
// (budget.reserveBytes), exactly as the real presign flow does. Building a
// fixture any other way would let a "release/commit happened correctly"
// assertion pass by accident — both sides sitting at zero — rather than by
// actually exercising the ledger arithmetic.

const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const express = require('express');

// Refuse before loading the database module under any non-test environment.
// knexfile.js then independently enforces loopback vtt_test/vtt_test_runner.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('stale-asset atomicity suite requires NODE_ENV=test');
}
const knex = require('../../src/db');
const storage = require('../../src/services/storage');
const budget = require('../../src/services/storageBudget');

storage.isConfigured = () => true;
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const BAD_HEAD = Buffer.alloc(16);
const WAIT_MS = 3000;
const TEARDOWN_WAIT_MS = 3000;
const CHILD_WAIT_MS = 12_000;
const CLIENT_DRAIN_WAIT_MS = 1000;
const RUN_TOKEN = process.env.STALE_ASSET_ATOMICITY_RUN_TOKEN
  || randomUUID().replace(/-/g, '').slice(0, 12);
const CHILD_MODE = process.env.STALE_ASSET_ATOMICITY_CHILD_MODE || '';
const CHILD_REQUEST_FAILURE = 'injected request failure before barrier completion';
if (!/^[a-z0-9]{8,32}$/i.test(RUN_TOKEN)) throw new Error('invalid stale-asset atomicity run token');
let headBarrier = null;
let headHead = PNG_HEAD;
let headSizeBytes = 12_000;
let removeResult = true;

function withTimeout(promise, label, ms = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function requestArrivalBarrier(expected) {
  let arrivals = 0;
  let releaseResolve;
  let released = false;
  const waiters = [];
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const notify = () => {
    for (const waiter of waiters.splice(0)) {
      if (arrivals >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  return {
    async block() {
      arrivals += 1;
      notify();
      await withTimeout(release, 'request barrier release');
    },
    waitForCount(count) {
      if (arrivals >= count) return Promise.resolve();
      const reached = new Promise((resolve) => waiters.push({ count, resolve }));
      return withTimeout(reached, `${count} request arrival(s)`);
    },
    waitForArrivals() {
      return this.waitForCount(expected);
    },
    release() {
      if (!released) { released = true; releaseResolve(); }
    },
  };
}

storage.readHead = async () => {
  if (headBarrier) await headBarrier.block();
  return { head: headHead, reportedMime: 'image/png', contentRangeTotal: null };
};
storage.headSize = async () => ({ bytes: headSizeBytes, reportedMime: 'image/png', etag: 'e1' });
storage.remove = async () => removeResult;

const { cleanupStaleAssets, PENDING_TTL_MINUTES } = require('../../src/services/staleAssetCleanup');
const assetsRouter = require('../../src/routes/assets').router;

// This suite invokes the production sweep without a fixture predicate. It is
// safe only with EXCLUSIVE access to vtt_test for the duration: no other test
// process and no server/background maintenance process may use that database.
// The preflight below refuses to start if any row is already sweep-eligible;
// exclusivity is what prevents an unrelated row becoming eligible mid-suite.
const activeConfirmHandlers = new Set();
const inFlightRequests = new Set();

function installConfirmHandlerTracker() {
  const routeLayer = assetsRouter.stack.find((layer) => layer.route
    && layer.route.path === '/:id/confirm' && layer.route.methods.post);
  if (!routeLayer) throw new Error('confirm route not found for server-work tracking');
  const handlerLayer = routeLayer.route.stack[routeLayer.route.stack.length - 1];
  const original = handlerLayer.handle;
  handlerLayer.handle = function trackedConfirmHandler(req, res, next) {
    let finish;
    const record = { done: new Promise((resolve) => { finish = resolve; }) };
    activeConfirmHandlers.add(record);
    const settle = () => {
      activeConfirmHandlers.delete(record);
      finish();
    };
    let result;
    try {
      result = original(req, res, next);
    } catch (error) {
      settle();
      throw error;
    }
    Promise.resolve(result).then(settle, settle);
    return result;
  };
}
installConfirmHandlerTracker();

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// --- fixed test app, mounting the real router with a stub authenticator -----
let server; let port;
async function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const u = req.headers['x-test-user'];
    req.isAuthenticated = () => !!u;
    req.user = u ? { id: u } : undefined;
    next();
  });
  app.use('/api/assets', assetsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  server = http.createServer(app);
  await withTimeout(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }), 'test app listen');
  port = server.address().port;
}
function startConfirm(id, userId) {
  let request;
  const raw = new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: `/api/assets/${id}/confirm`, method: 'POST', headers: { 'x-test-user': userId } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    request = r;
    r.setTimeout(WAIT_MS, () => r.destroy(new Error(`confirm request timed out after ${WAIT_MS}ms`)));
    r.on('error', reject);
    r.end();
  });

  // Attach both fulfillment and rejection handlers synchronously, before the
  // caller can await a barrier. `settled` never rejects, so an early socket
  // failure cannot become an unhandled rejection while the test is blocked.
  const settled = raw.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  const record = {
    id,
    settled,
    cancel(error = new Error('teardown cancelled in-flight confirm request')) {
      if (request && !request.destroyed) request.destroy(error);
    },
  };
  inFlightRequests.add(record);
  settled.then(() => inFlightRequests.delete(record));
  return record;
}

async function waitForConfirm(record, label) {
  const outcome = await withTimeout(record.settled, label);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function waitForBarrierOrRequestFailure(barrier, records, label) {
  const candidates = [
    barrier.waitForArrivals().then(
      () => ({ kind: 'barrier' }),
      (error) => ({ kind: 'barrier-error', error })
    ),
    ...records.map((record) => record.settled.then((outcome) => ({ kind: 'request', outcome }))),
  ];
  const first = await Promise.race(candidates);
  if (first.kind === 'barrier') return;
  if (first.kind === 'barrier-error') throw first.error;
  if (!first.outcome.ok) throw first.outcome.error;
  throw new Error(`${label}: confirm request completed before the arrival barrier`);
}

// --- fixtures -----------------------------------------------------------------
let owner; let campaignId; let ledgerBeforeSuite; let ledgerRestorationRequired = false;
const ownedAssetIds = new Set();
const ownedStorageKeys = new Set();
const LEDGER_COLUMNS = [
  'committed_bytes', 'reserved_bytes', 'cleanup_debt_bytes', 'class_a_used', 'class_b_used',
  'period_start', 'period_end', 'period_source', 'reconciled_at', 'reconcile_complete',
  'created_at', 'updated_at',
];
async function snapshotLedgerRow() {
  const result = await knex.raw(`
    SELECT id,
      committed_bytes::text AS committed_bytes,
      reserved_bytes::text AS reserved_bytes,
      cleanup_debt_bytes::text AS cleanup_debt_bytes,
      class_a_used::text AS class_a_used,
      class_b_used::text AS class_b_used,
      period_start::text AS period_start,
      period_end::text AS period_end,
      period_source,
      reconciled_at::text AS reconciled_at,
      reconcile_complete,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM storage_budget WHERE id = true
  `);
  return result.rows[0];
}
function ledgerMatches(left, right) {
  return !!left && !!right && LEDGER_COLUMNS.every((column) => left[column] === right[column]);
}
async function initLedger() {
  ledgerRestorationRequired = true;
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0, class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"), period_end: knex.raw("now() + interval '29 days'"),
  });
}
// Mirrors what the real presign flow does before it ever creates the row: a
// genuine ledger reservation, so the ledger and the asset's own reserved_bytes
// stay consistent, exactly as they would outside a test.
async function mkAsset({ status, reservedBytes, storageKey, staleMinutesAgo = null }) {
  ownedStorageKeys.add(storageKey);
  if (reservedBytes) {
    ledgerRestorationRequired = true;
    await budget.reserveBytes(reservedBytes);
  }
  const createdAt = staleMinutesAgo === null ? knex.fn.now() : knex.raw(`now() - interval '${staleMinutesAgo} minutes'`);
  const [row] = await knex('assets').insert({
    campaign_id: campaignId, user_id: owner, url: 'u', kind: 'map', status,
    mime: 'image/png', bytes: 100, bytes_verified: false,
    storage_key: storageKey, reserved_bytes: reservedBytes || null, created_at: createdAt, updated_at: createdAt,
  }).returning('*');
  ownedAssetIds.add(row.id);
  return row;
}
const rid = () => `test/stale-asset-atomicity/${RUN_TOKEN}/${randomUUID()}.png`;
async function ledgerReserved() { return (await budget.snapshot()).bytes.reserved; }
async function ledgerCommitted() { return (await budget.snapshot()).bytes.committed; }
async function assetRow(id) { return knex('assets').where({ id }).first(); }
async function assetCount(ids) { return Number((await knex('assets').whereIn('id', ids).count({ n: '*' }).first()).n); }
async function queueCount(storageKey) { return Number((await knex('storage_cleanup').where({ storage_key: storageKey }).count({ n: '*' }).first()).n); }

function cleanupInsertFailingTransaction(trx, message) {
  return new Proxy(trx, {
    apply(target, thisArg, args) { // eslint-disable-line no-unused-vars
      const builder = Reflect.apply(target, target, args);
      if (args[0] !== 'storage_cleanup') return builder;
      return new Proxy(builder, {
        get(query, prop, receiver) {
          if (prop === 'insert') return async () => { throw new Error(message); };
          const value = Reflect.get(query, prop, receiver);
          return typeof value === 'function' ? value.bind(query) : value;
        },
      });
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function withCleanupInsertFailure(message, work) {
  const original = budget.inSerializable;
  budget.inSerializable = (fn) => original((trx) => fn(cleanupInsertFailingTransaction(trx, message)));
  try { return await work(); } finally { budget.inSerializable = original; }
}

async function captureConsoleErrors(work) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { return { value: await work(), lines }; } finally { console.error = original; }
}

async function assertTestDatabaseIdentity() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('stale-asset atomicity suite requires NODE_ENV=test');
  }
  const result = await knex.raw('SELECT current_database() AS database, current_user AS role');
  const identity = result.rows[0];
  if (!identity || identity.database !== 'vtt_test' || identity.role !== 'vtt_test_runner') {
    throw new Error('stale-asset atomicity suite requires vtt_test as vtt_test_runner');
  }
}

async function sweepEligibleRows() {
  return knex('assets')
    .whereIn('status', ['pending', 'rejected'])
    .whereRaw(`created_at < now() - interval '${PENDING_TTL_MINUTES} minutes'`)
    .select('id', 'status', 'storage_key', 'reserved_bytes', 'created_at')
    .orderBy('created_at', 'asc');
}

async function assertNoExistingSweepEligibleRows() {
  const rows = await sweepEligibleRows();
  if (!rows.length) return;
  const sample = rows.slice(0, 5).map((row) => row.id).join(', ');
  throw new Error(
    `REFUSING stale-asset atomicity suite: found ${rows.length} pre-existing sweep-eligible `
    + `asset row(s) (${sample}${rows.length > 5 ? ', ...' : ''}). Run this suite exclusively `
    + 'against vtt_test with no other tests or background maintenance using the database.'
  );
}

function childToken() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function runBoundedChild(mode, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STALE_ASSET_ATOMICITY_CHILD_MODE: mode,
        STALE_ASSET_ATOMICITY_RUN_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-256 * 1024);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_WAIT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`child ${mode} exceeded ${CHILD_WAIT_MS}ms and was killed`));
        return;
      }
      resolve({ code, signal, stdout, stderr, combined: `${stdout}\n${stderr}` });
    });
  });
}

async function runTeardownStep(label, work, errors) {
  try {
    await withTimeout(Promise.resolve().then(work), `teardown ${label}`, TEARDOWN_WAIT_MS);
    return true;
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return false;
  }
}

async function drainOrCancelInFlightRequests() {
  let pending = [...inFlightRequests];
  if (!pending.length) return;
  try {
    await withTimeout(
      Promise.all(pending.map((record) => record.settled)),
      'in-flight confirm request drain',
      CLIENT_DRAIN_WAIT_MS
    );
    return;
  } catch {
    pending = [...inFlightRequests];
    for (const record of pending) record.cancel();
    if (pending.length) {
      await withTimeout(
        Promise.all(pending.map((record) => record.settled)),
        'cancelled confirm request drain',
        CLIENT_DRAIN_WAIT_MS
      );
    }
  }
}

async function waitForServerConfirmWork() {
  while (activeConfirmHandlers.size) {
    const current = [...activeConfirmHandlers];
    await Promise.all(current.map((record) => record.done));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function teardown() {
  const errors = [];
  if (headBarrier) { headBarrier.release(); headBarrier = null; }

  await runTeardownStep('in-flight confirm requests', drainOrCancelInFlightRequests, errors);

  // Stop accepting new requests before the database fixtures can be removed.
  // The close callback is not treated as proof that an async route handler has
  // finished: tracked handler completion below is the authoritative barrier.
  let closePromise = null;
  if (server && server.listening) {
    closePromise = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
  }

  const serverWorkSettled = await runTeardownStep(
    'server-side confirm work',
    waitForServerConfirmWork,
    errors
  );
  if (closePromise) {
    await runTeardownStep('server close', async () => {
      const outcome = await closePromise;
      if (!outcome.ok) throw outcome.error;
    }, errors);
  }

  if (serverWorkSettled) {
    await runTeardownStep('owned assets', async () => {
      if (!ownedAssetIds.size) return;
      await knex('assets').whereIn('id', [...ownedAssetIds]).del().timeout(TEARDOWN_WAIT_MS, { cancel: true });
    }, errors);

    await runTeardownStep('owned cleanup queue rows', async () => {
      if (!ownedStorageKeys.size) return;
      await knex('storage_cleanup').whereIn('storage_key', [...ownedStorageKeys]).del().timeout(TEARDOWN_WAIT_MS, { cancel: true });
    }, errors);

    await runTeardownStep('owned campaign', async () => {
      if (!campaignId) return;
      await knex('campaigns').where({ id: campaignId }).del().timeout(TEARDOWN_WAIT_MS, { cancel: true });
    }, errors);

    await runTeardownStep('owned user', async () => {
      if (!owner) return;
      await knex('users').where({ id: owner }).del().timeout(TEARDOWN_WAIT_MS, { cancel: true });
    }, errors);

    await runTeardownStep('ledger restoration', async () => {
      if (!ledgerBeforeSuite || !ledgerRestorationRequired) return;
      const { id, ...restore } = ledgerBeforeSuite; // eslint-disable-line no-unused-vars
      await knex('storage_budget').where({ id: true }).update(restore).timeout(TEARDOWN_WAIT_MS, { cancel: true });
    }, errors);

    await runTeardownStep('ledger restoration verification', async () => {
      if (!ledgerBeforeSuite || !ledgerRestorationRequired) return;
      const restored = await withTimeout(snapshotLedgerRow(), 'ledger restoration verification query', TEARDOWN_WAIT_MS);
      if (!ledgerMatches(restored, ledgerBeforeSuite)) throw new Error('restored ledger differs from the pre-suite snapshot');
    }, errors);
  } else {
    errors.push('database fixture cleanup and ledger restoration skipped because server-side confirm work did not settle');
  }

  await runTeardownStep('database pool close', () => knex.destroy(), errors);
  if (!errors.length) console.log('teardown complete: no teardown errors');
  return errors;
}

function sameAssetState(left, right) {
  return !!left && !!right
    && left.id === right.id
    && left.status === right.status
    && left.storage_key === right.storage_key
    && String(left.reserved_bytes) === String(right.reserved_bytes)
    && String(left.created_at) === String(right.created_at);
}

async function verifyPreflightRefusalSafety() {
  console.log('\n--- safety: pre-existing sweep-eligible rows cause a mutation-free refusal ---');
  const sentinel = await mkAsset({
    status: 'rejected', reservedBytes: null, storageKey: rid(),
    staleMinutesAgo: PENDING_TTL_MINUTES + 1,
  });
  const sentinelBefore = await assetRow(sentinel.id);
  const ledgerBefore = await snapshotLedgerRow();
  let result;
  try {
    result = await runBoundedChild('preflight-probe', childToken());
    t('the child refuses to run when a pre-existing sweep-eligible row exists', result.code !== 0, result.combined);
    t('the refusal identifies the unrestricted-sweep exclusivity requirement',
      result.combined.includes('REFUSING stale-asset atomicity suite')
      && result.combined.includes('no other tests or background maintenance'), result.combined);
    t('the pre-existing sweep-eligible row is unchanged by the refused child',
      sameAssetState(await assetRow(sentinel.id), sentinelBefore));
    t('the ledger is byte-for-byte logically unchanged by the refused child',
      ledgerMatches(await snapshotLedgerRow(), ledgerBefore));
  } finally {
    // Exact self-test ownership: do not invoke the unrestricted production sweep
    // to remove the sentinel used to prove preflight refusal.
    await knex('assets').where({ id: sentinel.id }).del().timeout(TEARDOWN_WAIT_MS, { cancel: true });
  }
}

async function runRequestFailureBeforeBarrierScenario() {
  console.log('\n--- child injection: request failure before barrier completion ---');
  await initLedger();
  const a = await mkAsset({
    status: 'pending', reservedBytes: 8000, storageKey: rid(), staleMinutesAgo: 5,
  });
  headHead = PNG_HEAD;
  headSizeBytes = 3000;
  removeResult = true;
  headBarrier = requestArrivalBarrier(2); // deliberately impossible with one request
  const request = startConfirm(a.id, owner);
  await headBarrier.waitForCount(1); // prove server-side handler is blocked in readHead
  request.cancel(new Error(CHILD_REQUEST_FAILURE));
  await waitForBarrierOrRequestFailure(headBarrier, [request], 'child request-failure injection');
  throw new Error('request-failure injection unexpectedly reached the barrier');
}

async function verifyRequestFailureChildSafety() {
  console.log('\n--- safety: early request failure is preserved and teardown waits for server work ---');
  const token = childToken();
  const ledgerBefore = await snapshotLedgerRow();
  const result = await runBoundedChild('request-failure-before-barrier', token);
  t('the bounded failure-injection child exits nonzero', result.code !== 0 && result.signal === null, result.combined);
  t('the child preserves the original request failure rather than replacing it with a barrier timeout',
    result.combined.includes(CHILD_REQUEST_FAILURE)
    && !result.combined.includes('2 request arrival(s) timed out'), result.combined);
  t('the child reaches its finally teardown', result.combined.includes('teardown complete: no teardown errors'), result.combined);
  t('the child restores the exact pre-child ledger snapshot',
    ledgerMatches(await snapshotLedgerRow(), ledgerBefore));

  const prefix = `test/stale-asset-atomicity/${token}/%`;
  const [assets, queue, users, campaigns] = await Promise.all([
    knex('assets').where('storage_key', 'like', prefix).count({ n: '*' }).first(),
    knex('storage_cleanup').where('storage_key', 'like', prefix).count({ n: '*' }).first(),
    knex('users').where({ email: `saa-${token}@example.invalid` }).count({ n: '*' }).first(),
    knex('campaigns').where({ name: `stale-asset-atomicity-${token}` }).count({ n: '*' }).first(),
  ]);
  t('the child removes all owned asset, cleanup-queue, campaign and user fixtures',
    [assets, queue, users, campaigns].every((row) => Number(row.n) === 0),
    JSON.stringify({ assets: assets.n, queue: queue.n, users: users.n, campaigns: campaigns.n }));
}

async function main() {
  try {
    await assertTestDatabaseIdentity();
    ledgerBeforeSuite = await snapshotLedgerRow();
    if (!ledgerBeforeSuite) throw new Error('run migrations first: storage_budget row is missing');

    // Read-only refusal comes before every suite mutation. Because the real
    // cleanupStaleAssets() has intentionally not been test-filtered, a dirty
    // sweep domain is unsafe and must fail rather than delete someone else's row.
    await assertNoExistingSweepEligibleRows();
    if (CHILD_MODE === 'preflight-probe') {
      throw new Error('preflight probe expected a sweep-eligible row but found none');
    }

    await startApp();
    [owner] = await knex('users').insert({
      email: `saa-${RUN_TOKEN}@example.invalid`, username: `saa${RUN_TOKEN}`, password_hash: 'x',
    }).returning('id').then((r) => r.map((x) => x.id));
    [campaignId] = await knex('campaigns').insert({ name: `stale-asset-atomicity-${RUN_TOKEN}`, owner_id: owner }).returning('id')
      .then((r) => r.map((x) => x.id || x));

    if (CHILD_MODE === 'request-failure-before-barrier') {
      await runRequestFailureBeforeBarrierScenario();
      throw new Error('request-failure child unexpectedly completed');
    }
    if (CHILD_MODE) throw new Error(`unknown stale-asset atomicity child mode: ${CHILD_MODE}`);

    await verifyPreflightRefusalSafety();
    await verifyRequestFailureChildSafety();

  // ============================================================ sweep basics
  console.log('\n--- sweep: pending row past the TTL is claimed exactly once ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 5000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const claimed = await cleanupStaleAssets();
    t('the row is claimed', claimed.some((r) => r.id === a.id));
    t('the row is gone', (await assetRow(a.id)) === undefined);
    t('its 5000 bytes are released to the ledger, exactly once', (await ledgerReserved()) === before - 5000, `before=${before} after=${await ledgerReserved()}`);
    t('a cleanup-queue row was inserted for its storage_key', (await queueCount(a.storage_key)) === 1);
    const again = await cleanupStaleAssets();
    t('an immediate re-run claims nothing further for it', !again.some((r) => r.id === a.id));
  }

  console.log('\n--- sweep: a row not yet past the TTL is left untouched ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 4000, storageKey: rid(), staleMinutesAgo: 5 });
    const before = await ledgerReserved();
    await cleanupStaleAssets();
    t('the fresh row survives', (await assetRow(a.id)) !== undefined);
    t('its reservation is untouched', (await ledgerReserved()) === before);
  }

  console.log('\n--- sweep: an already-rejected row (reserved_bytes already null) is still eligible, and nothing further is released ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'rejected', reservedBytes: null, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const claimed = await cleanupStaleAssets();
    t('the rejected row is claimed and removed', claimed.some((r) => r.id === a.id) && (await assetRow(a.id)) === undefined);
    t('nothing further is released for it (its own reservation was already gone)', (await ledgerReserved()) === before);
    t('a cleanup-queue row is still inserted for its storage_key', (await queueCount(a.storage_key)) >= 1);
  }

  console.log('\n--- sweep: two concurrent claim attempts on the same stale rows release each exactly once ---');
  await initLedger();
  {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(await mkAsset({ status: i % 2 ? 'rejected' : 'pending', reservedBytes: 1000 + i, storageKey: rid(), staleMinutesAgo: 31 }));
    const total = rows.reduce((n, r) => n + Number(r.reserved_bytes || 0), 0);
    const before = await ledgerReserved();
    const [c1, c2] = await Promise.all([cleanupStaleAssets(), cleanupStaleAssets()]);
    const claimedIds = new Set([...c1, ...c2].map((r) => r.id));
    t('every row is claimed by exactly one of the two calls', claimedIds.size === rows.length
      && rows.every((r) => c1.some((x) => x.id === r.id) !== c2.some((x) => x.id === r.id)));
    t('the ledger release equals the sum exactly once, not doubled', (await ledgerReserved()) === before - total, `before=${before} after=${await ledgerReserved()} total=${total}`);
    t('every row is gone', (await assetCount(rows.map((r) => r.id))) === 0);
    let queueTotal = 0;
    for (const r of rows) queueTotal += await queueCount(r.storage_key); // eslint-disable-line no-await-in-loop
    t('each storage_key got exactly one queue entry across both calls', queueTotal === rows.length);
  }

  // =================================================== sweep vs. confirm: reject
  console.log('\n--- sweep wins against a rejection: confirm gets 409, releases nothing, queues nothing ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 3000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = BAD_HEAD; // magic mismatch -> confirm's reject path
    removeResult = true;
    headBarrier = requestArrivalBarrier(1);
    const inFlight = startConfirm(a.id, owner);
    await waitForBarrierOrRequestFailure(headBarrier, [inFlight], 'sweep-wins rejection arrival');
    const claimed = await cleanupStaleAssets(); // sweep wins after request arrival, before readHead returns
    t('the sweep claimed the row while confirm was mid-flight', claimed.some((r) => r.id === a.id));
    headBarrier.release();
    const res = await waitForConfirm(inFlight, 'sweep-wins rejection response');
    headBarrier = null;
    t('confirm reports a defined 409, not a crash', res.status === 409 && res.body.error === 'asset is no longer pending', JSON.stringify(res));
    t('the ledger release happened exactly once (the sweep\'s), not twice', (await ledgerReserved()) === before - 3000, `before=${before} after=${await ledgerReserved()}`);
    t('confirm did not insert a second queue row for the same key (only the sweep\'s)', (await queueCount(a.storage_key)) === 1);
  }

  console.log('\n--- confirm wins a rejection on a stale row: later sweep removes it without a second release ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 2500, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = BAD_HEAD; removeResult = true; headBarrier = null;
    const res = await waitForConfirm(startConfirm(a.id, owner), 'confirm-wins rejection response');
    t('confirm rejects normally', res.status === 400);
    const row = await assetRow(a.id);
    t('the stale row is marked rejected, not deleted by confirm', row && row.status === 'rejected' && row.reserved_bytes === null);
    t('the reservation is released exactly once by confirm', (await ledgerReserved()) === before - 2500);
    const claimed = await cleanupStaleAssets();
    t('the already-rejected stale asset is subsequently sweep-eligible and removed', claimed.some((r) => r.id === a.id) && (await assetRow(a.id)) === undefined);
    t('the later sweep does not release the reservation a second time', (await ledgerReserved()) === before - 2500);
  }

  // =================================================== sweep vs. confirm: success
  console.log('\n--- sweep wins against a success: confirm gets 409, commits nothing, releases nothing ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 20_000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = PNG_HEAD; headSizeBytes = 9000; removeResult = true;
    headBarrier = requestArrivalBarrier(1);
    const inFlight = startConfirm(a.id, owner);
    await waitForBarrierOrRequestFailure(headBarrier, [inFlight], 'sweep-wins success arrival');
    const claimed = await cleanupStaleAssets();
    t('the sweep claimed the row while confirm was mid-flight', claimed.some((r) => r.id === a.id));
    headBarrier.release();
    const res = await waitForConfirm(inFlight, 'sweep-wins success response');
    headBarrier = null;
    t('confirm reports a defined 409, not a crash on an undefined row', res.status === 409 && res.body.error === 'asset is no longer pending', JSON.stringify(res));
    t('nothing was committed', (await ledgerCommitted()) === 0);
    t('the ledger release happened exactly once (the sweep\'s, for the full reservation)', (await ledgerReserved()) === before - 20_000);
  }

  console.log('\n--- confirm wins a success on a stale row: commits real size before the eligible sweep runs ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 20_000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = PNG_HEAD; headSizeBytes = 9000; headBarrier = null;
    const res = await waitForConfirm(startConfirm(a.id, owner), 'confirm-wins success response');
    t('confirm succeeds', res.status === 200 && res.body.asset.status === 'ready', JSON.stringify(res));
    const row = await assetRow(a.id);
    t('the row reflects the real size and clears its reservation', row.bytes === 9000 && row.reserved_bytes === null);
    t('9000 bytes committed', (await ledgerCommitted()) === 9000);
    t('the remaining 11000 released, once', (await ledgerReserved()) === before - 20_000);
    const claimed = await cleanupStaleAssets();
    t('the sweep does not claim the now-ready asset even though its timestamp is stale', !claimed.some((r) => r.id === a.id) && (await assetRow(a.id)).status === 'ready');
  }

  // =================================================================== concurrent confirmations
  console.log('\n--- two concurrent confirm requests for the same asset: exactly one wins, one net release/commit ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 15_000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = PNG_HEAD; headSizeBytes = 7000;
    headBarrier = requestArrivalBarrier(2);
    const first = startConfirm(a.id, owner);
    const second = startConfirm(a.id, owner);
    await waitForBarrierOrRequestFailure(headBarrier, [first, second], 'concurrent success arrival');
    headBarrier.release();
    const [r1, r2] = await Promise.all([
      waitForConfirm(first, 'first concurrent success confirmation'),
      waitForConfirm(second, 'second concurrent success confirmation'),
    ]);
    headBarrier = null;
    const statuses = [r1.status, r2.status].sort();
    t('exactly one request succeeds and the other is told the row already moved on', statuses[0] === 200 && statuses[1] === 409, JSON.stringify([r1.status, r2.status]));
    t('committed bytes reflect exactly one confirmation, not two', (await ledgerCommitted()) === 7000);
    t('the ledger reservation drops by exactly 15000 once, not twice', (await ledgerReserved()) === before - 15_000);
  }

  console.log('\n--- two concurrent confirm requests for the same asset, both rejecting: exactly one release ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 6500, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    headHead = BAD_HEAD; removeResult = true;
    headBarrier = requestArrivalBarrier(2);
    const first = startConfirm(a.id, owner);
    const second = startConfirm(a.id, owner);
    await waitForBarrierOrRequestFailure(headBarrier, [first, second], 'concurrent rejection arrival');
    headBarrier.release();
    const [r1, r2] = await Promise.all([
      waitForConfirm(first, 'first concurrent rejection confirmation'),
      waitForConfirm(second, 'second concurrent rejection confirmation'),
    ]);
    headBarrier = null;
    const statuses = [r1.status, r2.status].sort();
    t('exactly one request rejects and the other is told the row already moved on', statuses[0] === 400 && statuses[1] === 409, JSON.stringify([r1.status, r2.status]));
    t('the ledger reservation drops by exactly 6500 once, not twice', (await ledgerReserved()) === before - 6500);
    t('no cleanup-queue row is inserted by confirm when removal succeeds', (await queueCount(a.storage_key)) === 0);
  }

  // =================================================== cleanup queue insertion failures
  console.log('\n--- sweep queue-insert failure with a reservation: delete and ledger release both roll back, and the failure is reported ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 6100, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const message = 'injected cleanup queue insert failure with reservation';
    const observed = await captureConsoleErrors(() => withCleanupInsertFailure(message, () => cleanupStaleAssets()));
    t('the fail-soft sweep reports no claimed rows after the transaction aborts', Array.isArray(observed.value) && observed.value.length === 0);
    t('the outer sweep error path reports the actual queue-insert failure', observed.lines.some((line) => line.includes(`Asset cleanup failed: ${message}`)), observed.lines.join(' | '));
    const row = await assetRow(a.id);
    t('the asset delete rolled back', row && row.status === 'pending' && Number(row.reserved_bytes) === 6100);
    t('the reservation release rolled back too', (await ledgerReserved()) === before);
    t('no cleanup row leaked from the aborted transaction', (await queueCount(a.storage_key)) === 0);
    const retry = await cleanupStaleAssets();
    t('a later sweep can claim the same row normally', retry.some((r) => r.id === a.id));
    t('the later successful sweep releases the reservation exactly once', (await ledgerReserved()) === before - 6100);
  }

  console.log('\n--- sweep queue-insert failure without a reservation: row delete rolls back and the failure is still reported ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'rejected', reservedBytes: null, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const message = 'injected cleanup queue insert failure without reservation';
    const observed = await captureConsoleErrors(() => withCleanupInsertFailure(message, () => cleanupStaleAssets()));
    t('the no-reservation failure is reported through the outer sweep error path', observed.lines.some((line) => line.includes(`Asset cleanup failed: ${message}`)), observed.lines.join(' | '));
    const row = await assetRow(a.id);
    t('the rejected asset delete rolls back even though there was no reservation', row && row.status === 'rejected' && row.reserved_bytes === null);
    t('the ledger remains unchanged when no reservation existed', (await ledgerReserved()) === before);
    t('no cleanup row leaked from the aborted no-reservation transaction', (await queueCount(a.storage_key)) === 0);
    const retry = await cleanupStaleAssets();
    t('the no-reservation row remains sweepable after the failed attempt', retry.some((r) => r.id === a.id));
    t('the successful retry still does not release any reservation', (await ledgerReserved()) === before);
  }

  console.log('\n--- confirm rejection queue-insert failure: 500 is accurate and row/reservation roll back together ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 4200, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const message = 'injected confirm cleanup queue insert failure';
    headHead = BAD_HEAD; removeResult = false; headBarrier = null;
    const res = await withCleanupInsertFailure(message, () => waitForConfirm(startConfirm(a.id, owner), 'confirm queue-failure response'));
    t('confirm surfaces the queue failure as a 500 with the real failure message in this test app', res.status === 500 && res.body.error === message, JSON.stringify(res));
    const row = await assetRow(a.id);
    t('the rejection row transition rolled back', row && row.status === 'pending' && Number(row.reserved_bytes) === 4200);
    t('the reservation release did not occur on the aborted rejection', (await ledgerReserved()) === before);
    t('no cleanup queue row leaked from the failed confirm transaction', (await queueCount(a.storage_key)) === 0);
    const retry = await waitForConfirm(startConfirm(a.id, owner), 'confirm queue-failure retry');
    t('a retry rejects normally once the queue insert works', retry.status === 400, JSON.stringify(retry));
    t('the retry releases the reservation exactly once', (await ledgerReserved()) === before - 4200);
    t('the retry records exactly one durable cleanup row', (await queueCount(a.storage_key)) === 1);
  }

  // =================================================== intermediate failures / rollback
  console.log('\n--- an injected failure between the row transition and the ledger update rolls back the whole sweep claim ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 6000, storageKey: rid(), staleMinutesAgo: 31 });
    const before = await ledgerReserved();
    const beforeLedgerRow = await knex('storage_budget').where({ id: true }).first();
    const originalReleaseIn = budget.releaseReservedBytesIn;
    let threw = false;
    budget.releaseReservedBytesIn = async () => { threw = true; throw new Error('injected failure between transition and ledger update'); };
    let claimed;
    try {
      claimed = (await captureConsoleErrors(() => cleanupStaleAssets())).value;
    } finally {
      budget.releaseReservedBytesIn = originalReleaseIn;
    }
    t('the injection actually fired', threw);
    t('cleanupStaleAssets absorbs the failure rather than crashing the caller', Array.isArray(claimed));
    t('the row was NOT removed — the whole transaction rolled back', (await assetRow(a.id)) !== undefined);
    const rowNow = await assetRow(a.id);
    t('the row is unchanged (still pending, same reservation)', rowNow.status === 'pending' && Number(rowNow.reserved_bytes) === 6000);
    t('the ledger is unchanged — no partial release', (await ledgerReserved()) === before);
    t('no cleanup-queue row leaked from the aborted attempt', (await queueCount(a.storage_key)) === 0);
    const claimedAgain = await cleanupStaleAssets(); // retried on the next sweep, now uninjected
    t('the row is claimable normally afterwards', claimedAgain.some((r) => r.id === a.id));
    t('and released normally this time', (await ledgerReserved()) === before - 6000);
    const afterLedgerRow = await knex('storage_budget').where({ id: true }).first();
    t('every other ledger field is otherwise identical (conservation)',
      afterLedgerRow.committed_bytes === beforeLedgerRow.committed_bytes
      && afterLedgerRow.cleanup_debt_bytes === beforeLedgerRow.cleanup_debt_bytes
      && afterLedgerRow.class_a_used === beforeLedgerRow.class_a_used
      && afterLedgerRow.class_b_used === beforeLedgerRow.class_b_used);
  }

  console.log('\n--- failure after a real ledger mutation in confirm success rolls back that mutation and the asset transition ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 8000, storageKey: rid(), staleMinutesAgo: 31 });
    const beforeReserved = await ledgerReserved();
    const beforeCommitted = await ledgerCommitted();
    headHead = PNG_HEAD; headSizeBytes = 3000; headBarrier = null;
    const originalReleaseIn = budget.releaseReservedBytesIn;
    let sawCommittedMutation = false;
    budget.releaseReservedBytesIn = async (trx) => {
      const mid = await budget.readRow(trx);
      sawCommittedMutation = Number(mid.committed_bytes) === beforeCommitted + 3000
        && Number(mid.reserved_bytes) === beforeReserved - 3000;
      throw new Error('injected failure after commitReservedBytesIn mutation');
    };
    let res;
    try {
      res = await waitForConfirm(startConfirm(a.id, owner), 'post-ledger-mutation failure response');
    } finally {
      budget.releaseReservedBytesIn = originalReleaseIn;
    }
    t('the failure fires only after commitReservedBytesIn has visibly mutated the transaction ledger', sawCommittedMutation);
    t('confirm surfaces the post-mutation failure rather than a false success', res.status >= 500, JSON.stringify(res));
    const row = await assetRow(a.id);
    t('the asset transition rolls back to pending with its reservation intact', row.status === 'pending' && Number(row.reserved_bytes) === 8000);
    t('the reserved-byte mutation rolls back', (await ledgerReserved()) === beforeReserved);
    t('the committed-byte mutation rolls back', (await ledgerCommitted()) === beforeCommitted);
    const retry = await waitForConfirm(startConfirm(a.id, owner), 'post-ledger-mutation retry');
    t('a retried confirm succeeds cleanly afterwards', retry.status === 200, JSON.stringify(retry));
    t('exactly one commit total remains, from the retry', (await ledgerCommitted()) === beforeCommitted + 3000);
  }

  console.log('\n--- an injected failure inside confirm\'s rejection transaction rolls back the row AND the release together ---');
  await initLedger();
  {
    const a = await mkAsset({ status: 'pending', reservedBytes: 4500, storageKey: rid(), staleMinutesAgo: 5 });
    const before = await ledgerReserved();
    headHead = BAD_HEAD; removeResult = true; headBarrier = null;
    const originalReleaseIn = budget.releaseReservedBytesIn;
    let threw = false;
    budget.releaseReservedBytesIn = async () => { threw = true; throw new Error('injected failure inside confirm reject path'); };
    let res;
    try {
      res = await waitForConfirm(startConfirm(a.id, owner), 'rejection rollback response');
    } finally {
      budget.releaseReservedBytesIn = originalReleaseIn;
    }
    t('the injection actually fired', threw);
    t('confirm surfaces the failure rather than a false rejection', res.status >= 500, JSON.stringify(res));
    const row = await assetRow(a.id);
    t('the row was NOT transitioned — still pending, reservation intact', row.status === 'pending' && Number(row.reserved_bytes) === 4500);
    t('the ledger is unchanged', (await ledgerReserved()) === before);
    const retry = await waitForConfirm(startConfirm(a.id, owner), 'rejection rollback retry');
    t('a retried confirm rejects cleanly afterwards', retry.status === 400, JSON.stringify(retry));
    t('exactly one release total, from the retry', (await ledgerReserved()) === before - 4500);
  }

  } catch (error) {
    fail += 1;
    console.error('crashed:', error);
  } finally {
    const teardownErrors = await teardown();
    for (const error of teardownErrors) console.error(`teardown failure: ${error}`);
    fail += teardownErrors.length;
    console.log(`\n${pass} passed, ${fail} failed`);
  }

  process.exitCode = fail ? 1 : 0;
}

main();
