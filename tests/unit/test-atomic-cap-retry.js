// withAtomicCap retry policy, against a scripted fake database. No server, no DB.
//
// Regression for the 2026-10-05 break-canvas.js flake: 40 parallel pastes landed
// 460 tokens on a 500 cap because SERIALIZABLE losers retried immediately,
// collided again, ran out of attempts and surfaced as 500s. Retries must now
// back off with jitter, keep the same attempt bound, and an exhausted
// serialization failure must be reported as 503 (temporary contention).
const assert = require('node:assert/strict');
const { rootPath } = require('../helpers/paths');

let passed = 0;
function check(value, label) { assert(value, label); passed++; }

// Script the fake knex: each transaction() call takes the next behaviour.
let script = [];
let transactions = 0;
let isolation = [];
const fakeKnex = {
  async transaction(callback) {
    transactions++;
    const behaviour = script.shift() || 'ok';
    function trx() {
      return {
        where() { return this; },
        andWhere() { return this; },
        count() { return this; },
        async first() { return { n: behaviour === 'full' ? 500 : 0 }; },
        insert(rows) {
          return {
            async returning() {
              if (behaviour === '40001') {
                throw Object.assign(new Error('could not serialize access'), { code: '40001' });
              }
              if (behaviour === 'other') {
                throw Object.assign(new Error('connection lost'), { code: '08006' });
              }
              return Array.isArray(rows) ? rows : [rows];
            },
          };
        },
      };
    }
    trx.raw = async (sql) => { isolation.push(sql); };
    return callback(trx);
  },
};

// Install the fake before atomicCap loads src/db (which refuses non-test envs).
require.cache[require.resolve(rootPath('src/db/index.js'))] = {
  id: rootPath('src/db/index.js'), filename: rootPath('src/db/index.js'), loaded: true, exports: fakeKnex,
};
const {
  withAtomicCap, serializationBackoff, MAX_SERIALIZATION_RETRIES,
} = require(rootPath('src/services/atomicCap.js'));

const args = () => ({
  table: 'tokens', where: { scene_id: 's' }, max: 500,
  capMessage: 'a scene may hold at most 500 tokens',
  insert: [{ name: 'a' }, { name: 'b' }],
});

async function attempt(plan) {
  script = plan.slice(); transactions = 0; isolation = [];
  const t0 = Date.now();
  try {
    const rows = await withAtomicCap(args());
    return { rows, ms: Date.now() - t0 };
  } catch (error) {
    return { error, ms: Date.now() - t0 };
  }
}

(async () => {
  // Backoff formula: exponential base, jitter strictly below one base.
  check(serializationBackoff(0, () => 0) === 10, 'first retry waits at least 10 ms');
  check(serializationBackoff(0, () => 0.999) === 19, 'jitter stays below one base interval');
  check(serializationBackoff(4, () => 0) === 160, 'fifth retry waits at least 160 ms');
  check(MAX_SERIALIZATION_RETRIES === 5, 'attempt bound is unchanged (one try + five retries)');

  const clean = await attempt(['ok']);
  check(clean.rows && clean.rows.length === 2 && transactions === 1, 'uncontended write succeeds first time');
  check(isolation.every((sql) => /SERIALIZABLE/.test(sql)), 'every attempt runs SERIALIZABLE');

  const contended = await attempt(['40001', '40001', '40001', 'ok']);
  check(contended.rows && transactions === 4, 'a write that loses three times still lands');
  check(contended.ms >= 10 + 20 + 40, `retries back off instead of re-colliding (${contended.ms} ms)`);

  const exhausted = await attempt(['40001', '40001', '40001', '40001', '40001', '40001', 'ok']);
  check(exhausted.error && transactions === 6, 'retries stop after one try + five retries');
  check(exhausted.error.code === '40001' && exhausted.error.status === 503,
    'exhausted contention is reported as 503, not 500');

  const full = await attempt(['full']);
  check(full.error && full.error.capExceeded && transactions === 1, 'a full cap is refused, not retried');
  check(full.error.status === undefined, 'a full cap is not mislabelled as contention');

  const other = await attempt(['other']);
  check(other.error && other.error.code === '08006' && transactions === 1 && other.error.status === undefined,
    'unrelated database errors are neither retried nor relabelled');

  console.log(`${passed} passed, 0 failed`);
})().catch((error) => { console.error(error.message); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
