// Controlled scheduling test: actual middleware and leave/moderation handlers,
// simulated database. Ownership changes between authorization and handler entry.
// No app server, PostgreSQL, or user data is touched.
const fs = require('node:fs');
const vm = require('node:vm');
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
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(__dirname + '/src/middleware/campaignAuth.js', 'utf8'), {
    module, require(name) { assert.equal(name, '../db'); return knex; },
  }, {filename: 'campaignAuth.js'});
  const guards = module.exports;
  const routes = new Map();
  const router = {post(path, ...handlers) {routes.set(path, handlers.at(-1));}};
  const source = fs.readFileSync(__dirname + '/src/routes/campaigns.js', 'utf8');
  const leaveStart = source.indexOf("router.post('/:id/leave',");
  const leaveEnd = source.indexOf('\n});', leaveStart) + 4;
  const modStart = source.indexOf('function moderationRoute(');
  const modEnd = source.indexOf('// POST /api/campaigns/:id/members/:userId/kick', modStart);
  assert(leaveStart >= 0 && leaveEnd > leaveStart && modStart >= 0 && modEnd > modStart, 'source boundaries');
  const context = {router, knex, ...guards};
  vm.createContext(context);
  vm.runInContext(source.slice(leaveStart, leaveEnd) + '\n' + source.slice(modStart, modEnd), context);
  const req = {params: {id: CID, userId: target}, user: {id: action === 'leave' ? NEW : OLD},
    app: {get(name) {assert.equal(name, 'campaignSockets'); return {evictUser(...args) {evictions.push(args);}};}}};
  const res = {code: 200, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
  let authorized = false;
  await (action === 'leave' ? guards.requireMemberAnyState : guards.requireOwner)(req, res, err => {if (err) throw err; authorized = true;});
  assert(authorized, 'baseline middleware authorizes request');
  // Simulate a successful transfer committing during the await between the
  // middleware query and route execution. req.campaign remains the old snapshot.
  if (transfer) campaign.owner_id = NEW;
  const handler = action === 'leave' ? routes.get('/:id/leave') : context.moderationRoute(action === 'kick' ? 'left' : 'banned');
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
