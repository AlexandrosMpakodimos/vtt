// Storage budget service — concurrency and failure suite.
//
//   SKIP_HIBP=1 node tests/integration/test-storage-budget.js     (real Postgres, NO server)
//
// This is a DATABASE suite but not a server suite: it exercises the budget
// service directly against a real Postgres, because the property under test is
// transactional, not HTTP. The whole reason the service exists is to hold a
// ceiling under genuine concurrency, so a test that does not run genuine
// concurrent transactions against a real serialisable engine would be testing
// the wrong thing. It uses the same hand-rolled harness as the other suites and
// ends with the "N passed, M failed" line the runner parses.
//
// It manipulates the singleton storage_budget row and cleans up after itself,
// resetting the row to a known state before each group so groups do not leak
// into one another.

const knex = require('../../src/db');
const budget = require('../../src/services/storageBudget');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Put the ledger into a known state. `init` false leaves the period null so the
// fail-closed paths can be exercised.
async function resetBudget({ init = true, committed = 0, reserved = 0, debt = 0, a = 0, b = 0 } = {}) {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: committed,
    reserved_bytes: reserved,
    cleanup_debt_bytes: debt,
    class_a_used: a,
    class_b_used: b,
    period_start: init ? knex.raw("now() - interval '1 day'") : null,
    period_end: init ? knex.raw("now() + interval '29 days'") : null,
    period_source: 'assumed',
  });
}

async function liveBytes() {
  const s = await budget.snapshot();
  return s.bytes.live;
}

async function main() {
  // Guard: this suite needs the migration applied.
  const hasRow = await knex('storage_budget').where({ id: true }).first();
  if (!hasRow) {
    console.log('  FAIL  storage_budget row missing — run `npx knex migrate:latest`');
    console.log('\n0 passed, 1 failed');
    process.exit(1);
  }

  console.log('\n--- fail closed when the ledger is not initialised ---');
  await resetBudget({ init: false });
  // A null period is "not initialised": no spend may happen.
  let threw = null;
  try { await budget.reserveBytes(1000); } catch (e) { threw = e; }
  t('reserveBytes refuses an uninitialised budget', threw && threw.budgetUninitialised);
  threw = null;
  try { await budget.charge('put'); } catch (e) { threw = e; }
  t('charge refuses an uninitialised budget', threw && threw.budgetUninitialised);

  console.log('\n--- operation classification, unknown ops fail closed ---');
  t('put is Class A', budget.classOf('put') === 'a');
  t('list is Class A', budget.classOf('list') === 'a');
  t('copy is Class A', budget.classOf('copy') === 'a');
  t('get is Class B', budget.classOf('get') === 'b');
  t('head is Class B', budget.classOf('head') === 'b');
  t('delete is free', budget.classOf('delete') === 'free');
  t('an unknown op is unclassified (fails closed)', budget.classOf('teleport') === null);
  await resetBudget({ init: true });
  threw = null;
  try { await budget.charge('teleport'); } catch (e) { threw = e; }
  t('charging an unclassified op throws budgetExceeded', threw && threw.budgetExceeded && threw.kind === 'unclassified');
  // A free op never touches the counters.
  await resetBudget({ init: true, a: 5, b: 5 });
  await budget.charge('delete');
  let snap = await budget.snapshot();
  t('a free delete charges nothing', snap.class_a.used === 5 && snap.class_b.used === 5);

  console.log('\n--- reserve/commit/release conserve the totals ---');
  await resetBudget({ init: true });
  await budget.reserveBytes(1_000_000);
  snap = await budget.snapshot();
  t('reserve raises reserved and live', snap.bytes.reserved === 1_000_000 && snap.bytes.live === 1_000_000);
  t('reserve does not touch committed', snap.bytes.committed === 0);
  await budget.commitReservedBytes(1_000_000);
  snap = await budget.snapshot();
  t('commit moves reserved -> committed, live unchanged',
    snap.bytes.committed === 1_000_000 && snap.bytes.reserved === 0 && snap.bytes.live === 1_000_000);

  await resetBudget({ init: true });
  await budget.reserveBytes(500_000);
  await budget.releaseReservedBytes(500_000);
  snap = await budget.snapshot();
  t('release returns the reservation, live back to zero', snap.bytes.live === 0 && snap.bytes.reserved === 0);

  console.log('\n--- the ledger can never read negative ---');
  await resetBudget({ init: true, reserved: 100 });
  const rel = await budget.releaseReservedBytes(1000); // more than reserved
  snap = await budget.snapshot();
  t('over-release clamps at zero, never negative', snap.bytes.reserved === 0);
  t('over-release reports the shortfall', rel.shortfall === 900);
  // committing more than reserved is a bug and must be visible, not invented.
  await resetBudget({ init: true, reserved: 100 });
  threw = null;
  try { await budget.commitReservedBytes(1000); } catch (e) { threw = e; }
  t('committing more than reserved throws ledgerInconsistent', threw && threw.ledgerInconsistent);

  console.log('\n--- THE RACE: concurrent reservations cannot exceed the ceiling ---');
  // Set the ceiling low by exhausting most of it, leaving room for exactly
  // three reservations of the test size, then fire twelve at once. Exactly
  // three must succeed; the rest must be refused; live must never exceed the
  // limit and must never read as an over-count.
  const LIMIT = budget.LIMITS.maxTotalBytes;
  const CHUNK = 1_000_000; // 1 MB
  const ROOM_FOR = 3;
  const preload = LIMIT - ROOM_FOR * CHUNK;
  await resetBudget({ init: true, committed: preload });
  const attempts = 12;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, () => budget.reserveBytes(CHUNK)),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const refused = results.filter((r) => r.status === 'rejected'
    && r.reason && r.reason.budgetExceeded).length;
  snap = await budget.snapshot();
  t(`exactly ${ROOM_FOR} of ${attempts} concurrent reservations succeed`, ok === ROOM_FOR, `got ${ok}`);
  t('every refusal is a budgetExceeded, not a crash', refused === attempts - ROOM_FOR, `got ${refused}`);
  t('live never exceeds the limit after the race', snap.bytes.live <= LIMIT, `live=${snap.bytes.live} limit=${LIMIT}`);
  t('live equals exactly the limit (three chunks landed)', snap.bytes.live === LIMIT, `live=${snap.bytes.live}`);

  console.log('\n--- THE RACE: concurrent operation charges cannot exceed the ceiling ---');
  // Same shape for Class A. Leave room for five, fire twenty. User traffic
  // stops at ceiling - maintenance, so preload to (that - 5).
  const aCeil = budget.LIMITS.maxClassA - budget.LIMITS.maintClassA;
  await resetBudget({ init: true, a: aCeil - 5 });
  const opResults = await Promise.allSettled(
    Array.from({ length: 20 }, () => budget.charge('put')),
  );
  const opOk = opResults.filter((r) => r.status === 'fulfilled').length;
  snap = await budget.snapshot();
  t('exactly 5 of 20 concurrent Class A charges succeed', opOk === 5, `got ${opOk}`);
  t('the Class A counter lands exactly at its user ceiling', snap.class_a.used === aCeil, `used=${snap.class_a.used}`);

  console.log('\n--- maintenance slice is protected from user traffic ---');
  // User traffic exhausted the user ceiling above; a maintenance charge may
  // still use the reserved slice.
  await resetBudget({ init: true, a: aCeil }); // user ceiling reached
  threw = null;
  try { await budget.charge('put'); } catch (e) { threw = e; }
  t('user traffic is refused at the user ceiling', threw && threw.budgetExceeded);
  const maintCharge = await budget.charge('put', { maintenance: true });
  t('maintenance may still charge into its reserved slice', maintCharge.charged === 1);

  console.log('\n--- operations are NOT refunded when an object is deleted ---');
  // Deleting an object releases BYTES but never operation counts: the read/write
  // already happened and was billed. Model it: charge a put, commit bytes, then
  // move to cleanup debt and release it — the op counter must not move.
  await resetBudget({ init: true });
  await budget.charge('put');
  await budget.reserveBytes(CHUNK);
  await budget.commitReservedBytes(CHUNK);
  await budget.moveToCleanupDebt(CHUNK);
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await budget.releaseCleanupDebt(trx, CHUNK);
  });
  snap = await budget.snapshot();
  t('bytes are fully released after cleanup confirms', snap.bytes.live === 0, `live=${snap.bytes.live}`);
  t('the Class A op count is NOT refunded by the delete', snap.class_a.used === 1, `used=${snap.class_a.used}`);

  console.log('\n--- cleanup debt keeps bytes charged until deletion confirms ---');
  await resetBudget({ init: true, committed: 2_000_000 });
  await budget.moveToCleanupDebt(2_000_000);
  snap = await budget.snapshot();
  t('moving to debt keeps live unchanged (still billed)', snap.bytes.live === 2_000_000);
  t('...but it is now debt, not committed', snap.bytes.cleanup_debt === 2_000_000 && snap.bytes.committed === 0);

  console.log('\n--- crash recovery: a reservation persists across a "restart" ---');
  // A reservation is a row update, not a number in a process. Reserve, then read
  // the ledger through a FRESH snapshot (as a restarted process would): the
  // reservation is still there. This is why reserved_bytes lives in the DB.
  await resetBudget({ init: true });
  await budget.reserveBytes(750_000);
  // Simulate "the process that reserved crashed" by never committing/releasing.
  const afterCrash = await liveBytes();
  t('a reserved-but-uncommitted upload still holds its bytes after a restart',
    afterCrash === 750_000, `live=${afterCrash}`);

  // Restore the ledger to a clean, initialised, empty state so a later real
  // run does not inherit test totals.
  await resetBudget({ init: false });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('suite crashed:', err);
  process.exit(1);
});
