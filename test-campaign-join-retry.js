// Controlled failures exercise the actual join handler; HTTP races live in break-campaigns.js.
const { createCampaignOperations } = require('./src/services/campaigns/operations');
const { createCampaignMutationHandlers } = require('./src/routes/campaignMutations');
const assert = require('node:assert/strict');
let passed = 0;
function check(value, message) { assert(value, message); passed++; }
const unique = constraint => Object.assign(new Error('duplicate'), { code: '23505', constraint });
const serial = () => Object.assign(new Error('serialization'), { code: '40001' });
async function run(options = {}) {
  let attempts = 0, writes = [], waits = [], forwarded;
  const campaign = { id: 'camp', owner_id: 'owner', is_public: true };
  const existing = options.existing;
  function builder(table, transactional) {
    let counting = false;
    return {
      where() { return this; }, whereNull() { return this; },
      count() { counting = true; return this; },
      async first() {
        if (table === 'campaigns') return campaign;
        if (counting) return { n: options.full ? 8 : 1 };
        return transactional ? (options.current ? options.current(attempts) : existing) : existing;
      },
      async insert(row) { writes.push({ attempt: attempts, row }); },
      async update(row) { writes.push({ attempt: attempts, row }); },
    };
  }
  const knex = table => builder(table, false);
  knex.transaction = async callback => {
    attempts++;
    const trx = table => builder(table, true);
    trx.raw = async () => {};
    await callback(trx);
    const error = options.error?.(attempts);
    if (error) throw error;
  };
  const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
    set(k, v) { this.headers[k] = v; return this; }, json(body) { this.body = body; return this; } };
  const operations = createCampaignOperations({
    knex, validCampaignId: () => true, verifyPassword: async () => true,
    MAX_PLAYERS_PER_CAMPAIGN: 8,
    random: () => 0.5, sleep: async ms => { waits.push(ms); },
  });
  const { join: handler } = createCampaignMutationHandlers({
    operations, gateway: { sendJson(req, response, body) { return response.json(body); } },
  });
  await handler({ params: { id: 'camp' }, user: { id: 'user' }, body: { color: options.color } }, res, e => { forwarded = e; });
  return { res, attempts, writes, waits, forwarded };
}
(async () => {
  let r = await run({ error: n => n === 1 ? unique('campaign_members_pkey') : null,
    current: n => n > 1 ? { status: 'active' } : undefined });
  check(!r.forwarded && r.res.statusCode === 200, 'duplicate membership must retry successfully');
  check(r.attempts === 2, 'duplicate retries once');
  check(r.writes.length === 1, 'active membership must not be written again');

  r = await run({ color: '#abcdef', error: n => n === 1 ? unique('campaign_members_pkey') : null,
    current: n => n > 1 ? { status: 'active', color: '#123456' } : undefined });
  check(!r.forwarded && r.res.statusCode === 200 && r.writes.length === 1, 'duplicate with color must preserve existing member');

  r = await run({ existing: { status: 'left' }, error: n => n === 1 ? serial() : null,
    current: n => ({ status: n > 1 ? 'banned' : 'left' }) });
  check(!r.forwarded && r.res.statusCode === 403 && r.attempts === 2, 'ban between attempts is rechecked');

  r = await run({ full: true, current: () => ({ status: 'active' }) });
  check(r.res.statusCode === 200 && !r.forwarded, 'active member succeeds at cap');
  check(r.writes.length === 0, 'active member has no write');

  r = await run({ existing: { status: 'left' }, current: () => ({ status: 'banned' }) });
  check(r.res.statusCode === 403 && !r.forwarded, 'fresh ban must be respected');
  check(r.writes.length === 0, 'ban must not be overwritten');

  r = await run({ error: serial });
  check(r.res.statusCode === 409 && !r.forwarded, 'exhaustion is conflict not 500');
  check(r.res.body.code === 'campaign_join_busy' && r.res.body.retryable === true, 'busy response is distinct');
  check(r.res.headers['Retry-After'] === '1', 'retry header');
  check(r.attempts === 6 && r.waits.length === 5, 'bounded attempts');
  check(r.waits.every((ms, i) => ms >= 10 * 2 ** i && ms < 20 * 2 ** i), 'bounded exponential jitter');

  r = await run({ color: '#abcdef', error: n => n === 1 ? unique('campaign_members_campaign_color_unique') : null });
  check(r.res.statusCode === 200 && !r.forwarded, 'color conflict still permits join');
  check(r.writes[1].row.color === null, 'conflicting color dropped');

  r = await run({ existing: { status: 'left', color: '#abcdef' }, error: n => n === 1 ? unique('campaign_members_campaign_color_unique') : null });
  check(!r.forwarded && r.res.statusCode === 200, 'retained old color conflict recoverable');
  check(r.writes[1].row.color === null, 'returning member old color explicitly cleared');

  r = await run({ error: n => n < 6 ? serial() : null });
  check(r.res.statusCode === 200 && !r.forwarded && r.attempts === 6, 'last attempt can succeed');
  r = await run({ full: true });
  check(r.res.statusCode === 409 && !r.res.body.retryable && r.attempts === 1, 'full table retains quota response');
  r = await run({ existing: { status: 'banned' } });
  check(r.res.statusCode === 403 && r.attempts === 0, 'initial ban gate retained');
  const unrelated = unique('unrelated_constraint');
  r = await run({ color: '#abcdef', error: () => unrelated });
  check(r.forwarded === unrelated && r.attempts === 1, 'unrelated unique violations not swallowed');
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
