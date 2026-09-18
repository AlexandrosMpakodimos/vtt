// Real route handler, deterministic transaction failures. No database/server.
const { createCampaignOperations } = require('./src/services/campaigns/operations');
const { createCampaignMutationHandlers } = require('./src/routes/campaignMutations');
const assert = require('node:assert/strict');
let passed = 0;
function check(value, label) { assert(value, label); passed++; }

async function run({ failures = 0, phase = 'commit', code = '40001', full = false, fullOnRetry = false } = {}) {
  let attempts = 0, campaigns = 0, memberships = 0, forwarded = null;
  const waits = [], headers = {}, isolation = [];
  const failure = Object.assign(new Error('simulated database failure'), { code });
  const response = {
    statusCode: 200, body: null,
    status(n) { this.statusCode = n; return this; },
    set(k, v) { headers[k] = v; return this; },
    json(body) { this.body = body; return this; },
  };
  const knex = {
    async transaction(callback) {
      attempts++;
      let pendingCampaigns = 0, pendingMemberships = 0;
      function trx(table) {
        return {
          where() { return this; }, whereNull() { return this; }, count() { return this; },
          async first() { return { n: full || (fullOnRetry && attempts > 1) ? 20 : campaigns }; },
          insert(row) {
            if (table === 'campaign_members') {
              assert.equal(row.user_id, 'owner');
              pendingMemberships++;
              return Promise.resolve();
            }
            return { async returning() {
              if (phase === 'insert' && attempts <= failures) throw failure;
              pendingCampaigns++;
              return [{ id: 'campaign-' + attempts, ...row }];
            } };
          },
        };
      }
      trx.raw = async sql => { isolation.push(sql); };
      const result = await callback(trx);
      if (phase === 'commit' && attempts <= failures) throw failure;
      // Only the committed attempt contributes rows, as in a DB transaction.
      campaigns += pendingCampaigns; memberships += pendingMemberships;
      return result;
    },
  };
  const operations = createCampaignOperations({
    knex, MAX_CAMPAIGNS_PER_USER: 20,
    random: () => 0.5, sleep: async ms => { waits.push(ms); },
  });
  const { create: handler } = createCampaignMutationHandlers({
    operations,
    gateway: { sendJson(req, res, body, status) { return res.status(status).json(body); } },
  });
  await handler({ user: { id: 'owner' }, body: { name: 'Race', is_public: true } }, response,
    error => { forwarded = error; });
  return { attempts, campaigns, memberships, forwarded, response, headers, waits, isolation, failure };
}

(async () => {
  for (const phase of ['insert', 'commit']) {
    const exhausted = await run({ failures: 6, phase });
    check(exhausted.response.statusCode === 409 && !exhausted.forwarded,
      phase + ': exhausted retries produce a conflict instead of an unhandled error');
    check(exhausted.response.body.code === 'campaign_create_busy' && exhausted.response.body.retryable === true,
      phase + ': contention is distinguishable from a full quota');
    check(exhausted.attempts === 6 && exhausted.waits.length === 5,
      phase + ': six attempts and five waits bound the work');
    check(exhausted.campaigns === 0 && exhausted.memberships === 0,
      phase + ': failed transactions leave no partial creation');
    check(exhausted.headers['Retry-After'] === '1', phase + ': caller receives a retry hint');
    check(exhausted.waits.every((ms, i) => ms >= 10 * 2 ** i && ms <= 20 * 2 ** i),
      phase + ': exponential backoff stays within its jitter bounds');

    const recovered = await run({ failures: 5, phase });
    check(recovered.response.statusCode === 201 && !recovered.forwarded && recovered.attempts === 6,
      phase + ': the last allowed attempt can succeed');
    check(recovered.campaigns === 1 && recovered.memberships === 1,
      phase + ': retry commits exactly one campaign and owner membership');
    check(recovered.isolation.length === 6 && recovered.isolation.every(sql => sql.endsWith('SERIALIZABLE')),
      phase + ': each retry remains serializable');
  }
  const normal = await run();
  check(normal.response.statusCode === 201 && normal.attempts === 1 && normal.waits.length === 0,
    'uncontended creation has no retry delay');
  const full = await run({ full: true });
  check(full.response.statusCode === 409 && !full.response.body.retryable && full.attempts === 1,
    'full quotas retain the existing refusal');
  const filled = await run({ failures: 1, fullOnRetry: true });
  check(filled.response.statusCode === 409 && !filled.response.body.retryable && filled.attempts === 2,
    'a retry rechecks the quota filled by a concurrent request');
  const other = await run({ failures: 6, code: '08006' });
  check(other.forwarded === other.failure && other.attempts === 1 && other.waits.length === 0,
    'unrelated database errors are neither retried nor hidden as contention');
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error.message); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
