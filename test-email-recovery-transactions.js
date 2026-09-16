const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('./src/routes/auth'), 'utf8');
let passed = 0;
function check(value, name) { assert(value, name); passed++; }
async function run(mode, options = {}) {
  const calls = []; let handler, redirect, forwarded, committed = false;
  const user = { id: 'u', email: 'old@example.com', pending_email: 'next@example.com', password_hash: 'hash' };
  const token = { id: 't', user_id: 'u', expires_at: new Date(Date.now() + 60000), used_at: null };
  function query(table, transaction = false) {
    let lookupByEmail = false;
    const q = {
      where(fields) { lookupByEmail = fields.email !== undefined; return q; },
      whereNot() { return q; },
      forUpdate() { calls.push('lock:' + table); return q; },
      async first() {
        if (table === 'users') {
          if (lookupByEmail) return options.taken ? { id: 'other' } : undefined;
          return options.changedAccount ? { ...user, email: 'changed@example.com' } : user;
        }
        if (transaction && options.tokenMissing) return null;
        if (transaction && options.tokenUsed) return { ...token, used_at: new Date() };
        if (transaction && options.tokenExpired) return { ...token, expires_at: new Date(0) };
        return token;
      },
      async update(patch) { calls.push('update:' + table); if (table === 'users') calls.push('pending:' + patch.pending_email); },
      async del() { calls.push('delete:' + table); },
      async insert(row) { calls.push('insert:' + table); },
    }; return q;
  }
  const knex = table => query(table);
  knex.transaction = async work => {
    const trx = table => query(table, true);
    trx.raw = () => 'expiry'; trx.fn = { now: () => 'now' };
    const result = await work(trx);
    if (options.failCommit) throw new Error('commit failure');
    committed = true; calls.push('commit'); return result;
  };
  const context = { knex, crypto, process: { env: {} }, console,
    sha256: v => v, sendEmailChangeEmail: async () => { assert(committed); calls.push('mail'); },
    sendPasswordResetEmail: async () => { assert(committed); calls.push('mail'); },
    router: { get(path, fn) { handler = fn; } },
  };
  vm.createContext(context);
  let value;
  if (mode === 'confirm') {
    const start = source.indexOf("router.get('/verify-email-change'");
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    await handler({ query: { token: 'raw' } }, { redirect(value) { assert(committed || options.failCommit); redirect=value; } }, err => { forwarded=err; });
  } else {
    const name = mode === 'issue-email' ? 'issueEmailChangeEmail' : 'issuePasswordResetEmail';
    const start = source.indexOf('async function ' + name + '(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    try { value = await context[name](user, 'next@example.com'); } catch (err) { forwarded=err; }
  }
  return { calls, redirect, forwarded, value };
}
(async () => {
  for (const mode of ['issue-email','issue-reset']) {
    let r = await run(mode);
    check(!r.forwarded && r.calls.includes('mail'), mode + ' mails after commit');
    check(r.calls[0] === 'lock:users', mode + ' shares recovery lock');
    check(r.calls.some(c => c.startsWith('delete:')) && r.calls.some(c => c.startsWith('insert:')), mode + ' replaces tokens together');
    r = await run(mode, { failCommit: true });
    check(r.forwarded && !r.calls.includes('mail'), mode + ' failed commit sends no email');
    r = await run(mode, { changedAccount: true });
    check(!r.forwarded && !r.calls.includes('mail') && !r.calls.some(c => /^(update|delete|insert):/.test(c)), mode + ' stale account snapshot refused');
  }
  let r = await run('confirm');
  check(!r.forwarded && r.redirect === '/?email_changed=1', 'confirmation succeeds after commit');
  check(r.calls.includes('delete:password_reset_tokens'), 'confirmation invalidates reset links for old email');
  for (const option of ['tokenMissing','tokenUsed','tokenExpired']) {
    r = await run('confirm', { [option]: true });
    check(!r.forwarded && r.redirect === '/?email_changed=invalid', option + ' rechecked inside transaction');
    check(!r.calls.some(c => /^(update|delete):/.test(c)), option + ' leaves account untouched');
  }
  r = await run('confirm', { taken: true });
  check(r.redirect === '/?email_changed=taken' && !r.calls.some(c => /^(update|delete):/.test(c)), 'taken address leaves token and account untouched');
  r = await run('confirm', { failCommit: true });
  check(r.forwarded && !r.redirect, 'failed commit never reports confirmed email');
  console.log(`${passed} passed, 0 failed`);
})().catch(err => { console.error(err); console.log(`${passed} passed, 1 failed`); process.exitCode=1; });
