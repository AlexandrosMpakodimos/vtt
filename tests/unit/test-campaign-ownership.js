// Controlled transaction tests. Real PostgreSQL races are covered separately.
const { createCampaignOperations } = require('../../src/services/campaigns/operations');
const { createCampaignMutationHandlers } = require('../../src/routes/campaignMutations');
const assert = require('node:assert/strict');
let passed = 0;
function check(value, message) { assert(value, message); passed++; }
const serialization = () => Object.assign(new Error('serialization failure'), { code: '40001' });
async function run(mode, options = {}) {
  const recent = new Date(Date.now() - 1000).toISOString();
  let rows = [{ id: 'subject', owner_id: 'caller', deleted_at: mode === 'restore' ? recent : null }];
  const recipient = mode === 'restore' ? 'caller' : 'target';
  for (let i = 0; i < (options.count ?? 19); i++) rows.push({ id: 'f' + i, owner_id: recipient, deleted_at: null });
  if (options.expired) rows[0].deleted_at = new Date(Date.now() - 31 * 86400000).toISOString();
  if (options.missing) rows.shift();
  if (options.subject) Object.assign(rows[0], options.subject);
  let members = [{ campaign_id: 'subject', user_id: 'target', status: options.memberStatus || 'active' }];
  let attempts = 0, waits = [], isolation = [], reads = [], writes = 0, replies = 0, forwarded, inTransaction = false;
  function query(table, state, activeMembers, transaction) {
    const conditions = [];
    let count = false, patch;
    const q = {
      where(fields) { conditions.push(row => Object.entries(fields).every(([k,v]) => row[k] === v)); return q; },
      whereNull(key) { conditions.push(row => row[key] == null); return q; },
      forUpdate() { return q; }, count() { count = true; return q; },
      async first() {
        reads.push({ table, transaction });
        const matches = (table === 'campaigns' ? state : activeMembers).filter(row => conditions.every(fn => fn(row)));
        return count ? { n: matches.length } : matches[0] && { ...matches[0] };
      },
      update(value) { patch = value; return q; },
      async returning() {
        assert(transaction, 'ownership writes must use a transaction');
        writes++;
        return state.filter(row => conditions.every(fn => fn(row))).map(row => Object.assign(row, patch));
      },
    };
    return q;
  }
  const knex = table => query(table, rows, members, false);
  knex.fn = { now: () => new Date().toISOString() };
  knex.transaction = async work => {
    attempts++;
    if (attempts > 1 && options.onRetry) options.onRetry(rows, members);
    const working = rows.map(row => ({ ...row }));
    const trx = table => query(table, working, members.map(m => ({ ...m })), true);
    trx.fn = knex.fn;
    trx.raw = async sql => { isolation.push(sql); };
    inTransaction = true;
    try {
      const result = await work(trx);
      const error = options.error?.(attempts);
      if (error) throw error;
      rows = working;
      return result;
    } finally { inTransaction = false; }
  };
  const operations = createCampaignOperations({
    knex, validCampaignId: id => ['subject','caller','target'].includes(id),
    MAX_CAMPAIGNS_PER_USER: 20,
    random: () => 0.5, sleep: async ms => { waits.push(ms); },
  });
  const handlers = createCampaignMutationHandlers({
    operations,
    gateway: { sendJson(req, res, body) { assert(!inTransaction, 'respond only after commit'); replies++; return res.json(body); } },
  });
  const res = { statusCode: 200, headers: {}, status(n) { this.statusCode=n; return this; },
    set(k,v) { this.headers[k]=v; return this; }, json(body) { assert(!inTransaction); this.body=body; return this; } };
  await handlers[mode]({ params: { id: 'subject' }, campaign: { id: 'subject', owner_id: 'caller' }, user: { id: 'caller' }, body: { user_id: options.targetId || 'target' } }, res, error => { forwarded=error; });
  return { res, rows, attempts, waits, isolation, reads, writes, replies, forwarded };
}
(async () => {
  for (const mode of ['transfer', 'restore']) {
    let r = await run(mode, { count: 20 });
    check(!r.forwarded && r.res.statusCode === 409, mode + ' refuses a full owner');
    check(r.writes === 0, mode + ' leaves row untouched at cap');
    r = await run(mode);
    check(!r.forwarded && r.res.statusCode === 200 && r.replies === 1, mode + ' succeeds below cap');
    check(r.reads.every(read => read.transaction), mode + ' checks state and count in transaction');
    check(r.isolation.length === 1 && /SERIALIZABLE/.test(r.isolation[0]), mode + ' uses serializable isolation');
    check(r.rows.filter(row => row.owner_id === (mode === 'restore' ? 'caller' : 'target') && !row.deleted_at).length === 20, mode + ' ends exactly at cap');
    r = await run(mode, { error: n => n === 1 ? serialization() : null,
      onRetry: rows => rows.push({ id: 'competitor', owner_id: mode === 'restore' ? 'caller' : 'target', deleted_at: null }) });
    check(!r.forwarded && r.res.statusCode === 409 && r.attempts === 2, mode + ' rechecks capacity after failed commit');
    check(r.rows[0].owner_id === 'caller' && (mode !== 'restore' || r.rows[0].deleted_at), mode + ' rolled-back update is not persisted');
    r = await run(mode, { error: serialization });
    check(!r.forwarded && r.res.statusCode === 409 && r.res.body.code === 'campaign_ownership_busy' && r.res.body.retryable === true, mode + ' exhaustion has retryable conflict');
    check(r.attempts === 6 && r.waits.length === 5 && r.res.headers['Retry-After'] === '1', mode + ' bounds retries');
    check(r.waits.every((ms,i) => ms >= 10 * 2 ** i && ms < 20 * 2 ** i), mode + ' bounded jitter');
    check(r.replies === 0 && r.rows[0].owner_id === 'caller' && (mode !== 'restore' || r.rows[0].deleted_at), mode + ' no success or mutation after failed commits');
    r = await run(mode, { error: n => n < 6 ? serialization() : null });
    check(!r.forwarded && r.res.statusCode === 200 && r.replies === 1 && r.attempts === 6, mode + ' final retry can succeed');
    r = await run(mode, { subject: { owner_id: 'stranger' } });
    check(!r.forwarded && r.res.statusCode === 404 && r.writes === 0, mode + ' rechecks current owner');
    r = await run(mode, { error: n => n === 1 ? serialization() : null,
      onRetry: rows => { rows[0].owner_id = 'stranger'; } });
    check(!r.forwarded && r.res.statusCode === 404 && r.attempts === 2, mode + ' rechecks owner on retry');
    const unrelated = Object.assign(new Error('connection lost'), { code: '08006' });
    r = await run(mode, { error: () => unrelated });
    check(r.forwarded === unrelated && r.attempts === 1, mode + ' unrelated errors propagate');
  }
  for (const status of ['left', 'banned']) {
    const r = await run('transfer', { memberStatus: status });
    check(!r.forwarded && r.res.statusCode === 409 && r.writes === 0, 'transfer refuses ' + status + ' member');
  }
  let r = await run('transfer', { error: n => n === 1 ? serialization() : null,
    onRetry: (rows, members) => { members[0].status = 'left'; } });
  check(!r.forwarded && r.res.statusCode === 409 && r.attempts === 2, 'transfer rechecks target membership');
  r = await run('transfer', { subject: { deleted_at: new Date().toISOString() } });
  check(!r.forwarded && r.res.statusCode === 404 && r.writes === 0, 'transfer refuses newly deleted campaign');
  r = await run('restore', { expired: true });
  check(!r.forwarded && r.res.statusCode === 410 && r.writes === 0, 'restore retains expiry rule');
  r = await run('restore', { subject: { deleted_at: null } });
  check(!r.forwarded && r.res.statusCode === 404 && r.writes === 0, 'restore refuses already live campaign');
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
