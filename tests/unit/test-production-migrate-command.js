const assert = require('node:assert/strict');
const { run } = require('../../scripts/migrate-production');
const env = { NODE_ENV: 'production', DIRECT_DATABASE_URL: 'postgresql://runner:sentinel-secret@ep-example.eu-central-1.aws.neon.tech/vtt?sslmode=verify-full' };
let passed = 0;
(async () => {
  let created = 0, destroyed = 0, migrated = 0;
  const output = [];
  const makeKnex = config => {
    created++; assert.equal(config.pool.max, 2); assert.equal(config.migrations.schemaName, 'public');
    return { raw: async () => ({ rows: [{ shadowed: false }] }), migrate: { latest: async () => { migrated++; return [1, ['fixture.js']]; } }, destroy: async () => { destroyed++; } };
  };
  assert.equal(await run({ env, makeKnex, log: x => output.push(x), error: x => output.push(x) }), 0); passed++;
  assert.deepEqual([created, migrated, destroyed], [1, 1, 1]); passed++;
  assert.equal(await run({ env: { NODE_ENV: 'production', DATABASE_URL: env.DIRECT_DATABASE_URL }, makeKnex, error: x => output.push(x) }), 1); passed++;
  assert.equal(created, 1); passed++;
  assert.equal(await run({ env: { ...env, NODE_ENV: 'test' }, makeKnex, error: x => output.push(x) }), 1); passed++;
  for (const cause of [Object.assign(new Error('sentinel-secret'), { code: '28P01' }), Object.assign(new Error('sentinel-secret'), { name: 'MigrationLocked' }), new Error('sentinel-secret')]) {
    assert.equal(await run({ env, makeKnex: () => ({ raw: async () => ({ rows: [{ shadowed: false }] }), migrate: { latest: async () => { throw cause; } }, destroy: async () => { destroyed++; } }), error: x => output.push(x) }), 1); passed++;
  }
  assert.equal(destroyed, 4); passed++;
  assert(!output.join('\n').includes('sentinel-secret')); passed++;
  let calls = 0;
  assert.equal(await run({ env, makeKnex: () => ({ raw: async () => ({ rows: [{ shadowed: true }] }), migrate: { latest: async () => { calls++; } }, destroy: async () => {} }), error: x => output.push(x) }), 1); passed++;
  assert.equal(calls, 0); passed++;
  console.log(`${passed} passed, 0 failed`);
})().catch(() => { console.error('Production migration command tests failed'); process.exitCode = 1; });
