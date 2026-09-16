// Exercise actual auth handlers with controlled session/transaction callbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./src/routes/auth'), 'utf8');
let passed = 0;
function check(value, message) { assert(value, message); passed++; }
async function run(route, options = {}) {
  let handler, response, forwarded, revoked = [], committed = false, queryExcept;
  const calls = [];
  const user = { id: 'user', password_hash: 'old-hash' };
  const token = { id: 'token', user_id: 'user', used_at: null, expires_at: new Date(Date.now() + 10000) };
  function query(table) {
    const q = {
      where() { return q; }, whereRaw() { return q; }, whereNull() { return q; },
      andWhereNot(column, value) { queryExcept = value; return q; },
      async first() { return table === 'users' ? user : token; },
      async update() {},
      del() { return { then(resolve) { return Promise.resolve().then(resolve); },
        async returning() { return [{ sid: 'old-a' }, { sid: 'old-b' }]; } }; },
    };
    return q;
  }
  const knex = table => query(table);
  knex.fn = { now: () => 'now' };
  knex.transaction = async work => {
    const trx = table => query(table); trx.fn = knex.fn;
    const value = await work(trx);
    if (options.failCommit) throw new Error('commit failed');
    committed = true; calls.push('commit'); return value;
  };
  const context = {
    knex, sha256: value => value, requireAuth() {},
    validatePassword: value => ({ value }), isPasswordBreached: async () => false,
    hashPassword: async () => 'new-hash', verifyPassword: async (hash, pw) => pw === 'current',
    router: { post(path, ...handlers) { handler = handlers.at(-1); } },
  };
  vm.createContext(context);
  const helper = source.indexOf('async function destroyUserSessions(');
  vm.runInContext(source.slice(helper, source.indexOf('\n}', helper) + 2), context);
  const start = source.indexOf("router.post('/" + route + "'");
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
  const req = {
    user: { id: 'user' }, sessionID: 'original', body: { token: 'raw', password: 'new', currentPassword: 'current', newPassword: 'new' },
    app: { get() { return { disconnectSessions(ids) { calls.push('disconnect'); revoked.push(...ids); } }; } },
    logout(callback) { calls.push('logout'); req.sessionID = 'regenerated'; callback(options.logoutError); },
    session: { destroy(callback) { calls.push('destroy'); callback(options.destroyError); } },
  };
  const res = { clearCookie() { calls.push('clearCookie'); }, json(body) { calls.push('response'); response = body; } };
  await handler(req, res, err => { forwarded = err; });
  return { response, forwarded, revoked, committed, queryExcept, calls };
}
(async () => {
  let r = await run('logout');
  check(r.revoked.length === 1 && r.revoked[0] === 'original', 'logout revokes original SID, not regenerated SID');
  check(!r.forwarded && r.response.ok, 'logout succeeds');
  check(r.calls.indexOf('disconnect') < r.calls.indexOf('response'), 'disconnect before logout response');
  const destroyError = new Error('store failure');
  r = await run('logout', { destroyError });
  check(r.forwarded === destroyError && !r.response, 'logout propagates destruction errors');
  check(r.revoked.includes('original'), 'old socket still disconnected after logout clears identity');
  for (const route of ['change-password','reset-password']) {
    r = await run(route);
    check(r.committed && r.response.ok && !r.forwarded, route + ' commits');
    check(r.revoked.join(',') === 'old-a,old-b', route + ' revokes only returned session IDs');
    check(r.calls.indexOf('commit') < r.calls.indexOf('disconnect') && r.calls.indexOf('disconnect') < r.calls.indexOf('response'), route + ' disconnects after commit before success');
    check(r.queryExcept === (route === 'change-password' ? 'original' : undefined), route + ' correct retained-session policy');
    r = await run(route, { failCommit: true });
    check(r.forwarded && !r.response && r.revoked.length === 0, route + ' failed commit does not revoke sockets');
  }
  console.log(`${passed} passed, 0 failed`);
})().catch(err => { console.error(err); console.log(`${passed} passed, 1 failed`); process.exitCode=1; });
