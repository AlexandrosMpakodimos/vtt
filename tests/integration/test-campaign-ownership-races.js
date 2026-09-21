// Run through scripts/test-local.js: real HTTP + PostgreSQL, no storage writes.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const knex = require('../../src/db');
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
      method, headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}),
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
async function scenario(kind, recipient, donor) {
  // Fixtures represent capacity without spending 19 HTTP creates per scenario.
  await knex('campaigns').insert(Array.from({ length: 19 }, (_, i) => ({
    id: randomUUID(), owner_id: recipient.id, name: 'Capacity ' + i, is_public: true,
  })));
  const operations = [];
  const subjects = [];
  for (const mode of (kind === 'mixed' ? ['restore', 'restore', 'transfer', 'transfer'] : [kind, kind, kind])) {
    const id = randomUUID();
    const owner = mode === 'restore' ? recipient : donor;
    const deleted_at = mode === 'restore' ? new Date() : null;
    await knex('campaigns').insert({ id, owner_id: owner.id, name: kind + ' subject', is_public: true, deleted_at });
    await knex('campaign_members').insert({ campaign_id: id, user_id: owner.id, status: 'active' });
    if (mode === 'transfer') await knex('campaign_members').insert({ campaign_id: id, user_id: recipient.id, status: 'active' });
    subjects.push({ id, mode, owner: owner.id });
    operations.push(() => owner.req('POST', '/api/campaigns/' + id + '/' + mode,
      mode === 'transfer' ? { user_id: recipient.id } : {}));
  }
  if (kind === 'mixed') {
    for (let i = 0; i < 2; i++) operations.push(() => recipient.req('POST', '/api/campaigns', {
      name: 'Competing create', is_public: true,
    }));
  }
  const results = await Promise.all(operations.map(run => run()));
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  console.log('  NOTE  ' + kind + ' responses ' + JSON.stringify(counts));
  const live = Number((await knex('campaigns').where({ owner_id: recipient.id })
    .whereNull('deleted_at').count({ n: '*' }).first()).n);
  check(kind + ': ownership lands exactly at 20', live === 20);
  check(kind + ': exactly one operation succeeds', results.filter(r => r.status === 200 || r.status === 201).length === 1);
  check(kind + ': other operations return conflict', results.every(r => [200,201,409].includes(r.status)));
  let untouched = true;
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    const row = await knex('campaigns').where({ id: subject.id }).first();
    if (results[i].status !== 409) continue;
    untouched = untouched && row.owner_id === subject.owner
      && (subject.mode !== 'restore' || !!row.deleted_at);
  }
  check(kind + ': rejected operations leave subjects unchanged', untouched);
  await knex('campaigns').whereIn('owner_id', users).del();
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
    await scenario('transfer', recipient, donor);
    await scenario('restore', recipient, donor);
    await scenario('mixed', recipient, donor);
  } catch (error) {
    failed++; console.error(error);
  } finally {
    try {
      if (users.length) {
        await knex('campaigns').whereIn('owner_id', users).del();
        await knex('users').whereIn('id', users).del();
      }
    } catch (error) { failed++; console.error('Fixture cleanup failed:', error); }
    await knex.destroy();
    console.log(`${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
