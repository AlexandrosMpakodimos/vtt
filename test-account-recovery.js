// Isolated regression probes; tokens are seeded directly, email delivery is not tested.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('./src/db');
const { verifyPassword } = require('./src/services/password');
const BASE = process.env.BASE_URL;
const PASSWORD = 'correct-horse-battery-staple-9';
const users = [], findings = [];
let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; findings.push(name); console.log('  FAIL  ' + name + ' ' + detail); }
}
function client() {
  let cookie = '';
  return { async req(method, path, body) {
    const res = await fetch(BASE + path, { method, redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    let data; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, location: res.headers.get('location'), data };
  } };
}
async function user() {
  const c = client(), email = crypto.randomUUID() + '@example.com';
  const registered = await c.req('POST', '/api/auth/register', {
    email, username: 'rec' + crypto.randomBytes(5).toString('hex'), password: PASSWORD,
  });
  assert.equal(registered.status, 201, 'register: ' + JSON.stringify(registered));
  const row = await knex('users').where({ email }).first();
  assert(row); users.push(row.id);
  await knex('users').where({ id: row.id }).update({ email_verified_at: knex.fn.now() });
  assert.equal((await c.req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 200);
  return { id: row.id, email, c };
}
async function token(u, purpose = 'reset', expired = false) {
  const raw = crypto.randomBytes(32).toString('hex');
  const row = { user_id: u.id, token_hash: crypto.createHash('sha256').update(raw).digest('hex'),
    expires_at: new Date(Date.now() + (expired ? -60000 : 3600000)) };
  if (purpose !== 'reset') row.purpose = purpose;
  await knex(purpose === 'reset' ? 'password_reset_tokens' : 'email_verification_tokens').insert(row);
  return raw;
}
const reset = (raw, password) => client().req('POST', '/api/auth/reset-password', { token: raw, password });
const emailConfirm = raw => client().req('GET', '/api/auth/verify-email-change?token=' + raw);
const readUser = u => knex('users').where({ id: u.id }).first();
function counts(results, field = 'status') {
  const out = {}; for (const r of results) out[r[field]] = (out[r[field]] || 0) + 1;
  return JSON.stringify(out);
}
(async () => {
  try {
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(BASE, 'http://127.0.0.1:3001');
    const identity = await (await fetch(BASE + '/__test/identity')).json();
    assert.equal(identity.database, 'vtt_test'); assert.equal(identity.role, 'vtt_test_runner');
    assert.equal(identity.storageBackend, 'memory');

    console.log('\n--- Reset validity and sequential replay ---');
    const a = await user();
    const expired = await token(a, 'reset', true);
    check('expired reset is rejected', (await reset(expired, 'expired-token-password-7')).status === 400);
    check('invalid reset is rejected', (await reset('invalid', 'invalid-token-password-7')).status === 400);
    check('rejected tokens leave password unchanged', await verifyPassword((await readUser(a)).password_hash, PASSWORD));
    const raw = await token(a), sibling = await token(a);
    check('valid reset succeeds', (await reset(raw, 'replacement-password-one-7')).status === 200);
    check('new password is stored', await verifyPassword((await readUser(a)).password_hash, 'replacement-password-one-7'));
    check('used reset cannot be replayed', (await reset(raw, 'replayed-password-two-7')).status === 400);
    check('successful reset invalidates another outstanding reset', (await reset(sibling, 'sibling-password-three-7')).status === 400);
    check('replays leave the successful password intact', await verifyPassword((await readUser(a)).password_hash, 'replacement-password-one-7'));

    console.log('\n--- One reset token used concurrently ---');
    const b = await user(), racedToken = await token(b);
    const passwords = Array.from({ length: 4 }, (_, i) => 'concurrent-recovery-password-' + i + '-7');
    const responses = await Promise.all(passwords.map(p => reset(racedToken, p)));
    console.log('  NOTE  reset response counts ' + counts(responses));
    check('one token authorizes exactly one concurrent reset', responses.filter(r => r.status === 200).length === 1);
    check('concurrent reset losers are rejected without server errors', responses.every(r => [200,400,409].includes(r.status)));
    const winners = responses.map((r,i) => r.status === 200 ? i : -1).filter(i => i >= 0);
    const storedHash = (await readUser(b)).password_hash;
    check('stored password matches the sole successful request', winners.length === 1 && await verifyPassword(storedHash, passwords[winners[0]]));

    console.log('\n--- Different outstanding reset tokens race ---');
    const siblingUser = await user();
    const siblingTokens = [await token(siblingUser), await token(siblingUser)];
    const siblingPasswords = ['first-outstanding-token-password-7', 'second-outstanding-token-password-7'];
    const siblingResults = await Promise.all(siblingTokens.map((t,i) => reset(t, siblingPasswords[i])));
    console.log('  NOTE  sibling reset response counts ' + counts(siblingResults));
    const siblingWinners = siblingResults.map((r,i) => r.status === 200 ? i : -1).filter(i => i >= 0);
    check('different reset tokens cannot both win', siblingWinners.length === 1);
    check('sibling token losers are rejected without server errors', siblingResults.every(r => [200,400,409].includes(r.status)));
    check('password belongs to the sole sibling-token winner', siblingWinners.length === 1 && await verifyPassword((await readUser(siblingUser)).password_hash, siblingPasswords[siblingWinners[0]]));

    console.log('\n--- Password change races with reset ---');
    const mixedUser = await user(), mixedToken = await token(mixedUser);
    const mixedPasswords = ['authenticated-change-password-8', 'competing-reset-password-8'];
    const mixedResults = await Promise.all([
      mixedUser.c.req('POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: mixedPasswords[0] }),
      reset(mixedToken, mixedPasswords[1]),
    ]);
    console.log('  NOTE  password-change/reset response counts ' + counts(mixedResults));
    const mixedWinners = mixedResults.map((r,i) => r.status === 200 ? i : -1).filter(i => i >= 0);
    check('password change and reset cannot both win with old credentials', mixedWinners.length === 1);
    check('mixed credential race produces no server errors', mixedResults.every(r => [200,400,401,409].includes(r.status)));
    check('password belongs to the sole mixed-race winner', mixedWinners.length === 1 && await verifyPassword((await readUser(mixedUser)).password_hash, mixedPasswords[mixedWinners[0]]));

    console.log('\n--- Existing reset after authenticated password change ---');
    const c = await user(), oldReset = await token(c);
    assert.equal((await c.c.req('POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'changed-by-owner-password-8' })).status, 200);
    const stale = await reset(oldReset, 'changed-by-old-link-password-8');
    check('password change invalidates older reset links', [400,409].includes(stale.status), 'status ' + stale.status);
    check('old reset link cannot overwrite the changed password', await verifyPassword((await readUser(c)).password_hash, 'changed-by-owner-password-8'));

    console.log('\n--- Email confirmation validity and concurrent reuse ---');
    const d = await user(), destination = crypto.randomUUID() + '@example.com';
    await knex('users').where({ id: d.id }).update({ pending_email: destination });
    const emailExpired = await token(d, 'email_change', true);
    check('expired email confirmation is rejected', (await emailConfirm(emailExpired)).location === '/?email_changed=invalid');
    check('expired email token leaves address unchanged', (await readUser(d)).email === d.email);
    const oldAddressReset = await token(d);
    const emailToken = await token(d, 'email_change');
    const wrongPurpose = await client().req('GET', '/api/auth/verify-email?token=' + emailToken);
    check('signup verification refuses an email-change token', wrongPurpose.location === '/?verified=invalid');
    const emailRace = await Promise.all(Array.from({ length: 4 }, () => emailConfirm(emailToken)));
    console.log('  NOTE  email confirmation redirects ' + counts(emailRace, 'location'));
    check('email token reports success only once under concurrency', emailRace.filter(r => r.location === '/?email_changed=1').length === 1);
    check('email confirmation race produces no server errors', emailRace.every(r => r.status === 302));
    check('confirmed email is saved and pending address cleared', (await readUser(d)).email === destination && (await readUser(d)).pending_email === null);
    check('email token cannot be replayed sequentially', (await emailConfirm(emailToken)).location === '/?email_changed=invalid');
    check('confirmed email change invalidates reset links for the former address', (await reset(oldAddressReset, 'old-email-reset-password-8')).status === 400);
    check('old-email reset leaves password unchanged', await verifyPassword((await readUser(d)).password_hash, PASSWORD));

    console.log('\n--- New email-change request invalidates older link ---');
    const e = await user(), oldEmail = await token(e, 'email_change');
    await knex('users').where({ id: e.id }).update({ pending_email: crypto.randomUUID() + '@example.com' });
    const request = await e.c.req('POST', '/api/auth/change-email', {
      currentPassword: PASSWORD, newEmail: crypto.randomUUID() + '@example.com',
    });
    assert.equal(request.status, 200, 'email change setup');
    check('new email-change request invalidates previous link', (await emailConfirm(oldEmail)).location === '/?email_changed=invalid');
    check('old link cannot confirm a replacement address', (await readUser(e)).email === e.email);
  } catch (error) { fail++; console.error('SUITE ERROR:', error); }
  finally {
    try {
      for (const id of users) await knex('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [id]).del();
      if (users.length) await knex('users').whereIn('id', users).del();
    } catch (error) { fail++; console.error('Cleanup failed:', error); }
    await knex.destroy();
    if (findings.length) console.log('\nFINDINGS:\n' + findings.map(f => '  - ' + f).join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  }
})();
