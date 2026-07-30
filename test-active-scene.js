// Active-scene enforcement: the GM may open any scene; a PLAYER is pinned to the
// campaign's active scene and cannot reach any other, by any route.
//   Usage: SKIP_HIBP=1 node test-active-scene.js
//
// Functional and adversarial assertions live in ONE file here, deliberately
// departing from the test-X / break-X split used elsewhere. The reason: this is
// not a feature with a security dimension, it IS an authorisation rule, so
// "does it work" and "can it be bypassed" are the same question asked twice.
//
// The rule enforced on the server:
//   - GET  /scenes            — GM: all scenes. Player: at most the active one.
//   - GET  /scenes/:id        — player gets 404 for anything but the active scene.
//   - POST /scenes/:id/tokens — player may only place on the active scene.
//   - token:move / :move-batch — player refused on a non-active scene.
// Refusal is 404, never 403: a 403 would confirm the scene exists, letting a
// player enumerate the GM's unpublished maps by probing ids.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}  ${detail}`); }
}

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    },
  };
}

async function makeUser(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  const r = await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  if (l.status !== 200) throw new Error(`login failed: ${JSON.stringify(l.data)}`);
  a.id = l.data.user.id;
  return a;
}

function socketFor(a) {
  return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
}
const connected = (s) => new Promise((res, rej) => {
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
  setTimeout(() => rej(new Error('connect timeout')), 3000);
});
const emitAck = (s, event, payload) => new Promise((resolve) => {
  s.emit(event, payload, resolve);
  setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
});
function waitFor(s, event, ms = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
    const h = (d) => { clearTimeout(t); s.off(event, h); resolve(d); };
    s.on(event, h);
  });
}

(async () => {
  const gm = await makeUser('gm');
  const player = await makeUser('player');
  const stranger = await makeUser('stranger');

  const created = await gm.req('POST', '/api/campaigns', {
    name: 'Scene Control', is_public: false, password: 'roompw',
  });
  const cid = created.data.campaign.id;
  await player.req('POST', `/api/campaigns/${cid}/join`, { password: 'roompw' });

  const sceneA = (await gm.req('POST', `/api/campaigns/${cid}/scenes`, { name: 'Tavern' })).data.scene;
  const sceneB = (await gm.req('POST', `/api/campaigns/${cid}/scenes`, { name: 'Dungeon' })).data.scene;
  const sceneC = (await gm.req('POST', `/api/campaigns/${cid}/scenes`, { name: 'Secret Lair' })).data.scene;
  const scenes = `/api/campaigns/${cid}/scenes`;

  // ---- before anything is activated ----
  const pListEmpty = await player.req('GET', scenes);
  check('with no active scene, a player sees NO scenes',
    pListEmpty.status === 200 && pListEmpty.data.scenes.length === 0,
    JSON.stringify(pListEmpty.data));
  const pPeek = await player.req('GET', `${scenes}/${sceneA.id}`);
  check('with no active scene, a player cannot open one -> 404', pPeek.status === 404, `got ${pPeek.status}`);

  const gmList = await gm.req('GET', scenes);
  check('the GM always sees every scene', gmList.data.scenes.length === 3, `${gmList.data.scenes.length}`);

  // ---- activate A ----
  const gmSock = await connected(socketFor(gm));
  const playerSock = await connected(socketFor(player));
  await emitAck(gmSock, 'campaign:join', { campaign_id: cid });
  await emitAck(playerSock, 'campaign:join', { campaign_id: cid });

  const wantActivate = waitFor(playerSock, 'scene:activated');
  const act = await gm.req('PUT', `${scenes}/active`, { scene_id: sceneA.id });
  check('GM activates a scene (200)', act.status === 200, JSON.stringify(act.data));
  const gotActivate = await wantActivate;
  check('the player is told to move', gotActivate && gotActivate.scene_id === sceneA.id, JSON.stringify(gotActivate));

  const pList = await player.req('GET', scenes);
  check('a player now sees exactly ONE scene', pList.data.scenes.length === 1, `${pList.data.scenes.length}`);
  check('and it is the active one', pList.data.scenes[0] && pList.data.scenes[0].id === sceneA.id);

  const pOpenA = await player.req('GET', `${scenes}/${sceneA.id}`);
  check('a player can open the active scene (200)', pOpenA.status === 200, `got ${pOpenA.status}`);
  const pOpenB = await player.req('GET', `${scenes}/${sceneB.id}`);
  check('a player CANNOT open another scene -> 404', pOpenB.status === 404, `got ${pOpenB.status}`);
  check('refusal is 404, not 403 (no map enumeration)', pOpenB.status !== 403, `got ${pOpenB.status}`);
  const pOpenC = await player.req('GET', `${scenes}/${sceneC.id}`);
  check('the unpublished scene is unreachable too -> 404', pOpenC.status === 404, `got ${pOpenC.status}`);

  // The GM roams freely — that is the whole point of open-vs-activate.
  const gmOpenB = await gm.req('GET', `${scenes}/${sceneB.id}`);
  check('the GM can still open a NON-active scene (200)', gmOpenB.status === 200, `got ${gmOpenB.status}`);
  const stillA = await knex('campaigns').where({ id: cid }).first();
  check('the GM opening a scene does NOT activate it', stillA.active_scene_id === sceneA.id, String(stillA.active_scene_id));

  // ---- writes are pinned too, not just reads ----
  const pPlaceActive = await player.req('POST', `${scenes}/${sceneA.id}/tokens`, { name: 'Mine', x: 1, y: 1 });
  check('a player may place on the active scene (201)', pPlaceActive.status === 201, JSON.stringify(pPlaceActive.data));
  const playerToken = pPlaceActive.data.token;
  const pPlaceOther = await player.req('POST', `${scenes}/${sceneB.id}/tokens`, { name: 'Sneaky', x: 1, y: 1 });
  check('a player CANNOT place on another scene -> 404', pPlaceOther.status === 404, `got ${pPlaceOther.status}`);
  const leaked = await knex('tokens').where({ scene_id: sceneB.id });
  check('no token leaked onto the hidden scene', leaked.length === 0, `${leaked.length} rows`);

  const gmPlaceB = await gm.req('POST', `${scenes}/${sceneB.id}/tokens`, { name: 'Prep', x: 2, y: 2 });
  check('the GM may place on a non-active scene (201)', gmPlaceB.status === 201, `got ${gmPlaceB.status}`);

  // socket moves obey the same pin
  const okMove = await emitAck(playerSock, 'token:move',
    { campaign_id: cid, scene_id: sceneA.id, token_id: playerToken.id, x: 3, y: 3 });
  check('a player may move on the active scene', okMove && okMove.ok === true, JSON.stringify(okMove));

  // ---- switch to B: the old scene must go dark for the player ----
  const wantSwitch = waitFor(playerSock, 'scene:activated');
  await gm.req('PUT', `${scenes}/active`, { scene_id: sceneB.id });
  const gotSwitch = await wantSwitch;
  check('the player is forced to the new scene', gotSwitch && gotSwitch.scene_id === sceneB.id, JSON.stringify(gotSwitch));

  const pOldScene = await player.req('GET', `${scenes}/${sceneA.id}`);
  check('the previous scene is now unreadable to the player -> 404', pOldScene.status === 404, `got ${pOldScene.status}`);
  const pNewScene = await player.req('GET', `${scenes}/${sceneB.id}`);
  check('the new active scene is readable (200)', pNewScene.status === 200, `got ${pNewScene.status}`);

  // The critical replay: a token the player legitimately owned on scene A.
  // Their socket is still open and still in the room.
  const staleMove = await emitAck(playerSock, 'token:move',
    { campaign_id: cid, scene_id: sceneA.id, token_id: playerToken.id, x: 9, y: 9 });
  check('a player cannot move their OWN token on a deactivated scene',
    staleMove && staleMove.ok === false, JSON.stringify(staleMove));
  const notMoved = await knex('tokens').where({ id: playerToken.id }).first();
  check('the stale move did not persist', notMoved && Number(notMoved.x) === 3, JSON.stringify(notMoved && notMoved.x));

  const staleBatch = await emitAck(playerSock, 'token:move-batch',
    { campaign_id: cid, scene_id: sceneA.id, moves: [{ token_id: playerToken.id, x: 8, y: 8 }] });
  check('batch move on a deactivated scene is refused too',
    staleBatch && staleBatch.ok === false, JSON.stringify(staleBatch));
  const notMoved2 = await knex('tokens').where({ id: playerToken.id }).first();
  check('the stale batch did not persist', notMoved2 && Number(notMoved2.x) === 3);

  // The GM is NOT pinned on the socket path either.
  const gmToken = (await gm.req('POST', `${scenes}/${sceneA.id}/tokens`, { name: 'GM', x: 0, y: 0 })).data.token;
  const gmStale = await emitAck(gmSock, 'token:move',
    { campaign_id: cid, scene_id: sceneA.id, token_id: gmToken.id, x: 4, y: 4 });
  check('the GM may still move tokens on a non-active scene', gmStale && gmStale.ok === true, JSON.stringify(gmStale));

  // ---- players cannot drive the switch ----
  const pActivate = await player.req('PUT', `${scenes}/active`, { scene_id: sceneC.id });
  check('a player cannot activate a scene (403)', pActivate.status === 403, `got ${pActivate.status}`);
  const unchanged = await knex('campaigns').where({ id: cid }).first();
  check('the active scene is unchanged by the attempt', unchanged.active_scene_id === sceneB.id, String(unchanged.active_scene_id));

  const sActivate = await stranger.req('PUT', `${scenes}/active`, { scene_id: sceneA.id });
  check('a non-member cannot activate -> 404', sActivate.status === 404, `got ${sActivate.status}`);
  const sList = await stranger.req('GET', scenes);
  check('a non-member cannot list scenes -> 404', sList.status === 404, `got ${sList.status}`);

  // ---- clearing the active scene ----
  const wantClear = waitFor(playerSock, 'scene:activated');
  await gm.req('PUT', `${scenes}/active`, { scene_id: null });
  const gotClear = await wantClear;
  check('clearing is broadcast as a null scene', gotClear && gotClear.scene_id === null, JSON.stringify(gotClear));
  const pAfterClear = await player.req('GET', scenes);
  check('with the scene cleared the player sees nothing again',
    pAfterClear.data.scenes.length === 0, JSON.stringify(pAfterClear.data));
  const pReopen = await player.req('GET', `${scenes}/${sceneB.id}`);
  check('and cannot reopen what was active a moment ago -> 404', pReopen.status === 404, `got ${pReopen.status}`);
  const gmAfterClear = await gm.req('GET', scenes);
  check('the GM still sees every scene after clearing', gmAfterClear.data.scenes.length === 3);

  gmSock.close(); playerSock.close();

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
