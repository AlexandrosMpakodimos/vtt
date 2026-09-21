// Imported production operations + HTTP handlers. These transaction doubles
// control commit timing; PostgreSQL integration suites remain authoritative for
// real lock/isolation behavior. No server, database, or credentials required.
const assert = require('node:assert/strict');
const { createCampaignOperations } = require('../../src/services/campaigns/operations');
const { createCampaignMutationHandlers } = require('../../src/routes/campaignMutations');
const { createCampaignAuth } = require('../../src/middleware/campaignAuthFactory');
const { publicCampaign, publicMember, searchResult } = require('../../src/services/campaigns/presentation');
const CID = '10000000-0000-4000-8000-000000000001';
const OWNER = '20000000-0000-4000-8000-000000000001';
const PLAYER = '20000000-0000-4000-8000-000000000002';
let passed = 0;
function check(label, condition) { assert(condition, label); passed++; }
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('controlled commit was not reached')), 2000);
  })]); } finally { clearTimeout(timer); }
}

function fixture(action, { pause = false, failCommit = false, campaign = {}, body } = {}) {
  let state = {
    campaigns: [{ id: CID, owner_id: OWNER, name: 'Table', is_public: true,
      is_open: action !== 'transfer', password_hash: 'fixture-hash',
      deleted_at: action === 'restore' ? new Date(Date.now() - 1000).toISOString() : null,
      ...campaign }],
    campaign_members: [
      { campaign_id: CID, user_id: OWNER, status: 'active' },
      { campaign_id: CID, user_id: PLAYER, status: action === 'join' ? 'left' : action === 'unban' ? 'banned' : 'active' },
    ],
  };
  const reached = latch(), release = latch(), effects = [], trace = [];
  const commitError = new Error('controlled commit failure');
  let forwarded, hashing = 0, verifying = 0, transactions = 0;
  function query(table, data, transactional) {
    assert(['campaigns', 'campaign_members'].includes(table));
    const filters = [];
    let patch, inserted, counting = false, locked = false;
    const matches = () => data[table].filter(row => filters.every(f => f(row)));
    function write() {
      trace.push((transactional ? 'trx:' : 'db:') + table + ':write');
      if (inserted) {
        const row = { ...(table === 'campaigns' ? { id: CID + '-created' } : {}), ...inserted };
        data[table].push(row); return [row];
      }
      return matches().map(row => Object.assign(row, patch));
    }
    const q = {
      where(fields) { filters.push(row => Object.entries(fields).every(([k, v]) => row[k] === v)); return q; },
      whereNull(key) { filters.push(row => row[key] == null); return q; },
      forUpdate() { locked = true; return q; },
      count() { counting = true; return q; },
      async first() {
        trace.push((transactional ? 'trx:' : 'db:') + table + (locked ? ':lock' : ':read'));
        return counting ? { n: matches().length } : matches()[0] && { ...matches()[0] };
      },
      insert(row) { inserted = row; return q; },
      update(value) { patch = value; return q; },
      async returning() { return write().map(row => ({ ...row })); },
      then(resolve, reject) { return Promise.resolve().then(() => write().length).then(resolve, reject); },
    };
    return q;
  }
  const knex = table => query(table, state, false);
  knex.fn = { now: () => '2026-09-18T00:00:00Z' };
  knex.transaction = async work => {
    transactions++;
    const pending = structuredClone(state);
    const trx = table => query(table, pending, true);
    trx.fn = knex.fn;
    trx.raw = async sql => { trace.push(sql); };
    const result = await work(trx);
    reached.resolve();
    if (pause) await release.promise;
    if (failCommit) throw commitError;
    state = pending;
    trace.push('commit');
    return result;
  };
  const guards = createCampaignAuth(knex);
  const operations = createCampaignOperations({
    knex, validCampaignId: guards.validCampaignId,
    MAX_CAMPAIGNS_PER_USER: 20, MAX_PLAYERS_PER_CAMPAIGN: 8,
    hashPassword: async () => { hashing++; return 'new-fixture-hash'; },
    verifyPassword: async () => { verifying++; return true; },
  });
  const res = { statusCode: 200, headers: {},
    status(n) { this.statusCode = n; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(value) { this.body = value; effects.push(['response']); return this; },
  };
  const sockets = Object.fromEntries(['evictUser', 'evictCampaign', 'evictGamePlayers', 'broadcastLobby']
    .map(name => [name, (...args) => { effects.push([name, ...args]); }]));
  const req = { params: { id: CID, userId: PLAYER }, campaign: { id: CID, owner_id: OWNER },
    user: { id: ['join', 'leave'].includes(action) ? PLAYER : OWNER },
    body: body === undefined ? action === 'create' ? { name: 'New table', is_public: true }
      : action === 'transfer' ? { user_id: PLAYER } : { is_open: false } : body,
    app: { get(name) { assert.equal(name, 'campaignSockets'); return sockets; } },
  };
  const handlers = createCampaignMutationHandlers({ operations, gateway: {
    sendJson(request, response, value, status = 200) { return response.status(status).json(value); },
  } });
  const handler = ['kick', 'ban'].includes(action)
    ? handlers.moderationRoute(action === 'ban' ? 'banned' : 'left') : handlers[action];
  return { operations, guards, req, res, reached, release, trace, effects, commitError,
    run: () => handler(req, res, err => { forwarded = err; }),
    state: () => state, error: () => forwarded,
    counts: () => ({ hashing, verifying, transactions }),
  };
}

async function commitContract(action, failCommit) {
  const f = fixture(action, { pause: true, failCommit });
  const before = structuredClone(f.state());
  const pending = f.run();
  try {
    await bounded(f.reached.promise);
    check(action + ': no effect or response before commit', f.effects.length === 0);
    check(action + ': no committed state before release', JSON.stringify(f.state()) === JSON.stringify(before));
  } finally { f.release.resolve(); }
  await pending;
  if (failCommit) {
    check(action + ': commit error forwarded unchanged', f.error() === f.commitError);
    check(action + ': rollback has no effects or persisted writes', f.effects.length === 0 && JSON.stringify(f.state()) === JSON.stringify(before));
  } else {
    check(action + ': succeeds after commit', !f.error() && f.res.statusCode === (action === 'create' ? 201 : 200));
    const expected = {
      create: [['response']], join: [['response']], restore: [['response']], unban: [['response']],
      leave: [['evictUser', CID, PLAYER, 'left'], ['response']],
      kick: [['evictUser', CID, PLAYER], ['response']], ban: [['evictUser', CID, PLAYER], ['response']],
      patch: [['evictGamePlayers', CID, OWNER], ['broadcastLobby', CID, 'campaign:state', { campaign_id: CID, is_open: false }], ['response']],
      transfer: [['evictGamePlayers', CID, PLAYER], ['response']],
    };
    check(action + ': exact effect order and arguments', JSON.stringify(f.effects) === JSON.stringify(expected[action]));
    const locks = f.trace.filter(item => item.endsWith(':lock'));
    const expectedLocks = ['leave', 'kick', 'ban', 'transfer'].includes(action)
      ? ['trx:campaigns:lock', 'trx:campaign_members:lock']
      : ['patch', 'restore', 'unban'].includes(action) ? ['trx:campaigns:lock'] : [];
    check(action + ': lock sequence retained', JSON.stringify(locks) === JSON.stringify(expectedLocks));
    if (f.res.body.campaign) check(action + ': public response excludes hash', !('password_hash' in f.res.body.campaign));
  }
}

(async () => {
  for (const action of ['create', 'join', 'leave', 'patch', 'restore', 'transfer', 'kick', 'ban', 'unban']) {
    await commitContract(action, false);
    await commitContract(action, true);
  }
  let f = fixture('remove');
  await f.run();
  check('DELETE retains a single conditional write, no transaction', f.counts().transactions === 0 && f.state().campaigns[0].deleted_at);
  check('DELETE retains eviction and exact response', JSON.stringify(f.effects) === JSON.stringify([['evictCampaign', CID], ['response']])
    && f.res.body.message === 'campaign deleted — recoverable for 30 days');
  f = fixture('remove', { campaign: { owner_id: PLAYER } });
  await f.run();
  check('refused DELETE has no eviction', f.res.statusCode === 404 && !f.state().campaigns[0].deleted_at && f.effects.length === 1);

  f = fixture('patch', { campaign: { is_public: false }, body: { is_public: true } });
  await f.run();
  check('PATCH uses locked visibility and clears hash going public', !f.error() && f.state().campaigns[0].password_hash === null && f.res.body.campaign.has_password === false);
  f = fixture('patch', { body: { is_public: false } });
  await f.run();
  check('PATCH refuses private without a password', f.res.statusCode === 400 && f.res.body.error === 'a password is required to make a campaign private' && f.state().campaigns[0].is_public === true);
  f = fixture('patch', { body: { is_open: 'false' } });
  await f.run();
  check('PATCH retains explicit string-false support', f.res.statusCode === 200 && f.state().campaigns[0].is_open === false && f.effects[0][0] === 'evictGamePlayers');
  f = fixture('patch', { body: { is_open: ['false'] } });
  await f.run();
  check('PATCH rejects non-boolean forms without close effects', f.res.statusCode === 400 && f.effects.length === 1 && f.state().campaigns[0].is_open === true);
  f = fixture('patch', { body: { name: 'Renamed' } });
  await f.run();
  check('rename sends no lobby state', f.res.statusCode === 200 && f.effects.length === 1);
  f = fixture('patch', { body: { is_open: true } });
  await f.run();
  check('reopen notifies lobby without restoring subscriptions', JSON.stringify(f.effects) === JSON.stringify([
    ['broadcastLobby', CID, 'campaign:state', { campaign_id: CID, is_open: true }], ['response'],
  ]));
  f = fixture('create', { body: { name: 'Table', is_public: true, password: 'roompw' } });
  await f.run();
  check('public create with password refused before DB/hash', f.res.statusCode === 400 && f.counts().transactions === 0 && f.counts().hashing === 0);
  f = fixture('join', { campaign: { is_public: false }, body: { password: 'wrong' } });
  f.state().campaign_members[1].status = 'active';
  await f.run();
  check('already-active private join skips password and capacity work', f.res.statusCode === 200 && f.counts().verifying === 0 && f.counts().transactions === 0);

  const row = { id: CID, owner_id: OWNER, password_hash: 'fixture-hash', settings: { movement: 'custom' },
    archived_at: null, is_open: false, is_public: false, owner_username: 'GM', member_count: '2' };
  check('campaign projection retains viewer/open/password/settings fields', publicCampaign(row, OWNER).is_gm
    && publicCampaign(row, PLAYER).is_gm === false && publicCampaign(row, PLAYER).is_open === false
    && publicCampaign(row, PLAYER).has_password && publicCampaign(row, PLAYER).settings === row.settings);
  check('search projection stays narrower and includes private campaigns', !('settings' in searchResult(row))
    && !('password_hash' in searchResult(row)) && searchResult(row).is_public === false && searchResult(row).member_count === 2);
  check('member projection stays allow-listed', !('password_hash' in publicMember({ user_id: PLAYER, password_hash: 'fixture-hash' })));
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
