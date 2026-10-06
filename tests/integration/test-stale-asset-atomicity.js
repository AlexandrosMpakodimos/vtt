// Stale-asset sweep: atomicity, concurrency and rollback.
//
// EXCLUSIVE vtt_test use only: stop other test processes and the dev:test server
// (its background maintenance uses the same production sweep), then run:
//   NODE_ENV=test SKIP_HIBP=1 node tests/integration/test-stale-asset-atomicity.js
//
// Against a real Postgres, no server. storage.js is stubbed (remove,
// isConfigured) so R2 behaviour is deterministic — the property under test is
// the atomicity of cleanupStaleAssets() against itself and against injected
// failures, not R2 itself.
//
// [CHANGED 2026-10-05] The scenarios that raced the sweep against POST
// /api/assets/:id/confirm were removed with that route (the legacy presigned
// upload path, removed in the schema cleanup). The sweep-only scenarios are
// unchanged.
//
// Every fixture with a reservation genuinely reserves it in the ledger first
// (budget.reserveBytes), as the real upload route does before creating the row.
// Building a fixture any other way would let a "release happened correctly"
// assertion pass by accident — both sides sitting at zero — rather than by
// actually exercising the ledger arithmetic.

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Refuse before loading the database module under any non-test environment.
// knexfile.js then independently enforces loopback vtt_test/vtt_test_runner.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('stale-asset atomicity suite requires NODE_ENV=test');
}
const knex = require('../../src/db');
const storage = require('../../src/services/storage');
const budget = require('../../src/services/storageBudget');

storage.isConfigured = () => true;
const WAIT_MS = 3000;
const TEARDOWN_WAIT_MS = 3000;
const CHILD_WAIT_MS = 12_000;
const RUN_TOKEN = process.env.STALE_ASSET_ATOMICITY_RUN_TOKEN
  || randomUUID().replace(/-/g, '').slice(0, 12);
const CHILD_MODE = process.env.STALE_ASSET_ATOMICITY_CHILD_MODE || '';
if (!/^[a-z0-9]{8,32}$/i.test(RUN_TOKEN)) throw new Error('invalid stale-asset atomicity run token');
const removeResult = true;

function withTimeout(promise, label, ms = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

storage.remove = async () => removeResult;

const { cleanupStaleAssets, PENDING_TTL_MINUTES } = require('../../src/services/staleAssetCleanup');

// This suite invokes the production sweep without a fixture predicate. It is
// safe only with EXCLUSIVE access to vtt_test for the duration: no other test
// process and no server/background maintenance process may use that database.
// The preflight below refuses to start if any row is already sweep-eligible;
// exclusivity is what prevents an unrelated row becoming eligible mid-suite.
let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

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
// Mirrors what the real upload route does before it creates the row: a
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

async function teardown() {
  const errors = [];
  {
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

    [owner] = await knex('users').insert({
      email: `saa-${RUN_TOKEN}@example.invalid`, username: `saa${RUN_TOKEN}`, password_hash: 'x',
    }).returning('id').then((r) => r.map((x) => x.id));
    [campaignId] = await knex('campaigns').insert({ name: `stale-asset-atomicity-${RUN_TOKEN}`, owner_id: owner }).returning('id')
      .then((r) => r.map((x) => x.id || x));

    if (CHILD_MODE) throw new Error(`unknown stale-asset atomicity child mode: ${CHILD_MODE}`);

    await verifyPreflightRefusalSafety();

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
