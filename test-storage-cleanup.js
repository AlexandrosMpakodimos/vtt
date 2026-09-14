// Cleanup worker — durable deletion queue, against a real Postgres, NO server.
//
//   SKIP_HIBP=1 node test-storage-cleanup.js
//
// storage.remove() is stubbed so success and failure are deterministic and no
// bucket is needed: the property under test is the QUEUE's behaviour — exactly-
// once debt release, lease ownership, backoff on failure, no double-processing —
// not R2 itself. isConfigured is stubbed true so the worker does not no-op.

const knex = require('./src/db');
const storage = require('./src/services/storage');
const budget = require('./src/services/storageBudget');

// Stub storage before requiring the worker (it captures the reference at call
// time, so stubbing the exported functions is enough).
let removeBehaviour = () => true; // default: deletes succeed
storage.remove = async (key) => removeBehaviour(key);
storage.isConfigured = () => true;

const cleanup = require('./src/services/storageCleanup.js');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

async function resetAll() {
  await knex('storage_cleanup').del();
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0,
    class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"),
    period_end: knex.raw("now() + interval '29 days'"),
  });
}

async function main() {
  if (!(await knex('storage_budget').where({ id: true }).first())) {
    console.log('  FAIL  run migrations first'); console.log('\n0 passed, 1 failed'); process.exit(1);
  }

  console.log('\n--- a successful delete releases debt exactly once and removes the row ---');
  await resetAll();
  // an object worth 3 MB is in cleanup debt, queued
  await knex('storage_budget').where({ id: true }).update({ cleanup_debt_bytes: 3_000_000 });
  await knex('storage_cleanup').insert({ storage_key: 'c/x/map/a.png', bytes: 3_000_000, reason: 'delete_failed' });
  removeBehaviour = () => true;
  let r = await cleanup.tick();
  t('the tick deleted one object', r.deleted === 1, JSON.stringify(r));
  let snap = await budget.snapshot();
  t('the debt was released to zero', snap.bytes.cleanup_debt === 0, `debt=${snap.bytes.cleanup_debt}`);
  const remaining = await knex('storage_cleanup').count({ n: '*' }).first();
  t('the queue row is gone', Number(remaining.n) === 0);

  console.log('\n--- a failed delete keeps the debt and backs off ---');
  await resetAll();
  await knex('storage_budget').where({ id: true }).update({ cleanup_debt_bytes: 2_000_000 });
  await knex('storage_cleanup').insert({ storage_key: 'c/x/map/b.png', bytes: 2_000_000, reason: 'delete_failed' });
  removeBehaviour = () => false; // deletion keeps failing
  r = await cleanup.tick();
  t('a failed delete deletes nothing', r.deleted === 0);
  snap = await budget.snapshot();
  t('the debt is still charged after a failed delete', snap.bytes.cleanup_debt === 2_000_000);
  const stuck = await knex('storage_cleanup').first();
  t('attempts incremented', Number(stuck.attempts) === 1, `attempts=${stuck.attempts}`);
  t('next_attempt_at was pushed into the future', new Date(stuck.next_attempt_at) > new Date());
  t('the lease was released for retry', stuck.leased_by === null && stuck.leased_until === null);

  console.log('\n--- a retry after the object finally deletes releases exactly once ---');
  // make it due again, then let the delete succeed
  await knex('storage_cleanup').update({ next_attempt_at: knex.raw('now()') });
  removeBehaviour = () => true;
  r = await cleanup.tick();
  t('the retry deletes the object', r.deleted === 1);
  snap = await budget.snapshot();
  t('debt released to zero on success', snap.bytes.cleanup_debt === 0, `debt=${snap.bytes.cleanup_debt}`);
  // a duplicate tick must not release again (row is gone, debt already 0)
  r = await cleanup.tick();
  snap = await budget.snapshot();
  t('a duplicate tick cannot drive debt negative', snap.bytes.cleanup_debt === 0);

  console.log('\n--- an unknown-size row (null bytes) deletes without releasing phantom bytes ---');
  await resetAll();
  await knex('storage_budget').where({ id: true }).update({ cleanup_debt_bytes: 500 });
  await knex('storage_cleanup').insert({ storage_key: 'u/y/avatar/c.png', bytes: null, reason: 'orphan_pending' });
  removeBehaviour = () => true;
  r = await cleanup.tick();
  t('the null-size object is deleted', r.deleted === 1);
  snap = await budget.snapshot();
  t('unrelated debt is untouched (null bytes releases nothing)', snap.bytes.cleanup_debt === 500,
    `debt=${snap.bytes.cleanup_debt}`);

  console.log('\n--- leasing: a claimed row is not reclaimed by a concurrent tick ---');
  await resetAll();
  // queue 3 rows; make remove hang-then-succeed so we can observe the lease.
  for (const k of ['k1', 'k2', 'k3']) {
    // eslint-disable-next-line no-await-in-loop
    await knex('storage_cleanup').insert({ storage_key: k, bytes: null, reason: 'orphan_pending' });
  }
  // Two ticks fired concurrently must not both process the same row: total
  // deletions across both must equal the number of rows, never more.
  removeBehaviour = () => true;
  const [rA, rB] = await Promise.all([cleanup.tick(), cleanup.tick()]);
  const totalDeleted = rA.deleted + rB.deleted;
  t('two concurrent ticks delete each row at most once', totalDeleted === 3, `deleted=${totalDeleted}`);
  const left = await knex('storage_cleanup').count({ n: '*' }).first();
  t('the queue is fully drained', Number(left.n) === 0);

  console.log('\n--- backoff schedule is bounded ---');
  t('attempt 1 -> 2 min', cleanup.nextDelayMinutes(1) === 2);
  t('attempt 3 -> 8 min', cleanup.nextDelayMinutes(3) === 8);
  t('attempt 10 caps at 60 min', cleanup.nextDelayMinutes(10) === 60);

  await knex('storage_cleanup').del();
  await knex('storage_budget').where({ id: true })
    .update({ period_start: null, period_end: null, cleanup_debt_bytes: 0 });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
