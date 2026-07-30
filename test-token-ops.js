// Adversarial suite for token manipulation (resize / hide / lock / batch-move /
// batch-delete / copy-paste). Run against a real PostgreSQL with the server up:
//   SKIP_HIBP=1 node test-token-ops.js
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0; const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}  ${detail}`); }
}
function agent() {
  let c = '';
  return { get cookie() { return c; },
    async req(m, p, b) {
      const h = { Origin: BASE }; if (b !== undefined) h['Content-Type'] = 'application/json';
      if (c) h.Cookie = c;
      const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
      const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0];
      let d = null; try { d = await r.json(); } catch {}
      return { status: r.status, data: d };
    } };
}
async function mk(n) {
  const a = agent();
  const e = `${n}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const pw = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', { email: e, username: `${n}${Math.random().toString(16).slice(2, 8)}`, password: pw });
  await knex('users').where({ email: e }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email: e, password: pw });
  a.id = l.data.user.id; a.username = l.data.user.username;
  return a;
}
function socketFor(a) { return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true }); }
const connected = (s) => new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('connect timeout')), 3000); });
const emitAck = (s, ev, pl) => new Promise((res) => { s.emit(ev, pl, res); setTimeout(() => res({ ok: false, error: 'timeout' }), 3000); });
function waitFor(s, ev, ms = 1200) { return new Promise((res) => { const t = setTimeout(() => { s.off(ev, h); res(null); }, ms); const h = (d) => { clearTimeout(t); s.off(ev, h); res(d); }; s.on(ev, h); }); }

(async () => {
  const gm = await mk('gm');
  const player = await mk('player');

  const c = await gm.req('POST', '/api/campaigns', { name: 'TokenOps', is_public: true });
  const cid = c.data.campaign.id;
  await player.req('POST', `/api/campaigns/${cid}/join`, {});
  const s = await gm.req('POST', `/api/campaigns/${cid}/scenes`, { name: 'S1' });
  const sid = s.data.scene.id;
  const scenePath = `/api/campaigns/${cid}/scenes/${sid}`;
  // The active-scene rule (M3) pins players to the campaign's active scene, so
  // every player-path assertion below needs this scene to BE the active one.
  // Written before that rule existed; this line is what the old contract
  // implicitly assumed.
  await gm.req('PUT', `/api/campaigns/${cid}/scenes/active`, { scene_id: sid });

  // seed tokens: two GM tokens, one player token
  const g1 = (await gm.req('POST', `${scenePath}/tokens`, { name: 'G1', x: 1, y: 1 })).data.token;
  const g2 = (await gm.req('POST', `${scenePath}/tokens`, { name: 'G2', x: 2, y: 2 })).data.token;
  const p1 = (await player.req('POST', `${scenePath}/tokens`, { name: 'P1', x: 3, y: 3 })).data.token;

  // ---- resize presets ----
  const rz = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { size: 'large' });
  check('resize preset large -> 2x2', rz.status === 200 && rz.data.token.width === 2 && rz.data.token.height === 2, JSON.stringify(rz.data));
  const rzT = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { size: 'tiny' });
  check('resize preset tiny -> 0.5x0.5', rzT.status === 200 && rzT.data.token.width === 0.5, JSON.stringify(rzT.data));
  const rzBad = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { size: 'colossal' });
  check('invalid size rejected (400)', rzBad.status === 400, `got ${rzBad.status}`);
  const rzBoth = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { size: 'large', width: 5 });
  check('size + width together rejected (400)', rzBoth.status === 400, `got ${rzBoth.status}`);
  const rzCustom = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { width: 3, height: 3 });
  check('custom width/height resize (Huge-equiv)', rzCustom.status === 200 && rzCustom.data.token.width === 3);
  const rzZero = await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { width: 0 });
  check('zero width rejected (400)', rzZero.status === 400, `got ${rzZero.status}`);

  // ---- resize permission: player cannot ----
  const rzPlayer = await player.req('PATCH', `${scenePath}/tokens/${p1.id}`, { size: 'large' });
  check('player cannot resize even own token (403)', rzPlayer.status === 403, `got ${rzPlayer.status}`);

  // ---- lock blocks move ----
  await gm.req('PATCH', `${scenePath}/tokens/${g2.id}`, { locked: true });
  const gmSock = await connected(socketFor(gm));
  await emitAck(gmSock, 'campaign:join', { campaign_id: cid });
  const lockedMove = await emitAck(gmSock, 'token:move', { campaign_id: cid, scene_id: sid, token_id: g2.id, x: 9, y: 9 });
  check('locked token refuses move', lockedMove.ok === false, JSON.stringify(lockedMove));
  await gm.req('PATCH', `${scenePath}/tokens/${g2.id}`, { locked: false });
  const unlockedMove = await emitAck(gmSock, 'token:move', { campaign_id: cid, scene_id: sid, token_id: g2.id, x: 9, y: 9 });
  check('unlocked token moves again', unlockedMove.ok === true, JSON.stringify(unlockedMove));

  // ---- lock/hidden permission: player cannot set ----
  const lkPlayer = await player.req('PATCH', `${scenePath}/tokens/${p1.id}`, { locked: true });
  check('player cannot lock (403)', lkPlayer.status === 403, `got ${lkPlayer.status}`);

  // ---- TRUE HIDING: player scene-load must NOT include a hidden token ----
  await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { hidden: true });
  const gmLoad = await gm.req('GET', scenePath);
  const playerLoad = await player.req('GET', scenePath);
  const gmSeesHidden = gmLoad.data.tokens.some((t) => t.id === g1.id);
  const playerSeesHidden = playerLoad.data.tokens.some((t) => t.id === g1.id);
  check('GM scene-load includes hidden token', gmSeesHidden);
  check('player scene-load EXCLUDES hidden token', !playerSeesHidden, `player saw ${playerLoad.data.tokens.map(t=>t.name)}`);

  // ---- hidden broadcast: player socket must not receive a hidden token's move/create ----
  const playerSock = await connected(socketFor(player));
  await emitAck(playerSock, 'campaign:join', { campaign_id: cid });
  const playerGetsHiddenMove = waitFor(playerSock, 'token:moved');           // must NOT fire for g1
  const gmGetsHiddenMove = waitFor(gmSock, 'token:moved');
  await emitAck(gmSock, 'token:move', { campaign_id: cid, scene_id: sid, token_id: g1.id, x: 5, y: 6 });
  const pHid = await playerGetsHiddenMove; const gHid = await gmGetsHiddenMove;
  check('GM receives hidden token move', gHid && gHid.id === g1.id);
  check('player does NOT receive hidden token move', pHid === null || pHid.id !== g1.id, JSON.stringify(pHid));

  // ---- un-hide re-materialises for player (token:created to players) ----
  const playerGetsCreate = waitFor(playerSock, 'token:created');
  await gm.req('PATCH', `${scenePath}/tokens/${g1.id}`, { hidden: false });
  const reveal = await playerGetsCreate;
  check('un-hide sends token:created to player', reveal && reveal.id === g1.id, JSON.stringify(reveal));

  // ---- batch move: partial success (player nudges a mix, only own moves) ----
  // player selects g2 (GM's) + p1 (own); server must move only p1.
  const batch = await emitAck(playerSock, 'token:move-batch', {
    campaign_id: cid, scene_id: sid, moves: [{ token_id: g2.id, x: 0, y: 0 }, { token_id: p1.id, x: 7, y: 7 }],
  });
  check('batch move ok with partial', batch.ok === true, JSON.stringify(batch));
  check('batch applied only own token', batch.applied.length === 1 && batch.applied[0].id === p1.id, JSON.stringify(batch.applied));
  check('batch rejected the GM token', batch.rejected.some((r) => r.token_id === g2.id), JSON.stringify(batch.rejected));
  const g2row = await knex('tokens').where({ id: g2.id }).first();
  check('rejected token did not move in DB', Number(g2row.x) === 9, `x=${g2row.x}`);

  // ---- copy/paste: GM only, duplicates owned by GM ----
  // The clipboard is a SNAPSHOT: the body carries token specs, not ids, so a
  // paste works even after the source row is gone (that is what makes cut work).
  const spec = { name: 'Clone', width: 2, height: 2, hidden: false, x: 4, y: 4 };
  const copyRes = await gm.req('POST', `${scenePath}/tokens/copy`, { tokens: [spec] });
  check('GM paste creates token (201)', copyRes.status === 201 && copyRes.data.tokens.length === 1, JSON.stringify(copyRes.data));
  const dup = copyRes.data.tokens[0];
  check('pasted token owned by GM', dup.created_by === gm.id);
  check('pasted token lands at the requested position', dup.x === 4 && dup.y === 4, `(${dup.x},${dup.y})`);
  check('pasted token keeps size from the spec', dup.width === 2 && dup.height === 2);
  check('pasted token has actor_id null', dup.actor_id === null);

  // The whole point of the snapshot design: DELETE the source, then paste it.
  await gm.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: [dup.id] });
  const pasteAfterDelete = await gm.req('POST', `${scenePath}/tokens/copy`, { tokens: [spec] });
  check('paste STILL works after the source was deleted (cut works)',
    pasteAfterDelete.status === 201 && pasteAfterDelete.data.tokens.length === 1, JSON.stringify(pasteAfterDelete.data));
  const dup2 = pasteAfterDelete.data.tokens[0];

  // forged server-owned fields in a spec must be ignored
  const forged = await gm.req('POST', `${scenePath}/tokens/copy`, {
    tokens: [{ name: 'Forged', created_by: player.id, actor_id: player.id, id: '00000000-0000-0000-0000-000000000000', locked: true }],
  });
  check('paste ignores forged created_by/actor_id/id',
    forged.status === 201 && forged.data.tokens[0].created_by === gm.id &&
    forged.data.tokens[0].actor_id === null &&
    forged.data.tokens[0].id !== '00000000-0000-0000-0000-000000000000', JSON.stringify(forged.data));
  check('pasted token always starts unlocked', forged.status === 201 && forged.data.tokens[0].locked === false);

  // spec validation
  const badSpec = await gm.req('POST', `${scenePath}/tokens/copy`, { tokens: [{ name: 'x', x: 'NaN' }] });
  check('paste rejects a non-finite coord (400)', badSpec.status === 400, `got ${badSpec.status}`);
  const notArray = await gm.req('POST', `${scenePath}/tokens/copy`, { tokens: 'nope' });
  check('paste rejects non-array tokens (400)', notArray.status === 400, `got ${notArray.status}`);
  const emptyArr = await gm.req('POST', `${scenePath}/tokens/copy`, { tokens: [] });
  check('paste rejects empty tokens (400)', emptyArr.status === 400, `got ${emptyArr.status}`);

  const copyPlayer = await player.req('POST', `${scenePath}/tokens/copy`, { tokens: [spec] });
  check('player cannot copy/paste (403)', copyPlayer.status === 403, `got ${copyPlayer.status}`);

  // ---- batch delete: GM only ----
  const delPlayer = await player.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: [p1.id] });
  check('player cannot batch-delete (403)', delPlayer.status === 403, `got ${delPlayer.status}`);
  const delGm = await gm.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: [g1.id, g2.id, dup2.id] });
  check('GM batch-delete ok', delGm.status === 200 && delGm.data.deleted.length === 3, JSON.stringify(delGm.data));
  const remaining = await knex('tokens').whereIn('id', [g1.id, g2.id, dup2.id]).count({ n: '*' }).first();
  check('deleted rows gone from DB', Number(remaining.n) === 0, `remaining=${remaining.n}`);
  const p1Still = await knex('tokens').where({ id: p1.id }).first();
  check('untargeted token survived the batch delete', !!p1Still);

  // ---- batch validation ----
  const badBatch = await gm.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: 'notarray' });
  check('non-array token_ids rejected (400)', badBatch.status === 400, `got ${badBatch.status}`);
  const emptyBatch = await gm.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: [] });
  check('empty token_ids rejected (400)', emptyBatch.status === 400, `got ${emptyBatch.status}`);
  const junkId = await gm.req('POST', `${scenePath}/tokens/batch-delete`, { token_ids: ['not-a-uuid'] });
  check('malformed uuid in batch rejected (400)', junkId.status === 400, `got ${junkId.status}`);

  // ---- cross-scene isolation: PATCH a token via the wrong scene path ----
  const s2 = (await gm.req('POST', `/api/campaigns/${cid}/scenes`, { name: 'S2' })).data.scene;
  const wrongScene = await gm.req('PATCH', `/api/campaigns/${cid}/scenes/${s2.id}/tokens/${p1.id}`, { size: 'large' });
  check('PATCH token via wrong scene -> 404', wrongScene.status === 404, `got ${wrongScene.status}`);

  gmSock.close(); playerSock.close();
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('SUITE CRASHED:', e); try { await knex.destroy(); } catch {} process.exit(1); });
