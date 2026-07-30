// Adversarial audit of the ACTIVE-SCENE boundary.
//   SKIP_HIBP=1 node break-active-scene.js
//
// The claim under test: a player can reach the campaign's active scene and
// nothing else — not by HTTP, not by socket, not by listening.
//
// Two vulnerabilities were found by code inspection while writing this file, and
// both are probed below. They are recorded here because the probes are only
// meaningful if you know what they were hunting:
//
//   V1 — DELETE /scenes/:id/tokens/:tokenId is the one player-reachable WRITE
//        besides placement, and the first pass of the active-scene work did not
//        gate it. A player could delete their own token on a scene the GM had
//        switched away from: mutating state on a map the server refuses to show
//        them. FIXED with the same mayUseScene() gate as the other player paths.
//
//   V2 — every scene-scoped socket broadcast went to the WHOLE campaign room.
//        Pinning players on the HTTP layer therefore leaked completely on the
//        socket layer: each token the GM placed and each fog region they drew
//        while prepping an unopened map was pushed to every player, who filtered
//        it client-side by scene_id. That is client-side filtering of data the
//        server should never have sent — the same security theatre that cosmetic
//        token-dimming was rejected as in M2, and it defeats the entire point of
//        the feature (the GM prepping a dungeon without spoiling it). FIXED with
//        broadcastScene / broadcastScenePlayers in socket.js: the GM always
//        receives scene events, players only on the active scene.
//
// The listening probes below (L1-L4) are the ones that matter: an HTTP-only
// audit passes cleanly against the vulnerable build.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  DEFENDED  ${name}`); }
  else { fail++; results.push(`  *** VULNERABLE ***  ${name}  ${detail}`); findings.push(`${name} :: ${detail}`); }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

function agent() {
  let c = '';
  return { get cookie() { return c; },
    async req(m, p, b) {
      const h = { Origin: BASE };
      if (b !== undefined) h['Content-Type'] = 'application/json';
      if (c) h.Cookie = c;
      const r = await fetch(BASE + p, { method: m, headers: h,
        body: b === undefined ? undefined : JSON.stringify(b) });
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
  a.id = l.data.user.id;
  return a;
}
function socketFor(a) {
  return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
}
const connected = (s) => new Promise((res, rej) => {
  s.on('connect', () => res(s)); s.on('connect_error', rej);
  setTimeout(() => rej(new Error('connect timeout')), 3000);
});
const emitAck = (s, ev, p) => new Promise((r) => {
  s.emit(ev, p, r); setTimeout(() => r({ ok: false, error: 'timeout' }), 3000);
});
// Collect every event of a set of names for a window, so we can assert SILENCE.
function recorder(socket, events) {
  const seen = [];
  for (const ev of events) socket.on(ev, (d) => seen.push({ ev, d }));
  return seen;
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const gm = await mk('gm'), player = await mk('pl'), outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'SceneBoundary', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const S = `/api/campaigns/${camp.id}/scenes`;

  const open = (await gm.req('POST', S, { name: 'Open' })).data.scene;
  const secret = (await gm.req('POST', S, { name: 'Secret' })).data.scene;

  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  await emitAck(gmSock, 'campaign:join', { campaign_id: camp.id });
  await emitAck(plSock, 'campaign:join', { campaign_id: camp.id });

  await gm.req('PUT', `${S}/active`, { scene_id: open.id });

  // ---------- API1 BOLA: reading across the boundary ----------
  ok('BOLA: player cannot read a non-active scene -> 404',
    (await player.req('GET', `${S}/${secret.id}`)).status === 404);
  const list = await player.req('GET', S);
  ok('BOLA: the scene list exposes only the active scene',
    list.data.scenes.length === 1 && list.data.scenes[0].id === open.id, JSON.stringify(list.data.scenes.map((x) => x.name)));
  ok('BOLA: the hidden scene\'s name never appears in the list',
    JSON.stringify(list.data).indexOf('Secret') === -1, JSON.stringify(list.data));

  // No oracle: a real-but-hidden scene must be indistinguishable from a fake id.
  const fake = '00000000-0000-4000-8000-000000000000';
  const rHidden = await player.req('GET', `${S}/${secret.id}`);
  const rFake = await player.req('GET', `${S}/${fake}`);
  ok('no enumeration oracle: hidden scene and nonexistent id answer identically',
    rHidden.status === rFake.status && JSON.stringify(rHidden.data) === JSON.stringify(rFake.data),
    `${rHidden.status}:${JSON.stringify(rHidden.data)} vs ${rFake.status}:${JSON.stringify(rFake.data)}`);
  ok('refusal is 404 not 403 (403 would confirm the map exists)', rHidden.status === 404, `got ${rHidden.status}`);

  // ---------- API5 BFLA: writing across the boundary ----------
  ok('BFLA: player cannot place a token on a non-active scene -> 404',
    (await player.req('POST', `${S}/${secret.id}/tokens`, { name: 'x', x: 1, y: 1 })).status === 404);
  ok('BFLA: player cannot activate a scene -> 403',
    (await player.req('PUT', `${S}/active`, { scene_id: secret.id })).status === 403);
  ok('BFLA: player cannot create a scene -> 403',
    (await player.req('POST', S, { name: 'mine' })).status === 403);

  // --- V1: the deactivated-scene delete ---
  // Legitimately place on the ACTIVE scene, then have the GM switch away. The
  // token is still the player's; the scene is no longer theirs to touch.
  const mine = (await player.req('POST', `${S}/${open.id}/tokens`, { name: 'Mine', x: 1, y: 1 })).data.token;
  await gm.req('PUT', `${S}/active`, { scene_id: secret.id });
  const delAfter = await player.req('DELETE', `${S}/${open.id}/tokens/${mine.id}`);
  ok('V1: player cannot delete their OWN token on a deactivated scene -> 404',
    delAfter.status === 404, `got ${delAfter.status}`);
  ok('V1: the token survived', !!(await knex('tokens').where({ id: mine.id }).first()));

  const staleMove = await emitAck(plSock, 'token:move',
    { campaign_id: camp.id, scene_id: open.id, token_id: mine.id, x: 9, y: 9 });
  ok('socket: move on a deactivated scene refused', staleMove && staleMove.ok === false, JSON.stringify(staleMove));
  const staleBatch = await emitAck(plSock, 'token:move-batch',
    { campaign_id: camp.id, scene_id: open.id, moves: [{ token_id: mine.id, x: 8, y: 8 }] });
  ok('socket: batch move on a deactivated scene refused', staleBatch && staleBatch.ok === false, JSON.stringify(staleBatch));
  const after = await knex('tokens').where({ id: mine.id }).first();
  ok('socket: no stale write persisted', after && Number(after.x) === 1, `x=${after && after.x}`);

  // ---------- V2: LISTENING across the boundary ----------
  // The scene 'open' is now INACTIVE. Everything the GM does there is prep, and
  // none of it may reach the player's socket. An HTTP-only audit misses this
  // entirely — the player is not asking for anything, only listening.
  const heard = recorder(plSock, ['token:created', 'token:updated', 'token:deleted',
    'token:deleted-batch', 'token:moved', 'token:moved-batch',
    'fog:created', 'fog:updated', 'fog:deleted', 'fog:deleted-batch']);
  const gmHeard = recorder(gmSock, ['token:created', 'fog:created']);

  const prepToken = (await gm.req('POST', `${S}/${open.id}/tokens`, { name: 'BossMonster', x: 4, y: 4 })).data.token;
  const prepFog = (await gm.req('POST', `${S}/${open.id}/fog`,
    { type: 'rect', points: [{ x: 0, y: 0 }, { x: 12, y: 12 }] })).data.fog;
  await gm.req('PATCH', `${S}/${open.id}/fog/${prepFog.id}`, { revealed: true });
  await gm.req('POST', `${S}/${open.id}/tokens/copy`, { tokens: [{ name: 'Ambush', x: 6, y: 6, width: 1, height: 1 }] });
  await emitAck(gmSock, 'token:move', { campaign_id: camp.id, scene_id: open.id, token_id: prepToken.id, x: 7, y: 7 });
  await gm.req('DELETE', `${S}/${open.id}/tokens/${prepToken.id}`);
  await settle();

  ok('L1: player hears NOTHING about a non-active scene',
    heard.length === 0, `leaked ${heard.length}: ${JSON.stringify(heard.map((h) => h.ev))}`);
  ok('L2: no token name from the GM\'s prep map reached the player',
    JSON.stringify(heard).indexOf('BossMonster') === -1 && JSON.stringify(heard).indexOf('Ambush') === -1,
    JSON.stringify(heard).slice(0, 300));
  ok('L3: no fog geometry from the prep map reached the player',
    !heard.some((h) => h.ev.startsWith('fog:')), JSON.stringify(heard.filter((h) => h.ev.startsWith('fog:'))));
  ok('L4: the GM still received their own scene events (not simply muted)',
    gmHeard.length >= 2, `gm heard ${gmHeard.length}`);

  // Control: on the ACTIVE scene the player must still hear everything, or the
  // fix has broken real-time play instead of securing it.
  const live = recorder(plSock, ['token:created', 'fog:created']);
  await gm.req('POST', `${S}/${secret.id}/tokens`, { name: 'Visible', x: 1, y: 1 });
  await gm.req('POST', `${S}/${secret.id}/fog`, { type: 'rect', points: [{ x: 0, y: 0 }, { x: 3, y: 3 }] });
  await settle();
  ok('control: the player DOES hear events on the active scene',
    live.length === 2, `heard ${live.length}: ${JSON.stringify(live.map((l) => l.ev))}`);

  // Composition: hidden AND active-scene are independent gates, and a token that
  // trips either one must not reach a player.
  //
  // The first version of this probe reported VULNERABLE and was WRONG: it posted
  // {hidden:true} at placement, which the endpoint ignored (explicit column
  // list), so the token really was visible and broadcasting it was correct. The
  // captured payload said hidden:false, which is what gave it away.
  //
  // The probe did expose a real gap, though: there was no way to place a token
  // already hidden, so a GM's only route was place-then-hide — flashing the
  // ambush to every player in between. Placement now accepts hidden for the GM,
  // and this probe checks that path for real.
  const hiddenHeard = recorder(plSock, ['token:created']);
  const lurker = await gm.req('POST', `${S}/${secret.id}/tokens`, { name: 'Lurker', x: 2, y: 2, hidden: true });
  await settle();
  ok('a token can be placed ALREADY hidden (no place-then-hide flash)',
    lurker.status === 201 && lurker.data.token.hidden === true, JSON.stringify(lurker.data));
  ok('composition: a hidden token on the ACTIVE scene never reaches players',
    hiddenHeard.length === 0, JSON.stringify(hiddenHeard));
  const plSees = await player.req('GET', `${S}/${secret.id}`);
  ok('and the player\'s scene load excludes it too',
    !plSees.data.tokens.some((t) => t.id === lurker.data.token.id),
    JSON.stringify(plSees.data.tokens.map((t) => t.name)));

  // A player must not be able to place a hidden token by asking nicely.
  const plHidden = await player.req('POST', `${S}/${secret.id}/tokens`, { name: 'PlayerGhost', x: 5, y: 5, hidden: true });
  ok('a player cannot place a hidden token (flag ignored)',
    plHidden.status === 201 && plHidden.data.token.hidden === false, JSON.stringify(plHidden.data));

  // ---------- the GM is not pinned (the feature must not over-reach) ----------
  ok('GM can still read a non-active scene', (await gm.req('GET', `${S}/${open.id}`)).status === 200);
  ok('GM can still write to a non-active scene',
    (await gm.req('POST', `${S}/${open.id}/tokens`, { name: 'prep2', x: 1, y: 1 })).status === 201);
  ok('GM opening a scene does not silently activate it',
    (await knex('campaigns').where({ id: camp.id }).first()).active_scene_id === secret.id);

  // ---------- outsiders ----------
  ok('outsider cannot list scenes -> 404', (await outsider.req('GET', S)).status === 404);
  ok('outsider cannot read the active scene -> 404',
    (await outsider.req('GET', `${S}/${secret.id}`)).status === 404);
  ok('outsider cannot activate -> 404',
    (await outsider.req('PUT', `${S}/active`, { scene_id: open.id })).status === 404);

  // ---------- cross-campaign ----------
  const other = (await outsider.req('POST', '/api/campaigns', { name: 'Theirs', is_public: true })).data.campaign;
  const otherScene = (await outsider.req('POST', `/api/campaigns/${other.id}/scenes`, { name: 'Foreign' })).data.scene;
  ok('a GM cannot activate another campaign\'s scene -> 404',
    (await gm.req('PUT', `${S}/active`, { scene_id: otherScene.id })).status === 404);
  ok('the victim campaign\'s pointer is unchanged',
    (await knex('campaigns').where({ id: camp.id }).first()).active_scene_id === secret.id);

  // ---------- malformed / type confusion on the pin ----------
  for (const [label, id] of [['array', ['x']], ['object', { id: 1 }], ['number', 7], ['sql', "' OR 1=1--"]]) {
    const r = await player.req('GET', `${S}/${encodeURIComponent(JSON.stringify(id))}`);
    ok(`TYPE: ${label} scene id -> 4xx, not 500`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  const injList = await player.req('GET', `${S}?x=' OR 1=1--`);
  ok('injection in the list query has no effect',
    injList.status === 200 && injList.data.scenes.length <= 1, JSON.stringify(injList.data));

  // ---------- clearing ----------
  await gm.req('PUT', `${S}/active`, { scene_id: null });
  const clearedList = await player.req('GET', S);
  ok('with no active scene a player sees nothing', clearedList.data.scenes.length === 0, JSON.stringify(clearedList.data));
  ok('with no active scene every scene 404s for the player',
    (await player.req('GET', `${S}/${secret.id}`)).status === 404);
  const clearedHeard = recorder(plSock, ['token:created']);
  await gm.req('POST', `${S}/${secret.id}/tokens`, { name: 'AfterClear', x: 0, y: 0 });
  await settle();
  ok('with no active scene the player hears nothing at all',
    clearedHeard.length === 0, JSON.stringify(clearedHeard));

  note('scope', 'active-scene pin covers: scene list, scene load, token place, token delete, socket move/move-batch, and every scene-scoped broadcast');
  note('TOCTOU window', 'mayUseScene reads req.campaign loaded by requireMember; a scene switch landing between middleware and handler can serve the just-previous scene once. Sub-millisecond, and the worst case is one stale read of a map the player could legitimately see a moment earlier.');

  gmSock.close(); plSock.close();
  console.log('\n' + results.join('\n'));
  console.log('\n' + '='.repeat(60));
  console.log(`${pass} defended, ${fail} VULNERABLE`);
  if (findings.length) console.log('\nFINDINGS:\n' + findings.map((f) => '  - ' + f).join('\n'));
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('AUDIT CRASHED:', e);
  try { await knex.destroy(); } catch {}
  process.exit(1);
});
