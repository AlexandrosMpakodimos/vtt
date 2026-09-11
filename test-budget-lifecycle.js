// Upload accounting lifecycle — integration against a real Postgres, NO server.
//
//   SKIP_HIBP=1 node test-budget-lifecycle.js
//
// The route handlers in routes/assets.js drive the budget through a specific
// sequence, and that sequence — not each primitive in isolation — is what has
// to be correct. test-storage-budget.js proves the primitives hold under
// concurrency; this proves the ORDER the routes call them in leaves the ledger
// exactly right, including the case the real path hits every time: we reserve
// the declared MAXIMUM at presign and commit the SMALLER actual size at confirm,
// releasing the difference.
//
// It calls the budget service the way the routes do rather than over HTTP,
// because the property under test is the accounting arithmetic across the
// lifecycle, and the sandbox cannot hold a server process alive across the
// length of a full HTTP suite. The HTTP status-shape regression (does
// test-assets.js still return its baseline with the budget inactive) is a
// separate, server-dependent check and is called out in the handoff.

const knex = require('./src/db');
const budget = require('./src/services/storageBudget');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

async function initBudget({ committed = 0 } = {}) {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: committed,
    reserved_bytes: 0,
    cleanup_debt_bytes: 0,
    class_a_used: 0,
    class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"),
    period_end: knex.raw("now() + interval '29 days'"),
    period_source: 'assumed',
  });
}

async function main() {
  const has = await knex('storage_budget').where({ id: true }).first();
  if (!has) {
    console.log('  FAIL  storage_budget missing — run migrations');
    console.log('\n0 passed, 1 failed'); process.exit(1);
  }

  console.log('\n--- presign reserves the declared max and charges a PUT ---');
  await initBudget();
  // presign: reserve declared bytes, then charge('put')
  const DECLARED = 4 * 1024 * 1024; // a portrait's max
  await budget.reserveBytes(DECLARED);
  await budget.charge('put');
  let snap = await budget.snapshot();
  t('reserved bytes equal the declared max', snap.bytes.reserved === DECLARED);
  t('live equals the reservation (nothing committed yet)', snap.bytes.live === DECLARED);
  t('one Class A op charged for the presigned PUT', snap.class_a.used === 1);
  t('no Class B yet', snap.class_b.used === 0);

  console.log('\n--- confirm commits the ACTUAL size and releases the surplus ---');
  // confirm: charge get (readback) + head (size), then commit actual, release diff
  const ACTUAL = 1_200_000; // the real object was smaller than the declared max
  await budget.charge('get');
  await budget.charge('head');
  // reconcile reservation -> committed at the real size (route logic)
  const toCommit = Math.min(ACTUAL, DECLARED);
  await budget.commitReservedBytes(toCommit);
  if (DECLARED > toCommit) await budget.releaseReservedBytes(DECLARED - toCommit);
  snap = await budget.snapshot();
  t('committed equals the ACTUAL stored size, not the declared max',
    snap.bytes.committed === ACTUAL, `committed=${snap.bytes.committed}`);
  t('the surplus reservation was released', snap.bytes.reserved === 0);
  t('live now equals the actual size', snap.bytes.live === ACTUAL, `live=${snap.bytes.live}`);
  t('two Class B ops charged (readback + head)', snap.class_b.used === 2);
  t('Class A still 1 — confirm issues no writes', snap.class_a.used === 1);

  console.log('\n--- an abandoned presign releases its reservation, keeps the op ---');
  await initBudget();
  await budget.reserveBytes(DECLARED);
  await budget.charge('put');
  // client never uploads; the sweep releases the reservation
  await budget.releaseReservedBytes(DECLARED);
  snap = await budget.snapshot();
  t('the abandoned reservation is fully returned', snap.bytes.live === 0);
  t('but the PUT operation stays charged (it was issued)', snap.class_a.used === 1,
    'issuing the authorisation is the billable event, not the upload');

  console.log('\n--- a rejected upload moves bytes to cleanup debt until deletion ---');
  await initBudget();
  await budget.reserveBytes(DECLARED);
  await budget.charge('put');
  await budget.charge('get'); // readback reveals a lie
  // route rejects: the object exists and must be deleted. Its size is unknown
  // at reject time (we never HEAD a liar), so the reservation is released and,
  // if an object is there, it is queued for cleanup. Model the reservation
  // release here; the object's debt is handled by the cleanup queue path.
  await budget.releaseReservedBytes(DECLARED);
  snap = await budget.snapshot();
  t('a rejected upload releases its byte reservation', snap.bytes.live === 0);
  t('the readback GET stays charged', snap.class_b.used === 1);

  console.log('\n--- committed bytes -> cleanup debt -> released once on delete ---');
  await initBudget();
  await budget.reserveBytes(ACTUAL);
  await budget.commitReservedBytes(ACTUAL);
  // delete the asset, but R2 delete FAILS: move committed -> debt, queue it
  await budget.moveToCleanupDebt(ACTUAL);
  snap = await budget.snapshot();
  t('a failed delete keeps the bytes charged as debt', snap.bytes.live === ACTUAL);
  t('...classified as debt, not committed', snap.bytes.cleanup_debt === ACTUAL && snap.bytes.committed === 0);
  // cleanup worker retries and succeeds: release debt exactly once, in a txn
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await budget.releaseCleanupDebt(trx, ACTUAL);
  });
  snap = await budget.snapshot();
  t('confirmed deletion releases the debt, live back to zero', snap.bytes.live === 0);
  // a second (duplicate) worker pass must not release again — debt is already 0
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await budget.releaseCleanupDebt(trx, ACTUAL);
  });
  snap = await budget.snapshot();
  t('a duplicate cleanup pass cannot drive debt negative', snap.bytes.cleanup_debt === 0);

  // leave the ledger inactive so nothing inherits test state
  await knex('storage_budget').where({ id: true })
    .update({ period_start: null, period_end: null, committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0, class_a_used: 0, class_b_used: 0 });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
