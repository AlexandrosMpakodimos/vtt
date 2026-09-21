// Diagnostic: isolated HTTP/PostgreSQL server only; no production data or storage.
// Run: node scripts/test-local.js test-session-invalidation.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const knex = require('../../src/db');
const BASE = process.env.BASE_URL;
const PASSWORD = 'correct-horse-battery-staple-9';
const NEXT_PASSWORD = 'different-horse-battery-staple-8';
const users = [], sockets = [];
let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
function agent(initialCookie = '') {
  let cookie = initialCookie;
  return { get cookie() { return cookie; }, async req(method, path, body) {
    const res = await fetch(BASE + path, { method,
      headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } };
}
async function makeUser() {
  const client = agent();
  const email = crypto.randomUUID() + '@example.com';
  const registered = await client.req('POST', '/api/auth/register', {
    email, password: PASSWORD, username: 'sess' + crypto.randomBytes(5).toString('hex'),
  });
  assert.equal(registered.status, 201, 'register: ' + JSON.stringify(registered.data));
  const row = await knex('users').where({ email }).first();
  assert(row, 'registered user exists');
  users.push(row.id);
  await knex('users').where({ id: row.id }).update({ email_verified_at: knex.fn.now() });
  assert.equal((await client.req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 200, 'login');
  return { id: row.id, email, client };
}
async function connect(cookie) {
  const socket = io(BASE, { autoConnect: false, extraHeaders: { Cookie: cookie, Origin: BASE },
    transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    socket.connect();
  });
  return socket;
}
function join(socket, campaignId) {
  return new Promise(resolve => {
    socket.timeout(2500).emit('campaign:join', { campaign_id: campaignId }, (error, response) => {
      resolve(error ? { timeout: true } : response);
    });
  });
}
async function rejectsReconnect(cookie, campaignId) {
  const socket = io(BASE, { autoConnect: false, extraHeaders: { Cookie: cookie, Origin: BASE },
    transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise(resolve => {
    let done = false;
    const finish = blocked => {
      if (done) return;
      done = true; clearTimeout(timer); socket.close(); resolve(blocked);
    };
    const timer = setTimeout(() => finish(false), 4000);
    socket.once('connect_error', () => finish(true));
    socket.once('disconnect', () => finish(true));
    socket.once('connect', async () => {
      const result = await join(socket, campaignId);
      if (!done) finish(result?.ok === false);
    });
    socket.connect();
  });
}
async function scenario(mode, gm) {
  console.log('\n--- ' + mode + ' ---');
  const user = await makeUser();
  const a = user.client, b = agent();
  assert.equal((await b.req('POST', '/api/auth/login', { email: user.email, password: PASSWORD })).status, 200);
  const savedCookies = [a.cookie, b.cookie];
  assert.notEqual(savedCookies[0], savedCookies[1], 'two independent login sessions');
  const made = await gm.client.req('POST', '/api/campaigns', { name: 'Session ' + mode, is_public: true });
  assert.equal(made.status, 201, 'campaign setup');
  const campaignId = made.data.campaign.id;
  assert.equal((await a.req('POST', '/api/campaigns/' + campaignId + '/join', {})).status, 200);
  const live = [await connect(savedCookies[0]), await connect(savedCookies[1]), await connect(gm.client.cookie)];
  for (const socket of live) assert.equal((await join(socket, campaignId))?.ok, true, 'socket room setup');
  const received = live.map(() => []);
  live.forEach((socket, i) => socket.on('message:created', data => received[i].push(data.content)));
  async function broadcast(label) {
    const content = label + '-' + crypto.randomUUID();
    const response = await gm.client.req('POST', '/api/campaigns/' + campaignId + '/messages', { type: 'chat', content });
    assert.equal(response.status, 201, 'message setup: ' + JSON.stringify(response.data));
    await settle(600);
    return content;
  }
  const before = await broadcast('before');
  assert(received.every(messages => messages.includes(before)), 'all three sockets must receive the baseline message');
  let revoked;
  if (mode === 'logout') {
    assert.equal((await a.req('POST', '/api/auth/logout')).status, 200);
    revoked = [true, false];
  } else if (mode === 'password-change') {
    assert.equal((await a.req('POST', '/api/auth/change-password', {
      currentPassword: PASSWORD, newPassword: NEXT_PASSWORD,
    })).status, 200);
    revoked = [false, true];
  } else {
    const token = crypto.randomBytes(32).toString('hex');
    await knex('password_reset_tokens').insert({ user_id: user.id,
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(Date.now() + 3600000) });
    const reset = await agent().req('POST', '/api/auth/reset-password', { token, password: NEXT_PASSWORD });
    assert.equal(reset.status, 200, 'reset: ' + JSON.stringify(reset.data));
    revoked = [true, true];
  }
  // Broadcast before sending any further socket event: passive disclosure matters.
  const after = await broadcast('after');
  check(mode + ': unaffected GM receives the new message', received[2].includes(after));
  for (let i = 0; i < 2; i++) {
    const label = mode + ' session ' + (i === 0 ? 'A' : 'B');
    const me = await agent(savedCookies[i]).req('GET', '/api/auth/me');
    check(label + ': HTTP ' + (revoked[i] ? 'revoked' : 'retained'), me.status === (revoked[i] ? 401 : 200), 'status ' + me.status);
    check(label + ': ' + (revoked[i] ? 'receives no new message' : 'still receives new messages'),
      received[i].includes(after) === !revoked[i]);
    if (revoked[i]) {
      const result = live[i].connected ? await join(live[i], campaignId) : { ok: false };
      check(label + ': cannot rejoin on the old socket',
        !live[i].connected || result?.ok === false, JSON.stringify(result));
      check(label + ': revoked cookie cannot reconnect and join',
        await rejectsReconnect(savedCookies[i], campaignId));
    }
  }
  live.forEach(socket => socket.close());
}
(async () => {
  try {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(BASE, 'http://127.0.0.1:3001');
    const identity = await (await fetch(BASE + '/__test/identity')).json();
    assert.equal(identity.database, 'vtt_test');
    assert.equal(identity.role, 'vtt_test_runner');
    assert.equal(identity.storageBackend, 'memory');
    const gm = await makeUser();
    for (const mode of ['logout', 'password-change', 'password-reset']) await scenario(mode, gm);
  } catch (error) { failed++; console.error('SUITE ERROR:', error); }
  finally {
    sockets.forEach(socket => socket.close());
    await settle(100);
    try {
      if (users.length) {
        await knex('campaigns').whereIn('owner_id', users).del();
        for (const id of users) await knex('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [id]).del();
        await knex('users').whereIn('id', users).del();
      }
    } catch (error) { failed++; console.error('Cleanup failed:', error); }
    await knex.destroy();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
