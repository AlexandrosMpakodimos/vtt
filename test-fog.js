// Functional test suite for M3 (fog of war + active_scene_id), run against a
// real PostgreSQL with the server running.
//   Usage: SKIP_HIBP=1 node test-fog.js
//
// Covers the session's done-criteria and their failure modes:
//   - The GM draws fog regions of all three types, toggles them, moves them,
//     deletes them singly and in batches, and pastes them.
//   - State PERSISTS (re-read from the DB, not just observed on the wire).
//   - Every change reaches the room in real time as a fog:* socket event.
//   - A player RECEIVES fog geometry (deliberately not viewer-filtered, unlike a
//     hidden token) but cannot write any of it.
//   - A non-member can neither read nor modify fog: 404, not 403, so the
//     endpoints do not leak that the scene exists.
//   - active_scene_id: the GM sets it, everyone is told, it survives a reload,
//     and it cannot be pointed at another campaign's scene.

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
function waitFor(s, event, ms = 1200) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
    const h = (d) => { clearTimeout(t); s.off(event, h); resolve(d); };
    s.on(event, h);
  });
}

// Geometry helpers, in grid units.
const rect = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y2 }];
const circle = (cx, cy, r) => [{ x: cx, y: cy }, { x: cx + r, y: cy }];
const tri = (x, y) => [{ x, y }, { x: x + 4, y }, { x, y: y + 4 }];

(async () => {
  const gm = await makeUser('gm');
  const player = await makeUser('player');
  const stranger = await makeUser('stranger');

  const created = await gm.req('POST', '/api/campaigns', {
    name: 'Fog Test', is_public: false, password: 'roompw',
  });
  check('campaign create', created.status === 201, JSON.stringify(created.data));
  const campaignId = created.data.campaign.id;
  await player.req('POST', `/api/campaigns/${campaignId}/join`, { password: 'roompw' });

  const s1 = await gm.req('POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Cavern' });
  const sceneId = s1.data.scene.id;
  const s2 = await gm.req('POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Surface' });
  const scene2Id = s2.data.scene.id;

  // The active-scene rule (M3) pins players to the campaign's active scene, so
  // every player-path assertion below needs this scene to BE the active one.
  // Written before that rule existed; this line is what the old contract
  // implicitly assumed.
  await gm.req('PUT', `/api/campaigns/${campaignId}/scenes/active`, { scene_id: sceneId });

  const fogPath = `/api/campaigns/${campaignId}/scenes/${sceneId}/fog`;

  // ---- sockets in the room, so broadcasts can be observed ----
  const gmSock = await connected(socketFor(gm));
  const playerSock = await connected(socketFor(player));
  const strangerSock = await connected(socketFor(stranger));
  await emitAck(gmSock, 'campaign:join', { campaign_id: campaignId });
  await emitAck(playerSock, 'campaign:join', { campaign_id: campaignId });

  // ---- drawing: all three types ----
  const wantCreated = waitFor(playerSock, 'fog:created');
  const r1 = await gm.req('POST', fogPath, { type: 'rect', points: rect(0, 0, 10, 8) });
  check('GM draws a rect (201)', r1.status === 201, JSON.stringify(r1.data));
  const rectId = r1.data.fog && r1.data.fog.id;
  check('new region defaults to revealed=false (it COVERS)', r1.data.fog && r1.data.fog.revealed === false);
  check('region carries its scene_id', r1.data.fog && r1.data.fog.scene_id === sceneId);
  check('points come back as parsed JSON, not a string', Array.isArray(r1.data.fog && r1.data.fog.points));

  const gotCreated = await wantCreated;
  check('player receives fog:created in real time', gotCreated && gotCreated.id === rectId, JSON.stringify(gotCreated));

  const c1 = await gm.req('POST', fogPath, { type: 'circle', points: circle(20, 20, 5) });
  check('GM draws a circle (201)', c1.status === 201, JSON.stringify(c1.data));
  const circleId = c1.data.fog && c1.data.fog.id;

  const p1 = await gm.req('POST', fogPath, { type: 'poly', points: tri(30, 30) });
  check('GM draws a poly (201)', p1.status === 201, JSON.stringify(p1.data));
  const polyId = p1.data.fog && p1.data.fog.id;

  // A region created already revealed — the "cover everything, punch windows" path.
  const w1 = await gm.req('POST', fogPath, { type: 'rect', points: rect(2, 2, 4, 4), revealed: true });
  check('GM draws an already-revealed window (201)', w1.status === 201, JSON.stringify(w1.data));
  check('window is revealed=true', w1.data.fog && w1.data.fog.revealed === true);
  const windowId = w1.data.fog && w1.data.fog.id;

  // ---- rect normalisation survives the round trip ----
  const back = await gm.req('POST', fogPath, { type: 'rect', points: rect(40, 30, 35, 25) });
  check('backwards rect stored as [min,max]',
    back.data.fog && back.data.fog.points[0].x === 35 && back.data.fog.points[0].y === 25
    && back.data.fog.points[1].x === 40 && back.data.fog.points[1].y === 30,
    JSON.stringify(back.data.fog && back.data.fog.points));
  const backId = back.data.fog.id;

  // ---- persistence ----
  const dbRow = await knex('fog_of_war').where({ id: rectId }).first();
  check('region persisted to the DB', !!dbRow);
  check('DB stores real jsonb (points is an array)', dbRow && Array.isArray(dbRow.points), JSON.stringify(dbRow && dbRow.points));
  check('DB type matches what was drawn', dbRow && dbRow.type === 'rect');

  // ---- validation ----
  const badType = await gm.req('POST', fogPath, { type: 'blob', points: rect(0, 0, 1, 1) });
  check('unknown type rejected (400)', badType.status === 400, `got ${badType.status}`);
  const badCount = await gm.req('POST', fogPath, { type: 'rect', points: [{ x: 0, y: 0 }] });
  check('rect with 1 point rejected (400)', badCount.status === 400, `got ${badCount.status}`);
  const thinPoly = await gm.req('POST', fogPath, { type: 'poly', points: rect(0, 0, 1, 1) });
  check('poly with 2 points rejected (400)', thinPoly.status === 400, `got ${thinPoly.status}`);
  const flatRect = await gm.req('POST', fogPath, { type: 'rect', points: rect(5, 0, 5, 9) });
  check('zero-width rect rejected (400)', flatRect.status === 400, `got ${flatRect.status}`);
  const dot = await gm.req('POST', fogPath, { type: 'circle', points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] });
  check('zero-radius circle rejected (400)', dot.status === 400, `got ${dot.status}`);
  const noPoints = await gm.req('POST', fogPath, { type: 'rect' });
  check('missing points rejected (400)', noPoints.status === 400, `got ${noPoints.status}`);

  // ---- toggling ----
  const wantUpdate = waitFor(playerSock, 'fog:updated');
  const rev = await gm.req('PATCH', `${fogPath}/${rectId}`, { revealed: true });
  check('GM reveals a region (200)', rev.status === 200, JSON.stringify(rev.data));
  check('revealed flipped to true', rev.data.fog && rev.data.fog.revealed === true);
  const gotUpdate = await wantUpdate;
  check('player receives fog:updated in real time', gotUpdate && gotUpdate.id === rectId, JSON.stringify(gotUpdate));

  const dbRev = await knex('fog_of_war').where({ id: rectId }).first();
  check('toggle persisted', dbRev && dbRev.revealed === true);
  check('updated_at moved on toggle', dbRev && +new Date(dbRev.updated_at) >= +new Date(dbRev.created_at));

  const back2 = await gm.req('PATCH', `${fogPath}/${rectId}`, { revealed: false });
  check('toggle is symmetric (re-covers)', back2.status === 200 && back2.data.fog.revealed === false);

  // ---- moving / reshaping ----
  const moved = await gm.req('PATCH', `${fogPath}/${polyId}`, { points: tri(50, 50) });
  check('GM moves a region (200)', moved.status === 200, JSON.stringify(moved.data));
  check('new geometry returned', moved.data.fog && moved.data.fog.points[0].x === 50);
  const dbMoved = await knex('fog_of_war').where({ id: polyId }).first();
  check('move persisted', dbMoved && dbMoved.points[0].x === 50);

  const wrongShape = await gm.req('PATCH', `${fogPath}/${polyId}`, { points: rect(0, 0, 2, 2) });
  check('points re-validated against the STORED type (400)', wrongShape.status === 400, `got ${wrongShape.status}`);

  const retype = await gm.req('PATCH', `${fogPath}/${polyId}`, { type: 'rect' });
  check('type is not patchable (400)', retype.status === 400, `got ${retype.status}`);

  const empty = await gm.req('PATCH', `${fogPath}/${polyId}`, {});
  check('empty PATCH rejected (400)', empty.status === 400, `got ${empty.status}`);

  // ---- scene load includes fog, for BOTH roles ----
  const gmLoad = await gm.req('GET', `/api/campaigns/${campaignId}/scenes/${sceneId}`);
  check('scene load returns a fog array', Array.isArray(gmLoad.data.fog));
  check('GM load carries every region', gmLoad.data.fog.length === 5, `got ${gmLoad.data.fog && gmLoad.data.fog.length}`);

  const playerLoad = await player.req('GET', `/api/campaigns/${campaignId}/scenes/${sceneId}`);
  check('player scene load succeeds', playerLoad.status === 200);
  // Deliberate: fog is NOT viewer-filtered. A player must draw the fog, so the
  // geometry they receive is exactly the geometry rendered on their own screen.
  // Contrast the hidden-token assertions in test-token-ops.js, where the row
  // genuinely never leaves the server.
  check('player receives fog geometry (by design, unlike hidden tokens)',
    playerLoad.data.fog.length === 5, `got ${playerLoad.data.fog && playerLoad.data.fog.length}`);
  check('player sees the same revealed flags',
    playerLoad.data.fog.filter((f) => f.revealed).length
    === gmLoad.data.fog.filter((f) => f.revealed).length);

  // ---- player cannot write anything ----
  const pCreate = await player.req('POST', fogPath, { type: 'rect', points: rect(0, 0, 3, 3) });
  check('player cannot draw fog (403)', pCreate.status === 403, `got ${pCreate.status}`);
  const pPatch = await player.req('PATCH', `${fogPath}/${circleId}`, { revealed: true });
  check('player cannot toggle fog (403)', pPatch.status === 403, `got ${pPatch.status}`);
  const pDelete = await player.req('DELETE', `${fogPath}/${circleId}`);
  check('player cannot delete fog (403)', pDelete.status === 403, `got ${pDelete.status}`);
  const pBatch = await player.req('POST', `${fogPath}/batch-delete`, { fog_ids: [circleId] });
  check('player cannot batch-delete fog (403)', pBatch.status === 403, `got ${pBatch.status}`);
  const pCopy = await player.req('POST', `${fogPath}/copy`, { regions: [{ type: 'rect', points: rect(0, 0, 2, 2) }] });
  check('player cannot paste fog (403)', pCopy.status === 403, `got ${pCopy.status}`);

  // ---- non-member sees nothing, and gets 404 not 403 ----
  const sRead = await stranger.req('GET', `/api/campaigns/${campaignId}/scenes/${sceneId}`);
  check('non-member scene read -> 404 (no existence leak)', sRead.status === 404, `got ${sRead.status}`);
  const sCreate = await stranger.req('POST', fogPath, { type: 'rect', points: rect(0, 0, 2, 2) });
  check('non-member cannot draw fog -> 404', sCreate.status === 404, `got ${sCreate.status}`);
  const sPatch = await stranger.req('PATCH', `${fogPath}/${circleId}`, { revealed: true });
  check('non-member cannot toggle fog -> 404', sPatch.status === 404, `got ${sPatch.status}`);
  const sDelete = await stranger.req('DELETE', `${fogPath}/${circleId}`);
  check('non-member cannot delete fog -> 404', sDelete.status === 404, `got ${sDelete.status}`);
  const stillThere = await knex('fog_of_war').where({ id: circleId }).first();
  check('region survived every unauthorised attempt', !!stillThere);

  const strangerSaw = await waitFor(strangerSock, 'fog:created', 300);
  check('non-member socket receives no fog events', strangerSaw === null, JSON.stringify(strangerSaw));

  // ---- copy / paste (snapshot semantics, same as tokens) ----
  const paste = await gm.req('POST', `${fogPath}/copy`, {
    regions: [
      { type: 'rect', points: rect(60, 60, 70, 70) },
      { type: 'circle', points: circle(80, 80, 3), revealed: true },
    ],
  });
  check('GM pastes regions (201)', paste.status === 201, JSON.stringify(paste.data));
  check('paste returns both regions', paste.data.fog && paste.data.fog.length === 2);
  check('paste preserves revealed per spec',
    paste.data.fog && paste.data.fog[1].revealed === true);
  check('paste stamps the server-side scene_id',
    paste.data.fog && paste.data.fog.every((f) => f.scene_id === sceneId));

  const pasteBadShape = await gm.req('POST', `${fogPath}/copy`, {
    regions: [{ type: 'circle', points: tri(0, 0) }],
  });
  check('paste re-validates geometry per spec (400)', pasteBadShape.status === 400, `got ${pasteBadShape.status}`);
  const pasteEmpty = await gm.req('POST', `${fogPath}/copy`, { regions: [] });
  check('paste rejects an empty list (400)', pasteEmpty.status === 400, `got ${pasteEmpty.status}`);
  const pasteNonArray = await gm.req('POST', `${fogPath}/copy`, { regions: 'nope' });
  check('paste rejects a non-array (400)', pasteNonArray.status === 400, `got ${pasteNonArray.status}`);

  // Cut = copy then delete. The clipboard is a SNAPSHOT, so a paste still works
  // after the source rows are gone — the property that makes cut possible at all.
  const cutSource = await gm.req('POST', fogPath, { type: 'rect', points: rect(90, 90, 95, 95) });
  const cutId = cutSource.data.fog.id;
  const snapshot = { type: cutSource.data.fog.type, points: cutSource.data.fog.points };
  await gm.req('DELETE', `${fogPath}/${cutId}`);
  const afterCut = await gm.req('POST', `${fogPath}/copy`, { regions: [snapshot] });
  check('paste STILL works after the source was deleted (cut works)', afterCut.status === 201, JSON.stringify(afterCut.data));

  // ---- deletion ----
  const wantDelete = waitFor(playerSock, 'fog:deleted');
  const del = await gm.req('DELETE', `${fogPath}/${windowId}`);
  check('GM deletes a region (200)', del.status === 200, JSON.stringify(del.data));
  const gotDelete = await wantDelete;
  check('player receives fog:deleted in real time', gotDelete && gotDelete.id === windowId, JSON.stringify(gotDelete));
  const goneRow = await knex('fog_of_war').where({ id: windowId }).first();
  check('deleted region is gone from the DB', !goneRow);

  const wantBatch = waitFor(playerSock, 'fog:deleted-batch');
  const batch = await gm.req('POST', `${fogPath}/batch-delete`, { fog_ids: [circleId, backId] });
  check('GM batch-deletes (200)', batch.status === 200, JSON.stringify(batch.data));
  check('batch reports both ids', batch.data.deleted && batch.data.deleted.length === 2, JSON.stringify(batch.data));
  const gotBatch = await wantBatch;
  check('player receives fog:deleted-batch', gotBatch && gotBatch.ids.length === 2, JSON.stringify(gotBatch));
  const batchGone = await knex('fog_of_war').whereIn('id', [circleId, backId]);
  check('batch-deleted rows are gone', batchGone.length === 0);

  const badBatch = await gm.req('POST', `${fogPath}/batch-delete`, { fog_ids: ['not-a-uuid'] });
  check('malformed uuid in batch rejected (400)', badBatch.status === 400, `got ${badBatch.status}`);

  // clear-all is scoped to ONE scene: scene2's fog must survive.
  await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${scene2Id}/fog`,
    { type: 'rect', points: rect(0, 0, 5, 5) });
  const clearAll = await gm.req('POST', `${fogPath}/batch-delete`, { all: true });
  check('clear-all succeeds (200)', clearAll.status === 200, JSON.stringify(clearAll.data));
  const leftInScene1 = await knex('fog_of_war').where({ scene_id: sceneId });
  check('scene 1 fog fully cleared', leftInScene1.length === 0, `${leftInScene1.length} left`);
  const leftInScene2 = await knex('fog_of_war').where({ scene_id: scene2Id });
  check('clear-all did NOT touch the other scene', leftInScene2.length === 1, `${leftInScene2.length} left`);

  const allFalse = await gm.req('POST', `${fogPath}/batch-delete`, { all: false });
  check('all:false rejected rather than silently wiping (400)', allFalse.status === 400, `got ${allFalse.status}`);

  // ---- active_scene_id ----
  const activePath = `/api/campaigns/${campaignId}/scenes/active`;
  const wantActive = waitFor(playerSock, 'scene:activated');
  const setActive = await gm.req('PUT', activePath, { scene_id: sceneId });
  check('GM sets the active scene (200)', setActive.status === 200, JSON.stringify(setActive.data));
  const gotActive = await wantActive;
  check('room is told which scene is active', gotActive && gotActive.scene_id === sceneId, JSON.stringify(gotActive));

  const campRow = await knex('campaigns').where({ id: campaignId }).first();
  check('active_scene_id persisted', campRow && campRow.active_scene_id === sceneId);

  const detail = await player.req('GET', `/api/campaigns/${campaignId}`);
  check('active_scene_id survives a reload (restore-on-load)',
    detail.data.campaign && detail.data.campaign.active_scene_id === sceneId,
    JSON.stringify(detail.data.campaign && detail.data.campaign.active_scene_id));

  const clear = await gm.req('PUT', activePath, { scene_id: null });
  check('GM clears the active scene (200)', clear.status === 200, JSON.stringify(clear.data));
  const clearedRow = await knex('campaigns').where({ id: campaignId }).first();
  check('cleared active_scene_id is null', clearedRow && clearedRow.active_scene_id === null);

  const noField = await gm.req('PUT', activePath, {});
  check('missing scene_id rejected (400)', noField.status === 400, `got ${noField.status}`);

  const pActive = await player.req('PUT', activePath, { scene_id: sceneId });
  check('player cannot set the active scene (403)', pActive.status === 403, `got ${pActive.status}`);
  const sActive = await stranger.req('PUT', activePath, { scene_id: sceneId });
  check('non-member cannot set the active scene -> 404', sActive.status === 404, `got ${sActive.status}`);

  // A GM must not be able to point their campaign at a foreign scene: that is
  // both IDOR and an integrity bug, since every member would then load it.
  const other = await makeUser('other');
  const otherCamp = await other.req('POST', '/api/campaigns', { name: 'Elsewhere', is_public: true });
  const otherScene = await other.req('POST', `/api/campaigns/${otherCamp.data.campaign.id}/scenes`, { name: 'Foreign' });
  const foreign = await gm.req('PUT', activePath, { scene_id: otherScene.data.scene.id });
  check('active scene cannot point at another campaign -> 404', foreign.status === 404, `got ${foreign.status}`);

  // ---- fog dies with its scene (ON DELETE CASCADE) ----
  await gm.req('POST', `/api/campaigns/${campaignId}/scenes/${scene2Id}/fog`,
    { type: 'poly', points: tri(1, 1) });
  const before = await knex('fog_of_war').where({ scene_id: scene2Id });
  check('scene 2 has fog before the cascade check', before.length === 2, `${before.length}`);
  await knex('scenes').where({ id: scene2Id }).del();
  const after = await knex('fog_of_war').where({ scene_id: scene2Id });
  check('deleting a scene cascades its fog away', after.length === 0, `${after.length} orphans`);

  gmSock.close(); playerSock.close(); strangerSock.close();

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
