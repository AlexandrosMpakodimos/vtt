// Diagnostic: isolated HTTP/PostgreSQL server only; no production data or storage.
// Run: node scripts/test-local.js test-campaign-access-transitions.js
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

function ack(socket, event, payload = {}) {
  return new Promise(resolve => socket.timeout(2500).emit(event, payload,
    (error, result) => resolve(error ? { timeout: true } : result)));
}
async function setup(gm, player, label) {
  const made = await gm.client.req('POST', '/api/campaigns', { name: 'Access ' + label, is_public: true });
  assert.equal(made.status, 201, JSON.stringify(made));
  const id = made.data.campaign.id, path = '/api/campaigns/' + id;
  assert.equal((await player.client.req('POST', path + '/join', {})).status, 200);
  const live = [await connect(player.client.cookie), await connect(player.client.cookie), await connect(gm.client.cookie)];
  const events = live.map(() => []);
  live.forEach((socket, i) => socket.onAny((event, data) => events[i].push({ event, data })));
  for (const socket of live) {
    assert.equal((await join(socket, id)).ok, true);
    assert.equal((await ack(socket, 'lobby:subscribe')).ok, true);
  }
  async function chat(label) {
    const content = label + crypto.randomUUID();
    const r = await gm.client.req('POST', path + '/messages', { type: 'chat', content });
    assert.equal(r.status, 201, JSON.stringify(r));
    await settle(600);
    return content;
  }
  const saw = (i, event, predicate) => events[i].some(e => e.event === event && predicate(e.data));
  const baseline = await chat('baseline');
  assert(live.every((_, i) => saw(i, 'message:created', d => d.content === baseline)), 'baseline delivery');
  return { id, path, live, events, chat, saw };
}
async function closure(gm, player) {
  console.log('\n--- close: passive game broadcasts ---');
  const c=await setup(gm,player,'close');
  const made=await gm.client.req('POST',c.path+'/scenes',{name:'Active map'});
  assert.equal(made.status,201);
  const scene=made.data.scene.id;
  assert.equal((await gm.client.req('PUT',c.path+'/scenes/active',{scene_id:scene})).status,200);
  async function token(name){
    const r=await gm.client.req('POST',c.path+'/scenes/'+scene+'/tokens',{name,x:1,y:1});
    assert.equal(r.status,201,JSON.stringify(r));await settle(600);return r.data.token.id;
  }
  const baseline=await token('before close');
  assert([0,1,2].every(i=>c.saw(i,'token:created',d=>d.id===baseline)),'baseline token delivery');
  assert.equal((await gm.client.req('PATCH',c.path,{is_open:false})).status,200);
  const after=await token('private preparation'), chat=await c.chat('closed');
  check('closed: GM receives token',c.saw(2,'token:created',d=>d.id===after));
  check('closed: GM receives chat',c.saw(2,'message:created',d=>d.content===chat));
  for(const i of [0,1]){
    check('closed: player tab '+(i+1)+' receives no token',!c.saw(i,'token:created',d=>d.id===after));
    check('closed: player tab '+(i+1)+' receives no chat',!c.saw(i,'message:created',d=>d.content===chat));
  }
  check('closed: player HTTP is denied',(await player.client.req('GET',c.path+'/scenes')).status===403);
  check('closed: both player tabs retain lobby state updates',[0,1].every(i=>c.saw(i,'campaign:state',d=>d.campaign_id===c.id&&d.is_open===false)));
  assert.equal((await gm.client.req('PATCH',c.path,{is_open:true})).status,200);
  for(const i of [0,1]) assert.equal((await join(c.live[i],c.id)).ok,true,'explicit rejoin after reopening');
  const reopened=await c.chat('reopened');
  check('reopened: both player tabs receive chat after rejoin',[0,1].every(i=>c.saw(i,'message:created',d=>d.content===reopened)));
  c.live.forEach(s=>s.close());
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
    await closure(gm,await makeUser());
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
