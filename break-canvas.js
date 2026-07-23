// Adversarial security audit of the M2 canvas layer (scenes + tokens).
// Companion to break-campaigns.js. Run with the server up:
//   SKIP_HIBP=1 node break-canvas.js
//
// Probe classes, mapped to OWASP API Security Top 10 (2023):
//   API1 BOLA  — object-level: cross-campaign / cross-scene object access
//   API3 BOPLA — property-level: forging server-owned fields, hidden-token leaks
//   API5 BFLA  — function-level: players reaching GM-only functions
//   API4 Unrestricted Resource Consumption — batch amplification, no rate limit
//   plus: type confusion, TOCTOU on the player token cap, socket authz drift.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {            // defended
  if (cond) { pass++; results.push(`  DEFENDED  ${name}`); }
  else { fail++; results.push(`  *** VULNERABLE ***  ${name}  ${detail}`); findings.push(name + ' :: ' + detail); }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

function agent() {
  let c = '';
  return { get cookie() { return c; },
    async req(m, p, b, extraHeaders = {}) {
      const h = { Origin: BASE, ...extraHeaders };
      if (b !== undefined) h['Content-Type'] = 'application/json';
      if (c) h.Cookie = c;
      const r = await fetch(BASE + p, { method: m, headers: h,
        body: b === undefined ? undefined : (typeof b === 'string' ? b : JSON.stringify(b)) });
      const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0];
      let d = null; try { d = await r.json(); } catch {}
      return { status: r.status, data: d };
    } };
}
async function mk(n) {
  const a = agent();
  const e = `${n}-${Date.now()}-${Math.random().toString(16).slice(2,8)}@example.com`;
  const pw = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', { email: e, username: `${n}${Math.random().toString(16).slice(2,8)}`, password: pw });
  await knex('users').where({ email: e }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email: e, password: pw });
  a.id = l.data.user.id;
  return a;
}
const sock = (a) => io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
const conn = (s) => new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('timeout')), 3000); });
const emit = (s, ev, p) => new Promise((r) => { s.emit(ev, p, r); setTimeout(() => r({ ok:false, error:'timeout' }), 3000); });
const waitFor = (s, ev, ms=900) => new Promise((r) => { const t=setTimeout(()=>{s.off(ev,h);r(null);},ms); const h=(d)=>{clearTimeout(t);s.off(ev,h);r(d);}; s.on(ev,h); });

(async () => {
  const gm = await mk('gm'), player = await mk('pl'), outsider = await mk('out');

  // Victim campaign (GM + player). Attacker campaign owned by the outsider.
  const victim = (await gm.req('POST', '/api/campaigns', { name: 'Victim', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${victim.id}/join`, {});
  const attacker = (await outsider.req('POST', '/api/campaigns', { name: 'Attacker', is_public: true })).data.campaign;

  const vScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'V' })).data.scene;
  const aScene = (await outsider.req('POST', `/api/campaigns/${attacker.id}/scenes`, { name: 'A' })).data.scene;
  const vPath = `/api/campaigns/${victim.id}/scenes/${vScene.id}`;
  const vTok = (await gm.req('POST', `${vPath}/tokens`, { name: 'Secret', x: 1, y: 1 })).data.token;

  // ============ API1: BOLA — object level ============
  // Address the victim's scene through the attacker's own campaign (both owned by caller).
  let r = await outsider.req('GET', `/api/campaigns/${attacker.id}/scenes/${vScene.id}`);
  ok('BOLA: victim scene via attacker campaign path -> 404', r.status === 404, `got ${r.status}`);

  // Address the victim's token through the attacker's own scene.
  r = await outsider.req('PATCH', `/api/campaigns/${attacker.id}/scenes/${aScene.id}/tokens/${vTok.id}`, { size: 'huge' });
  ok('BOLA: victim token via attacker scene -> 404', r.status === 404, `got ${r.status}`);
  const untouched = await knex('tokens').where({ id: vTok.id }).first();
  ok('BOLA: victim token unchanged in DB', Number(untouched.width) === 1, `width=${untouched.width}`);

  // Outsider tries the victim campaign directly (not a member).
  r = await outsider.req('GET', `${vPath}`);
  ok('BOLA: non-member scene read -> 404 (no existence leak)', r.status === 404, `got ${r.status}`);
  r = await outsider.req('POST', `${vPath}/tokens/batch-delete`, { token_ids: [vTok.id] });
  ok('BOLA: non-member batch-delete -> 404', r.status === 404, `got ${r.status}`);
  const stillThere = await knex('tokens').where({ id: vTok.id }).first();
  ok('BOLA: token survived non-member delete attempt', !!stillThere);

  // Cross-scene within the SAME campaign (GM owns both, but token belongs to scene A).
  const vScene2 = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'V2' })).data.scene;
  r = await gm.req('PATCH', `/api/campaigns/${victim.id}/scenes/${vScene2.id}/tokens/${vTok.id}`, { size: 'large' });
  ok('BOLA: token addressed via the wrong scene -> 404', r.status === 404, `got ${r.status}`);

  // ============ API5: BFLA — function level ============
  for (const [label, call] of [
    ['resize',       () => player.req('PATCH', `${vPath}/tokens/${vTok.id}`, { size: 'huge' })],
    ['hide',         () => player.req('PATCH', `${vPath}/tokens/${vTok.id}`, { hidden: true })],
    ['lock',         () => player.req('PATCH', `${vPath}/tokens/${vTok.id}`, { locked: true })],
    ['batch-delete', () => player.req('POST',  `${vPath}/tokens/batch-delete`, { token_ids: [vTok.id] })],
    ['paste',        () => player.req('POST',  `${vPath}/tokens/copy`, { tokens: [{ name: 'x' }] })],
    ['create scene', () => player.req('POST',  `/api/campaigns/${victim.id}/scenes`, { name: 'sneak' })],
  ]) {
    const res = await call();
    ok(`BFLA: player cannot ${label} (403)`, res.status === 403, `got ${res.status}`);
  }

  // ============ API3: BOPLA — property level ============
  // Forge server-owned fields through every write path.
  r = await gm.req('POST', `${vPath}/tokens`, {
    name: 'Forge', created_by: player.id, actor_id: player.id, scene_id: aScene.id,
    id: '00000000-0000-0000-0000-000000000000', locked: true, hidden: true,
  });
  ok('BOPLA: placement ignores forged created_by', r.data.token.created_by === gm.id, r.data.token.created_by);
  ok('BOPLA: placement ignores forged actor_id', r.data.token.actor_id === null);
  ok('BOPLA: placement ignores forged scene_id', r.data.token.scene_id === vScene.id);
  ok('BOPLA: placement ignores forged id', r.data.token.id !== '00000000-0000-0000-0000-000000000000');
  const forgedTok = r.data.token;

  // PATCH must not let a GM rewrite immutable identity fields.
  r = await gm.req('PATCH', `${vPath}/tokens/${forgedTok.id}`, {
    created_by: player.id, scene_id: aScene.id, actor_id: player.id, id: vTok.id, size: 'large',
  });
  const afterPatch = await knex('tokens').where({ id: forgedTok.id }).first();
  ok('BOPLA: PATCH cannot rewrite created_by', afterPatch.created_by === gm.id, afterPatch.created_by);
  ok('BOPLA: PATCH cannot move a token to another scene', afterPatch.scene_id === vScene.id);
  ok('BOPLA: PATCH cannot set actor_id', afterPatch.actor_id === null);

  // Paste specs must not carry privileged fields through.
  r = await gm.req('POST', `${vPath}/tokens/copy`, {
    tokens: [{ name: 'P', created_by: player.id, actor_id: player.id, scene_id: aScene.id, locked: true }],
  });
  ok('BOPLA: paste ignores forged created_by', r.data.tokens[0].created_by === gm.id);
  ok('BOPLA: paste ignores forged scene_id', r.data.tokens[0].scene_id === vScene.id);
  ok('BOPLA: paste forces locked=false', r.data.tokens[0].locked === false);

  // ============ Hidden-token confidentiality ============
  await gm.req('PATCH', `${vPath}/tokens/${vTok.id}`, { hidden: true });
  const pLoad = await player.req('GET', vPath);
  ok('HIDDEN: player scene-load excludes hidden token',
    !pLoad.data.tokens.some(t => t.id === vTok.id),
    JSON.stringify(pLoad.data.tokens.map(t => t.name)));

  // A player must not be able to move / read a hidden token even knowing its id.
  const pSock = await conn(sock(player)); await emit(pSock, 'campaign:join', { campaign_id: victim.id });
  const gmSock = await conn(sock(gm));   await emit(gmSock, 'campaign:join', { campaign_id: victim.id });
  const mv = await emit(pSock, 'token:move', { campaign_id: victim.id, scene_id: vScene.id, token_id: vTok.id, x: 5, y: 5 });
  ok('HIDDEN: player cannot move a hidden GM token', mv.ok === false, JSON.stringify(mv));
  // A hidden token's move must not be broadcast to players.
  const leak = waitFor(pSock, 'token:moved');
  await emit(gmSock, 'token:move', { campaign_id: victim.id, scene_id: vScene.id, token_id: vTok.id, x: 8, y: 8 });
  const leaked = await leak;
  ok('HIDDEN: hidden token move is not broadcast to players', leaked === null || leaked.id !== vTok.id, JSON.stringify(leaked));
  // Batch move of a hidden token likewise.
  const leak2 = waitFor(pSock, 'token:moved-batch');
  await emit(gmSock, 'token:move-batch', { campaign_id: victim.id, scene_id: vScene.id, moves: [{ token_id: vTok.id, x: 2, y: 2 }] });
  const leaked2 = await leak2;
  ok('HIDDEN: hidden token batch-move not broadcast to players',
    leaked2 === null || !(leaked2.tokens || []).some(t => t.id === vTok.id), JSON.stringify(leaked2));
  await gm.req('PATCH', `${vPath}/tokens/${vTok.id}`, { hidden: false });

  // ============ Socket authorization drift ============
  const oSock = await conn(sock(outsider));
  const j = await emit(oSock, 'campaign:join', { campaign_id: victim.id });
  ok('SOCKET: outsider cannot join the victim room', j.ok === false, JSON.stringify(j));
  const om = await emit(oSock, 'token:move', { campaign_id: victim.id, scene_id: vScene.id, token_id: vTok.id, x: 0, y: 0 });
  ok('SOCKET: outsider token:move refused', om.ok === false, JSON.stringify(om));
  const ob = await emit(oSock, 'token:move-batch', { campaign_id: victim.id, scene_id: vScene.id, moves: [{ token_id: vTok.id, x: 0, y: 0 }] });
  ok('SOCKET: outsider token:move-batch refused', ob.ok === false, JSON.stringify(ob));

  // Kick the player mid-session: their live socket must lose write access immediately.
  await gm.req('POST', `/api/campaigns/${victim.id}/members/${player.id}/kick`, {});
  const afterKick = await emit(pSock, 'token:move', { campaign_id: victim.id, scene_id: vScene.id, token_id: vTok.id, x: 3, y: 3 });
  ok('SOCKET: kicked member cannot move via a still-open socket', afterKick.ok === false, JSON.stringify(afterKick));
  await player.req('POST', `/api/campaigns/${victim.id}/join`, {});   // restore for later probes

  // ============ Type confusion / malformed input ============
  const junk = [
    ['array as size',      { size: ['large'] }],
    ['object as width',    { width: { $gt: 0 } }],
    ['null size',          { size: null }],
    ['boolean as hidden',  { hidden: 'maybe' }],
    ['nested array width', { width: [[5]] }],
  ];
  for (const [label, body] of junk) {
    const res = await gm.req('PATCH', `${vPath}/tokens/${vTok.id}`, body);
    ok(`TYPE: ${label} rejected (4xx, not 500)`, res.status >= 400 && res.status < 500, `got ${res.status}`);
  }
  // Malformed JSON body must 400, not crash.
  const bad = await gm.req('POST', `${vPath}/tokens/copy`, '{"tokens": [');
  ok('TYPE: malformed JSON -> 400 not 500', bad.status === 400, `got ${bad.status}`);

  // Socket payload fuzzing must never kill the process (CVE-2023-32695 class).
  for (const p of [null, 'string', 42, [], { campaign_id: {} }, { campaign_id: victim.id, scene_id: vScene.id, moves: 'x' },
                   { campaign_id: victim.id, scene_id: vScene.id, moves: [null] }]) {
    await emit(gmSock, 'token:move', p);
    await emit(gmSock, 'token:move-batch', p);
  }
  const alive = await gm.req('GET', '/api/auth/me');
  ok('DoS: server survives malformed socket payloads', alive.status === 200, `got ${alive.status}`);

  // ============ API4: Unrestricted Resource Consumption ============
  // Batch bounds.
  const big = Array.from({ length: 501 }, () => ({ name: 'x' }));
  r = await gm.req('POST', `${vPath}/tokens/copy`, { tokens: big });
  ok('DoS: paste batch >500 rejected', r.status === 400, `got ${r.status}`);
  const bigMoves = Array.from({ length: 501 }, () => ({ token_id: vTok.id, x: 1, y: 1 }));
  const bm = await emit(gmSock, 'token:move-batch', { campaign_id: victim.id, scene_id: vScene.id, moves: bigMoves });
  ok('DoS: move batch >500 rejected', bm.ok === false, JSON.stringify(bm).slice(0, 80));

  // Oversized strings.
  r = await gm.req('POST', `${vPath}/tokens`, { name: 'A'.repeat(5000) });
  ok('DoS: oversized token name rejected', r.status === 400, `got ${r.status}`);
  r = await gm.req('POST', `${vPath}/tokens`, { name: 'x', img_url: 'https://e.com/' + 'a'.repeat(5000) });
  ok('DoS: oversized img_url rejected', r.status === 400, `got ${r.status}`);

  // AMPLIFICATION: how many tokens can one authenticated GM create per request,
  // and is there any rate limit on repeating it?
  const t0 = Date.now();
  let created = 0;
  for (let i = 0; i < 12; i++) {
    const res = await gm.req('POST', `${vPath}/tokens/copy`,
      { tokens: Array.from({ length: 500 }, (_, k) => ({ name: 'flood' + k, x: k % 50, y: (k / 50) | 0 })) });
    if (res.status === 201) created += res.data.tokens.length; else break;
  }
  const elapsed = Date.now() - t0;
  const total = await knex('tokens').where({ scene_id: vScene.id }).count({ n: '*' }).first();
  ok('DoS: token flood is capped per scene', created < 6000 && Number(total.n) <= 500,
     `created ${created} tokens in ${elapsed}ms; scene now holds ${total.n}`);
  note('scene token count after flood', `${total.n} rows (cap is 500)`);

  // Scene creation flood — any cap?
  // Push past the documented cap (100) to prove the ceiling actually stops it.
  let scenes = 0, sceneStop = 0;
  for (let i = 0; i < 130; i++) {
    const res = await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'flood ' + i });
    if (res.status === 201) scenes++; else { sceneStop = res.status; break; }
  }
  const sceneRows = await knex('scenes').where({ campaign_id: victim.id }).count({ n: '*' }).first();
  ok('DoS: scene creation is capped per campaign',
    Number(sceneRows.n) <= 100 && sceneStop === 409,
    `campaign holds ${sceneRows.n} scenes; stopped with ${sceneStop || 'no rejection'}`);

  // The caps must hold under PARALLEL load too (standing constraint: atomic,
  // never read-then-write). Fresh scene, 40 concurrent single placements.
  const capScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'CapRace' })).data.scene;
  if (capScene) {
    const capPath = `/api/campaigns/${victim.id}/scenes/${capScene.id}`;
    await Promise.all(Array.from({ length: 40 }, (_, i) =>
      gm.req('POST', `${capPath}/tokens/copy`,
        { tokens: Array.from({ length: 20 }, (_, k) => ({ name: `p${i}-${k}` })) })));
    const capCount = await knex('tokens').where({ scene_id: capScene.id }).count({ n: '*' }).first();
    ok('TOCTOU: scene token cap holds under 40 parallel pastes (800 attempted)',
      Number(capCount.n) <= 500, `cap=500 but DB has ${capCount.n}`);
  }

  // ============ TOCTOU: the player 1-token cap under parallel load ============
  const victim2 = (await gm.req('POST', '/api/campaigns', { name: 'Race', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${victim2.id}/join`, {});
  const rScene = (await gm.req('POST', `/api/campaigns/${victim2.id}/scenes`, { name: 'R' })).data.scene;
  const parallel = await Promise.all(Array.from({ length: 25 }, () =>
    player.req('POST', `/api/campaigns/${victim2.id}/scenes/${rScene.id}/tokens`, { name: 'race' })));
  const accepted = parallel.filter(x => x.status === 201).length;
  const playerTokens = await knex('tokens').where({ scene_id: rScene.id, created_by: player.id }).count({ n: '*' }).first();
  ok('TOCTOU: player 1-token cap holds under 25 parallel creates',
    Number(playerTokens.n) === 1, `cap=1 but DB has ${playerTokens.n} (accepted ${accepted})`);

  // ============ XSS / scheme injection through token fields ============
  for (const evil of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
    const res = await gm.req('POST', `${vPath}/tokens`, { name: 'x', img_url: evil });
    ok(`XSS: img_url scheme "${evil.slice(0,18)}" rejected`, res.status === 400, `got ${res.status}`);
  }
  r = await gm.req('POST', `${vPath}/tokens`, { name: '<img src=x onerror=alert(1)>' });
  ok('XSS: markup in name stored as inert text (not executed server-side)',
     r.status === 201 && r.data.token.name.includes('<img'), 'stored as text — client must escape on render');
  note('name is stored raw', 'client renders via textContent (verified in scene.js) — do NOT switch to innerHTML');

  gmSock.close(); pSock.close(); oSock.close();

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} defended, ${fail} VULNERABLE`);
  if (findings.length) { console.log('\nFINDINGS:'); findings.forEach(f => console.log('  - ' + f)); }
  await knex.destroy();
  process.exit(0);   // audit is informational; findings are reported, not fatal
})().catch(async (e) => { console.error('AUDIT CRASHED:', e); try { await knex.destroy(); } catch {} process.exit(1); });
