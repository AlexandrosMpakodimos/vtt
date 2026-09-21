// Database reservation concurrency.
// Upload retries, idempotency and cleanup are tested through HTTP in test-assets.js.
// Usage: node scripts/test-local.js test-upload-controlled.js
if (process.env.NODE_ENV !== 'test') {
  throw new Error('Use the isolated test launcher.');
}

const knex = require('../../src/db');
const budget = require('../../src/services/storageBudget');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + ' ' + detail);
  }
}

(async () => {
  const identity = (await knex.raw(
    'SELECT current_database() AS database, current_user AS role'
  )).rows[0];
  if (identity.database !== 'vtt_test' || identity.role !== 'vtt_test_runner') {
    throw new Error('Unexpected database identity');
  }

  const assets = await knex('assets').whereNotNull('storage_key').count('* as n').first();
  const queue = await knex('storage_cleanup').count('* as n').first();
  if (Number(assets.n) || Number(queue.n)) {
    throw new Error('Requires an isolated test database with no hosted assets or cleanup work');
  }

  const saved = await knex('storage_budget').where({ id: true }).first();
  if (!saved || Number(saved.reserved_bytes) || Number(saved.cleanup_debt_bytes)) {
    throw new Error('Requires a ledger with no outstanding reservation or cleanup debt');
  }

  const chunk = 1000000;
  const room = 3;
  const limit = budget.LIMITS.maxTotalBytes;
  if (!Number.isSafeInteger(limit) || limit < room * chunk) {
    throw new Error('Unexpected test byte ceiling');
  }

  try {
    await knex('storage_budget').where({ id: true }).update({
      committed_bytes: limit - room * chunk,
      reserved_bytes: 0,
      period_start: knex.raw("now() - interval '1 day'"),
      period_end: knex.raw("now() + interval '1 day'"),
    });

    console.log('--- ten concurrent reservations compete for three slots ---');
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => budget.reserveBytes(chunk))
    );
    const accepted = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    const snapshot = await budget.snapshot();

    t('exactly three reservations succeed', accepted.length === room);
    t('the other seven fail with byte-budget errors',
      rejected.length === 7 &&
      rejected.every((r) => r.reason.budgetExceeded && r.reason.kind === 'bytes'));
    t('all accepted bytes are reserved',
      snapshot.bytes.reserved === room * chunk);
    t('live liability reaches the ceiling exactly',
      snapshot.bytes.live === limit);

    // Read persisted state through a separate query, not an in-memory model.
    const persisted = await knex('storage_budget').where({ id: true }).first();
    t('accepted reservations are persisted',
      Number(persisted.reserved_bytes) === room * chunk);

    const releases = await Promise.allSettled(
      accepted.map(() => budget.releaseReservedBytes(chunk))
    );
    t('each release returns exactly its own reservation',
      releases.every((r) => r.status === 'fulfilled' &&
        r.value.released === chunk && r.value.shortfall === 0));

    const released = await budget.snapshot();
    t('all reservations are released', released.bytes.reserved === 0);
    t('committed bytes remain unchanged',
      released.bytes.committed === limit - room * chunk);
  } finally {
    await knex('storage_budget').where({ id: true }).update({
      committed_bytes: saved.committed_bytes,
      reserved_bytes: saved.reserved_bytes,
      period_start: saved.period_start,
      period_end: saved.period_end,
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
})()
  .catch((error) => {
    console.error('Reservation test failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
