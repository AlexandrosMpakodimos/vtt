// Run through scripts/test-local.js: real HTTP + PostgreSQL, no storage writes.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const knex = require('./src/db');
const BASE = process.env.BASE_URL;
let passed = 0, failed = 0;
const users = [];
function check(name, condition) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name); }
}
function agent() {
  let cookie = '';
  return { async req(method, path, body) {
    const response = await fetch(BASE + path, {
      method, signal: AbortSignal.timeout(15000), headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await response.json();
    return { status: response.status, data };
  } };
}
async function makeUser() {
  const a = agent();
  const email = randomUUID() + '@example.com';
  const password = 'correct-horse-battery-staple-9';
  const registered = await a.req('POST', '/api/auth/register', {
    email, password, username: 'own' + randomUUID().replace(/-/g, '').slice(0, 10),
  });
  assert.equal(registered.status, 201, 'register: ' + JSON.stringify(registered.data));
  const row = await knex('users').where({ email }).first();
  assert(row, 'registered user exists');
  a.id = row.id; users.push(a.id);
  await knex('users').where({ id: a.id }).update({ email_verified_at: knex.fn.now() });
  const login = await a.req('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200, 'login');
  return a;
}
async function race(action, round, donor, recipient) {
  const id = randomUUID();
  await knex('campaigns').insert({ id, owner_id: donor.id, name: 'Permission race', is_public: true });
  await knex('campaign_members').insert([donor, recipient].map(user => ({
    campaign_id: id, user_id: user.id, status: 'active',
  })));
  const path = '/api/campaigns/' + id;
  const transfer = () => donor.req('POST', path + '/transfer', {user_id: recipient.id});
  const remove = () => action === 'leave'
    ? recipient.req('POST', path + '/leave', {})
    : donor.req('POST', path + '/members/' + recipient.id + '/' + action, {});
  // Alternate dispatch order; neither ordering assumes which transaction wins.
  let t, m;
  if (round % 2) [m, t] = await Promise.all([remove(), transfer()]);
  else [t, m] = await Promise.all([transfer(), remove()]);
  const campaign = await knex('campaigns').where({id}).first();
  const member = await knex('campaign_members').where({campaign_id:id, user_id:recipient.id}).first();
  const ownerMember = await knex('campaign_members').where({campaign_id:id, user_id:campaign.owner_id}).first();
  const label = action + ' round ' + (round + 1);
  console.log('  NOTE  ' + label + ': ' + JSON.stringify({transfer:t.status, membership:m.status, recipient:member.status}));
  check(label + ': exactly one transition succeeds', (t.status === 200) !== (m.status === 200));
  check(label + ': refusal has expected status',
    (t.status === 200 && (action === 'leave' ? m.status === 409 : [403,404].includes(m.status))) ||
    (m.status === 200 && t.status === 409));
  check(label + ': current owner remains active', ownerMember?.status === 'active');
  check(label + ': committed state matches winner',
    t.status === 200
      ? campaign.owner_id === recipient.id && member.status === 'active'
      : m.status === 200 && campaign.owner_id === donor.id && member.status === (action === 'ban' ? 'banned' : 'left'));
  await knex('campaigns').where({id}).del();
}
(async () => {
  try {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(BASE, 'http://127.0.0.1:3001');
    const identity = await (await fetch(BASE + '/__test/identity')).json();
    assert.equal(identity.database, 'vtt_test');
    assert.equal(identity.role, 'vtt_test_runner');
    const recipient = await makeUser();
    const donor = await makeUser();
    for (const action of ['leave', 'kick', 'ban']) {
      for (let round = 0; round < 3; round++) await race(action, round, donor, recipient);
    }
  } catch (error) {
    failed++; console.error(error);
  } finally {
    try {
      if (users.length) {
        await knex('campaigns').whereIn('owner_id', users).del();
        for (const id of users) await knex('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [id]).del();
        await knex('users').whereIn('id', users).del();
      }
    } catch (error) { failed++; console.error('Fixture cleanup failed:', error); }
    await knex.destroy();
    console.log(`${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
