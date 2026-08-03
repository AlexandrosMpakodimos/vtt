// Adversarial test suite for the M2 canvas (scenes + tokens), run against a real
// PostgreSQL with the server running.
//   Usage: SKIP_HIBP=1 node test-scenes.js
//
// Covers the session's done-criteria and their failure modes:
//   - GM creates a scene, opens it, places a token.
//   - Two sockets in the same campaign both see a placement, and a token:move by
//     one is delivered to the other in real time.
//   - The move is PERSISTED (re-read from the DB, not just observed on the wire).
//   - A non-member's socket cannot join the room or receive token updates, and a
//     non-member cannot move a token even if it forges the ids.
//   - Placement/movement permission rules: player places 1 (cap enforced),
//     player moves only their own token, GM moves anything.
//   - Input validation: non-finite coords, oversized/garbage, cross-campaign IDOR.

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
      try { data = await res.json(); } catch { /* html or empty */ }
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
  if (r.status !== 201) throw new Error(`register failed for ${name}: ${JSON.stringify(r.data)}`);
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  if (l.status !== 200) throw new Error(`login failed for ${name}: ${JSON.stringify(l.data)}`);
  a.id = l.data.user.id;
  a.username = l.data.user.username;
  return a;
}

function socketFor(a) {
  return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
}
const connected = (s) =>
  new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
const emitAck = (s, event, payload) =>
  new Promise((resolve) => {
    s.emit(event, payload, resolve);
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
  });
// Wait for a named event, or resolve null after a timeout (used both to assert
// an event arrives AND to assert one does NOT).
function waitFor(s, event, ms = 1200) {
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

  // GM makes a private campaign; player joins; stranger stays out.
  const created = await gm.req('POST', '/api/campaigns', {
    name: 'Canvas Test', is_public: false, password: 'roompw',
  });
  check('campaign create', created.status === 201, JSON.stringify(created.data));
  const campaignId = created.data.campaign.id;
  await player.req('POST', `/api/campaigns/${campaignId}/join`, { password: 'roompw' });

  // ---- scene creation: GM only ----
  const sceneRes = await gm.req('POST', `/api/campaigns/${campaignId}/scenes`, {
    name: 'Dungeon Level 1', width: 1600, height: 1200,
  });
  check('GM creates scene (201)', sceneRes.status === 201, JSON.stringify(sceneRes.data));
  const sceneId = sceneRes.data.scene && sceneRes.data.scene.id;
  check('scene has campaign_id', sceneRes.data.scene && sceneRes.data.scene.campaign_id === campaignId);

  // The active-scene rule (M3) pins players to the campaign's active scene, so
  // every player-path assertion below needs this scene to BE the active one.
  // Written before that rule existed; this line is what the old contract
  // implicitly assumed.
  await gm.req('PUT', `/api/campaigns/${campaignId}/scenes/active`, { scene_id: sceneId });

  const playerScene = await player.req('POST', `/api/campaigns/${campaignId}/scenes`, { name: 'sneaky' });
  check('player cannot create scene (403)', playerScene.status === 403, `got ${playerScene.status}`);

  const strangerScene = await stranger.req('POST', `/api/campaigns/${campaignId}/scenes`, { name: 'x' });
  check('stranger create scene -> 404 (no existence leak)', strangerScene.status === 404, `got ${strangerScene.status}`);

  // scene list visible to a member, not to a stranger
  const listMember = await player.req('GET', `/api/campaigns/${campaignId}/scenes`);
  check('member lists scenes', listMember.status === 200 && listMember.data.scenes.length === 1);
  const listStranger = await stranger.req('GET', `/api/campaigns/${campaignId}/scenes`);
  check('stranger list scenes -> 404', listStranger.status === 404, `got ${listStranger.status}`);

  // scene dimension validation
  const badDim = await gm.req('POST', `/api/campaigns/${campaignId}/scenes`, { name: 'bad', width: 5 });
  check('scene width below min rejected', badDim.status === 400, JSON.stringify(badDim.data));

  // ---- token placement ----
  // GM places one via HTTP.
  const t1 = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, {
    name: 'Goblin', img_url: 'https://example.com/goblin.png', x: 2, y: 3,
  });
  check('GM places token (201)', t1.status === 201, JSON.stringify(t1.data));
  const gmTokenId = t1.data.token && t1.data.token.id;
  check('token created_by = GM', t1.data.token && t1.data.token.created_by === gm.id);
  check('a token placed with no actor_id is unlinked', t1.data.token && t1.data.token.actor_id === null);
  check('token coords are numbers', t1.data.token && typeof t1.data.token.x === 'number' && t1.data.token.x === 2);

  // GM can place many.
  const t1b = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'Goblin 2' });
  check('GM places a second token (unlimited)', t1b.status === 201, JSON.stringify(t1b.data));

  // Player may place exactly one.
  const p1 = await player.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'Hero', x: 5, y: 5 });
  check('player places their 1 token (201)', p1.status === 201, JSON.stringify(p1.data));
  const playerTokenId = p1.data.token && p1.data.token.id;
  const p2 = await player.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'Hero 2' });
  check('player 2nd token rejected (409 cap)', p2.status === 409, `got ${p2.status}: ${JSON.stringify(p2.data)}`);

  // stranger cannot place at all
  const sTok = await stranger.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'x' });
  check('stranger place token -> 404', sTok.status === 404, `got ${sTok.status}`);

  // coord validation on placement
  const badCoord = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'nan', x: 'NaN' });
  check('non-finite x rejected (400)', badCoord.status === 400, JSON.stringify(badCoord.data));
  const bigCoord = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'big', x: 1e9 });
  check('out-of-range x rejected (400)', bigCoord.status === 400, JSON.stringify(bigCoord.data));
  const zeroSize = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'zero', width: 0 });
  check('zero width rejected (400)', zeroSize.status === 400, JSON.stringify(zeroSize.data));

  // mass-assignment: try to force created_by / id. actor_id is NOT tested here
  // any more: since M4 it is a validated INPUT field, not a server-owned column
  // a client might forge, so it gets its own probe below.
  const forge = await player.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, {
    name: 'forge', id: '00000000-0000-0000-0000-000000000000', created_by: gm.id,
  });
  // player already has 1 token, so this hits the cap first (409) — the point is
  // it does NOT succeed with forged fields. Delete player's token, retry, assert
  // forged fields ignored.
  await player.req('DELETE', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens/${playerTokenId}`);
  const forge2 = await player.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, {
    name: 'forge', id: '00000000-0000-0000-0000-000000000000', created_by: gm.id,
  });
  check('mass-assignment ignored: created_by stays caller', forge2.status === 201 && forge2.data.token.created_by === player.id, JSON.stringify(forge2.data));
  check('mass-assignment ignored: id not forced', forge2.status === 201 && forge2.data.token.id !== '00000000-0000-0000-0000-000000000000');
  check('an unlinked token still has actor_id null', forge2.status === 201 && forge2.data.token.actor_id === null);
  const playerToken2 = forge2.data.token.id;

  // ---- M4 CONTRACT CHANGE ----
  // Before M4 every write path forced actor_id to NULL, so a forged value was
  // silently dropped and the write succeeded. actor_id is now a validated field:
  // a uuid that is not an actor in THIS campaign refuses the write outright, so
  // a caller is never told a link was made when it was not. (Under the old
  // behaviour a GM pasting twenty goblins with one stale actor id would have got
  // twenty silently unlinked squares and a 201 saying it worked.)
  //
  // Sent as the GM, who has no per-token cap, so the 404 cannot be confused with
  // a 409 from the player's 1-token limit.
  const badLink = await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, {
    name: 'ghost', actor_id: gm.id,
  });
  check('unresolvable actor_id is REFUSED, not ignored (404)', badLink.status === 404, `got ${badLink.status}`);
  const ghosts = await knex('tokens').where({ scene_id: sceneId, name: 'ghost' });
  check('the refused token was not created at all', ghosts.length === 0, `${ghosts.length} rows`);

  // ---- cross-campaign IDOR ----
  const other = await gm.req('POST', '/api/campaigns', { name: 'Other', is_public: true });
  const otherId = other.data.campaign.id;
  // token from campaign A addressed through campaign B's scene path
  const idor = await gm.req('GET', `/api/campaigns/${otherId}/scenes/${sceneId}`);
  check('scene from another campaign -> 404 (IDOR blocked)', idor.status === 404, `got ${idor.status}`);

  // ---- real-time: two sockets see a move ----
  const gmSock = await connected(socketFor(gm));
  const playerSock = await connected(socketFor(player));
  const strangerSock = await connected(socketFor(stranger));

  const gmJoin = await emitAck(gmSock, 'campaign:join', { campaign_id: campaignId });
  const plJoin = await emitAck(playerSock, 'campaign:join', { campaign_id: campaignId });
  check('GM socket joins room', gmJoin.ok === true, JSON.stringify(gmJoin));
  check('player socket joins room', plJoin.ok === true, JSON.stringify(plJoin));

  // stranger cannot join
  const stJoin = await emitAck(strangerSock, 'campaign:join', { campaign_id: campaignId });
  check('stranger socket join refused', stJoin.ok === false, JSON.stringify(stJoin));

  // GM moves its token; player socket must receive token:moved
  const movedOnPlayer = waitFor(playerSock, 'token:moved');
  const movedOnStranger = waitFor(strangerSock, 'token:moved'); // must NOT arrive
  const moveAck = await emitAck(gmSock, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: gmTokenId, x: 7, y: 8,
  });
  check('GM token:move ack ok', moveAck.ok === true, JSON.stringify(moveAck));
  const gotMove = await movedOnPlayer;
  check('player receives token:moved in real time', gotMove && gotMove.id === gmTokenId && gotMove.x === 7 && gotMove.y === 8, JSON.stringify(gotMove));
  const strangerGot = await movedOnStranger;
  check('stranger receives NO token update', strangerGot === null);

  // ---- persistence: the move is in Postgres ----
  const dbRow = await knex('tokens').where({ id: gmTokenId }).first();
  check('move persisted to DB (x=7,y=8)', dbRow && Number(dbRow.x) === 7 && Number(dbRow.y) === 8, JSON.stringify(dbRow && { x: dbRow.x, y: dbRow.y }));

  // ---- permission: player cannot move GM's token ----
  const badMove = await emitAck(playerSock, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: gmTokenId, x: 0, y: 0,
  });
  check('player cannot move GM token', badMove.ok === false, JSON.stringify(badMove));
  const stillThere = await knex('tokens').where({ id: gmTokenId }).first();
  check('rejected move did not persist', Number(stillThere.x) === 7 && Number(stillThere.y) === 8);

  // player CAN move their own token
  const ownMove = await emitAck(playerSock, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: playerToken2, x: 9, y: 9,
  });
  check('player moves their own token', ownMove.ok === true, JSON.stringify(ownMove));

  // ---- non-member socket cannot move even with forged ids ----
  // stranger never joined; a token:move must be refused on membership grounds.
  const strangerMove = await emitAck(strangerSock, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: gmTokenId, x: 1, y: 1,
  });
  check('stranger token:move refused (not a member)', strangerMove.ok === false, JSON.stringify(strangerMove));

  // ---- move validation over the socket ----
  const nanMove = await emitAck(gmSock, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: gmTokenId, x: Infinity, y: 0,
  });
  check('socket non-finite coord refused', nanMove.ok === false, JSON.stringify(nanMove));

  // move without joining the room first (fresh gm socket that never joined)
  const gmSock2 = await connected(socketFor(gm));
  const noJoinMove = await emitAck(gmSock2, 'token:move', {
    campaign_id: campaignId, scene_id: sceneId, token_id: gmTokenId, x: 3, y: 3,
  });
  check('move refused without prior room join', noJoinMove.ok === false, JSON.stringify(noJoinMove));

  // ---- token:created broadcast on placement ----
  const createdSeen = waitFor(playerSock, 'token:created');
  await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens`, { name: 'Broadcast Test' });
  const createdEvt = await createdSeen;
  check('placement broadcasts token:created to room', createdEvt && createdEvt.name === 'Broadcast Test', JSON.stringify(createdEvt));

  // ---- delete permission ----
  const delByPlayer = await player.req('DELETE', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens/${gmTokenId}`);
  check('player cannot delete GM token (403)', delByPlayer.status === 403, `got ${delByPlayer.status}`);
  const delByGm = await gm.req('DELETE', `/api/campaigns/${campaignId}/scenes/${sceneId}/tokens/${gmTokenId}`);
  check('GM deletes any token (200)', delByGm.status === 200, JSON.stringify(delByGm.data));

  gmSock.close(); playerSock.close(); strangerSock.close(); gmSock2.close();

  // ---- summary ----
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
