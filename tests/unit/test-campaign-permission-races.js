// Controlled scheduling test: actual middleware and leave/moderation handlers,
// simulated database. Ownership changes between authorization and handler entry.
// No app server, PostgreSQL, or user data is touched.
const { createCampaignOperations } = require('../../src/services/campaigns/operations');
const { createCampaignMutationHandlers } = require('../../src/routes/campaignMutations');
const { createCampaignAuth } = require('../../src/middleware/campaignAuthFactory');
const assert = require('node:assert/strict');
const CID = '10000000-0000-4000-8000-000000000001';
const OLD = '20000000-0000-4000-8000-000000000001';
const NEW = '20000000-0000-4000-8000-000000000002';
const OTHER = '20000000-0000-4000-8000-000000000003';
let passed = 0, failed = 0;
function check(name, ok) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? passed++ : failed++; }
async function scenario(action, transfer, target) {
  const label = `${action}: ${transfer ? 'transfer after authorization' : 'normal control'}${target === OTHER ? ' (third member)' : ''}`;
  console.log('\n--- ' + label + ' ---');
  const campaign = { id: CID, owner_id: OLD, deleted_at: null, is_open: true };
  const members = [OLD, NEW, OTHER].map(user_id => ({campaign_id: CID, user_id, status: 'active'}));
  const evictions = [];
  function knex(table) {
    const filters = [];
    const rows = () => (table === 'campaigns' ? [campaign] : table === 'campaign_members' ? members : (() => { throw new Error('Unexpected table: ' + table); })()).filter(row => filters.every(f => f(row)));
    const q = {
      where(match) { filters.push(row => Object.entries(match).every(([k,v]) => row[k] === v)); return q; },
      forUpdate() { return q; },
      whereNull(key) { filters.push(row => row[key] == null); return q; },
      first: async () => { const row = rows()[0]; return row ? {...row} : undefined; },
      update: async patch => { const selected = rows(); selected.forEach(row => Object.assign(row, patch)); return selected.length; },
    };
    return q;
  }
  knex.transaction = async work => work(knex);
  const guards = createCampaignAuth(knex);
  const operations = createCampaignOperations({ knex, validCampaignId: guards.validCampaignId });
  const handlers = createCampaignMutationHandlers({
    operations, gateway: { sendJson: (req, res, body) => res.json(body) },
  });
  const req = {params: {id: CID, userId: target}, user: {id: action === 'leave' ? NEW : OLD},
    app: {get(name) {assert.equal(name, 'campaignSockets'); return {evictUser(...args) {evictions.push(args);}};}}};
  const res = {code: 200, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
  let authorized = false;
  await (action === 'leave' ? guards.requireMemberAnyState : guards.requireOwner)(req, res, err => {if (err) throw err; authorized = true;});
  assert(authorized, 'baseline middleware authorizes request');
  // Simulate a successful transfer committing during the await between the
  // middleware query and route execution. req.campaign remains the old snapshot.
  if (transfer) campaign.owner_id = NEW;
  const handler = action === 'leave' ? handlers.leave : handlers.moderationRoute(action === 'kick' ? 'left' : 'banned');
  await handler(req, res, err => {throw err;});
  const member = members.find(row => row.user_id === target);
  console.log(`  NOTE  HTTP=${res.code}, target membership=${member.status}, evictions=${evictions.length}`);
  if (transfer) {
    check('stale request is refused', [403,404,409].includes(res.code));
    check('target remains active', member.status === 'active');
    check('refused request emits no eviction', evictions.length === 0);
  } else {
    check('authorized operation succeeds', res.code === 200);
    check('membership changes correctly', member.status === (action === 'ban' ? 'banned' : 'left'));
    check('authorized operation evicts target once', evictions.length === 1 && evictions[0][1] === target);
  }
}
(async () => {
  try {
    for (const action of ['leave','kick','ban']) await scenario(action, false, NEW);
    await scenario('leave', true, NEW);
    for (const action of ['kick','ban']) {
      await scenario(action, true, NEW);
      await scenario(action, true, OTHER);
    }
  } catch (error) {failed++; console.error('SUITE ERROR:', error);}
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
