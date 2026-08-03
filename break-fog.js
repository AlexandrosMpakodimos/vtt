// Adversarial security audit of the M3 fog layer (fog_of_war + active_scene_id).
// Companion to break-campaigns.js and break-canvas.js, kept as a security
// regression alongside the functional suites. Run with the server up:
//   SKIP_HIBP=1 node break-fog.js
//
// Probe classes, mapped to OWASP API Security Top 10 (2023):
//   API1 BOLA  — object-level: cross-campaign / cross-scene region access
//   API3 BOPLA — property-level: forging server-owned fields, patching `type`
//   API5 BFLA  — function-level: a player reaching GM-only fog functions
//   API4 Unrestricted Resource Consumption — vertex flooding, paste
//                amplification, and the per-scene region cap under parallel load
//   plus: type confusion in geometry, clear-all blast radius, and the
//         active-scene pointer as a cross-campaign write primitive.
//
// Note on what fog is NOT: fog is a PRESENTATION control, not a confidentiality
// boundary. scenes.img_url is delivered to every member, so a player already
// holds the whole map image; fog geometry is therefore sent to players
// deliberately (what is sent is exactly what is rendered). There are no
// "players must not receive fog" probes below because that is not a property
// the design claims — unlike hidden tokens, which break-canvas.js does probe.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

let pass = 0, fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
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

const rect = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y2 }];
const circle = (cx, cy, r) => [{ x: cx, y: cy }, { x: cx + r, y: cy }];

(async () => {
  const gm = await mk('gm'), player = await mk('pl'), outsider = await mk('out');

  // Victim campaign (GM + player). Attacker campaign owned by the outsider.
  const victim = (await gm.req('POST', '/api/campaigns', { name: 'FogVictim', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${victim.id}/join`, {});
  const attacker = (await outsider.req('POST', '/api/campaigns', { name: 'FogAttacker', is_public: true })).data.campaign;

  const vScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'V' })).data.scene;
  const vScene2 = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'V2' })).data.scene;
  const aScene = (await outsider.req('POST', `/api/campaigns/${attacker.id}/scenes`, { name: 'A' })).data.scene;

  const V = `/api/campaigns/${victim.id}/scenes/${vScene.id}/fog`;
  const V2 = `/api/campaigns/${victim.id}/scenes/${vScene2.id}/fog`;
  const A = `/api/campaigns/${attacker.id}/scenes/${aScene.id}/fog`;

  const vFog = (await gm.req('POST', V, { type: 'rect', points: rect(0, 0, 10, 10) })).data.fog;
  const vFog2 = (await gm.req('POST', V2, { type: 'circle', points: circle(5, 5, 2) })).data.fog;

  // ---------- API1: BOLA / IDOR ----------
  const viaAttackerCampaign = await outsider.req('PATCH',
    `/api/campaigns/${attacker.id}/scenes/${vScene.id}/fog/${vFog.id}`, { revealed: true });
  ok('BOLA: victim fog via attacker campaign path -> 404', viaAttackerCampaign.status === 404, `got ${viaAttackerCampaign.status}`);

  const viaAttackerScene = await outsider.req('PATCH', `${A}/${vFog.id}`, { revealed: true });
  ok('BOLA: victim fog via attacker scene -> 404', viaAttackerScene.status === 404, `got ${viaAttackerScene.status}`);

  const unchanged = await knex('fog_of_war').where({ id: vFog.id }).first();
  ok('BOLA: victim fog unchanged in DB', unchanged && unchanged.revealed === false, JSON.stringify(unchanged && unchanged.revealed));

  const wrongScene = await gm.req('PATCH', `${V2}/${vFog.id}`, { revealed: true });
  ok('BOLA: region addressed via the WRONG scene -> 404', wrongScene.status === 404, `got ${wrongScene.status}`);

  const outsiderRead = await outsider.req('GET', `/api/campaigns/${victim.id}/scenes/${vScene.id}`);
  ok('BOLA: non-member scene read -> 404 (no existence leak)', outsiderRead.status === 404, `got ${outsiderRead.status}`);

  const outsiderDelete = await outsider.req('DELETE', `${V}/${vFog.id}`);
  ok('BOLA: non-member delete -> 404', outsiderDelete.status === 404, `got ${outsiderDelete.status}`);

  const outsiderBatch = await outsider.req('POST', `${V}/batch-delete`, { all: true });
  ok('BOLA: non-member clear-all -> 404', outsiderBatch.status === 404, `got ${outsiderBatch.status}`);
  const survived = await knex('fog_of_war').where({ id: vFog.id }).first();
  ok('BOLA: region survived every outsider attempt', !!survived);

  // ---------- API5: BFLA — the player is a member, so 403 not 404 ----------
  ok('BFLA: player cannot draw fog (403)',
    (await player.req('POST', V, { type: 'rect', points: rect(1, 1, 2, 2) })).status === 403);
  ok('BFLA: player cannot toggle fog (403)',
    (await player.req('PATCH', `${V}/${vFog.id}`, { revealed: true })).status === 403);
  ok('BFLA: player cannot move fog (403)',
    (await player.req('PATCH', `${V}/${vFog.id}`, { points: rect(9, 9, 20, 20) })).status === 403);
  ok('BFLA: player cannot delete fog (403)',
    (await player.req('DELETE', `${V}/${vFog.id}`)).status === 403);
  ok('BFLA: player cannot clear all fog (403)',
    (await player.req('POST', `${V}/batch-delete`, { all: true })).status === 403);
  ok('BFLA: player cannot paste fog (403)',
    (await player.req('POST', `${V}/copy`, { regions: [{ type: 'rect', points: rect(0, 0, 2, 2) }] })).status === 403);
  ok('BFLA: player cannot set the active scene (403)',
    (await player.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: vScene.id })).status === 403);

  const afterBfla = await knex('fog_of_war').where({ scene_id: vScene.id });
  ok('BFLA: no player write left a trace', afterBfla.length === 1, `${afterBfla.length} rows`);

  // ---------- API3: BOPLA — server-owned properties ----------
  const forgedScene = await gm.req('POST', V, {
    type: 'rect', points: rect(3, 3, 6, 6), scene_id: vScene2.id,
  });
  ok('BOPLA: create ignores forged scene_id',
    forgedScene.status === 201 && forgedScene.data.fog.scene_id === vScene.id,
    JSON.stringify(forgedScene.data.fog && forgedScene.data.fog.scene_id));

  const forgedId = await gm.req('POST', V, {
    type: 'rect', points: rect(4, 4, 7, 7), id: '00000000-0000-4000-8000-000000000000',
  });
  ok('BOPLA: create ignores forged id',
    forgedId.status === 201 && forgedId.data.fog.id !== '00000000-0000-4000-8000-000000000000');

  const forgedTimestamps = await gm.req('POST', V, {
    type: 'rect', points: rect(5, 5, 8, 8), created_at: '1999-01-01T00:00:00Z',
  });
  const tsRow = await knex('fog_of_war').where({ id: forgedTimestamps.data.fog.id }).first();
  ok('BOPLA: created_at not client-settable',
    tsRow && new Date(tsRow.created_at).getFullYear() >= 2026, String(tsRow && tsRow.created_at));

  const pasteForged = await gm.req('POST', `${V}/copy`, {
    regions: [{ type: 'rect', points: rect(6, 6, 9, 9), scene_id: vScene2.id, id: 'x' }],
  });
  ok('BOPLA: paste ignores forged scene_id/id',
    pasteForged.status === 201 && pasteForged.data.fog[0].scene_id === vScene.id);

  const retype = await gm.req('PATCH', `${V}/${vFog.id}`, { type: 'poly' });
  ok('BOPLA: type is not patchable (400)', retype.status === 400, `got ${retype.status}`);

  const smuggleShape = await gm.req('PATCH', `${V}/${vFog.id}`, { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] });
  ok('BOPLA: PATCH points re-validated against the stored type (400)', smuggleShape.status === 400, `got ${smuggleShape.status}`);

  // ---------- type confusion (the class the M2 audit found in tokens) ----------
  const tc = async (name, points, type = 'rect') => {
    const r = await gm.req('POST', V, { type, points });
    ok(name, r.status >= 400 && r.status < 500, `got ${r.status}`);
  };
  await tc('TYPE: nested-array coord rejected (4xx, not 500)', [{ x: [[5]], y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: single-element-array coord rejected', [{ x: [5], y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: boolean coord rejected', [{ x: true, y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: object coord rejected', [{ x: { v: 5 }, y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: null coord rejected', [{ x: null, y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: point as array rejected', [[0, 0], [1, 1]]);
  await tc('TYPE: point as null rejected', [null, { x: 1, y: 1 }]);
  await tc('TYPE: points as object rejected', { x: 1, y: 1 });
  await tc('TYPE: points as string rejected', 'rect(0,0,5,5)');
  await tc('TYPE: array type rejected', rect(0, 0, 5, 5), ['rect']);
  await tc('TYPE: out-of-range coord rejected', [{ x: 1e9, y: 0 }, { x: 1, y: 1 }]);
  await tc('TYPE: NaN-as-null coord rejected', [{ x: null, y: null }, { x: 1, y: 1 }]);

  const badJson = await gm.req('POST', V, '{"type": "rect", "points":', { 'Content-Type': 'application/json' });
  ok('TYPE: malformed JSON -> 400 not 500', badJson.status === 400, `got ${badJson.status}`);

  // ---------- API4: resource consumption ----------
  // The bound that matters most: ONE region with a huge vertex list. A row cap
  // would never catch this, and every future scene load would carry it.
  const fatPoly = Array.from({ length: 5000 }, (_, i) => ({ x: i % 100, y: Math.floor(i / 100) }));
  const fat = await gm.req('POST', V, { type: 'poly', points: fatPoly });
  ok('DoS: 5000-vertex poly rejected', fat.status === 400, `got ${fat.status}`);

  const justOver = Array.from({ length: 501 }, (_, i) => ({ x: i % 100, y: 1 }));
  ok('DoS: 501-vertex poly rejected',
    (await gm.req('POST', V, { type: 'poly', points: justOver })).status === 400);
  const atBound = Array.from({ length: 500 }, (_, i) => ({ x: i % 100, y: 1 }));
  ok('DoS: 500-vertex poly accepted at the bound',
    (await gm.req('POST', V, { type: 'poly', points: atBound })).status === 201);

  const hugePaste = Array.from({ length: 201 }, () => ({ type: 'rect', points: rect(0, 0, 2, 2) }));
  ok('DoS: paste beyond the per-scene cap rejected (400)',
    (await gm.req('POST', `${V}/copy`, { regions: hugePaste })).status === 400);

  // TOCTOU on the region cap. Fill close to the ceiling with one paste, then
  // fire parallel single creates at the remaining slots. Per the standing
  // constraint the cap is enforced inside one SERIALIZABLE transaction, so the
  // count must land EXACTLY on the cap, never above it.
  const capScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Cap' })).data.scene;
  const C = `/api/campaigns/${victim.id}/scenes/${capScene.id}/fog`;
  const fill = Array.from({ length: 190 }, (_, i) => ({ type: 'rect', points: rect(i % 50, 0, (i % 50) + 1, 1) }));
  await gm.req('POST', `${C}/copy`, { regions: fill });
  const preload = await knex('fog_of_war').where({ scene_id: capScene.id }).count({ n: '*' }).first();
  note('cap probe preloaded', `${preload.n} regions before the race (cap is 200)`);

  const racers = Array.from({ length: 40 }, (_, i) =>
    gm.req('POST', C, { type: 'rect', points: rect(i, 100, i + 1, 101) }));
  const raceResults = await Promise.all(racers);
  const created = raceResults.filter((r) => r.status === 201).length;
  const refused = raceResults.filter((r) => r.status === 409).length;
  const finalCount = Number((await knex('fog_of_war').where({ scene_id: capScene.id }).count({ n: '*' }).first()).n);
  // Asserted EXACTLY, not as a ceiling. This is the probe that verifies
  // withAtomicCap's insert path under contention, so a ceiling would let a
  // write path that refused everything pass at 190 — the same way the canvas
  // flood probe passed on zero. 190 preloaded + 40 racers against 10 free slots
  // must land on 200 with exactly 10 accepted and 30 refused.
  ok('TOCTOU: fog region cap lands on EXACTLY 200 under 40 parallel creates',
    finalCount === 200 && created === 10 && refused === 30,
    `${finalCount} rows (cap 200), ${created} created / ${refused} refused`);
  note('cap race outcome', `${finalCount} rows after the race, ${created} created, ${refused} refused with 409`);

  // ---------- clear-all blast radius ----------
  // {all: true} must be scoped to ONE scene. If it ever reached across scenes it
  // would be a one-request wipe of an entire campaign's fog.
  const beforeOther = Number((await knex('fog_of_war').where({ scene_id: vScene2.id }).count({ n: '*' }).first()).n);
  await gm.req('POST', `${V}/batch-delete`, { all: true });
  const afterOther = Number((await knex('fog_of_war').where({ scene_id: vScene2.id }).count({ n: '*' }).first()).n);
  ok('clear-all is scoped to one scene', beforeOther === afterOther && beforeOther > 0,
    `other scene went ${beforeOther} -> ${afterOther}`);
  const afterCap = Number((await knex('fog_of_war').where({ scene_id: capScene.id }).count({ n: '*' }).first()).n);
  ok('clear-all did not reach the cap scene either', afterCap > 0, `${afterCap} rows`);

  const crossBatch = await gm.req('POST', `${V}/batch-delete`, { fog_ids: [vFog2.id] });
  ok('batch-delete cannot reach another scene\'s region',
    crossBatch.status === 200 && crossBatch.data.deleted.length === 0, JSON.stringify(crossBatch.data));
  ok('the other scene\'s region still exists', !!(await knex('fog_of_war').where({ id: vFog2.id }).first()));

  // ---------- active-scene pointer as a write primitive ----------
  const foreignActive = await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: aScene.id });
  ok('active scene cannot be pointed at another campaign -> 404', foreignActive.status === 404, `got ${foreignActive.status}`);
  const vRow = await knex('campaigns').where({ id: victim.id }).first();
  ok('victim active_scene_id unchanged by the attempt', vRow && vRow.active_scene_id === null, String(vRow && vRow.active_scene_id));

  const outsiderActive = await outsider.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: vScene.id });
  ok('outsider cannot set the victim\'s active scene -> 404', outsiderActive.status === 404, `got ${outsiderActive.status}`);

  const garbageActive = await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: 'not-a-uuid' });
  ok('malformed active scene_id -> 404, not a 500', garbageActive.status === 404, `got ${garbageActive.status}`);

  const arrayActive = await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: [vScene.id] });
  ok('array active scene_id rejected (4xx, not 500)',
    arrayActive.status >= 400 && arrayActive.status < 500, `got ${arrayActive.status}`);

  // Deleting the active scene must SET NULL, not cascade the campaign away.
  await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: vScene.id });
  await knex('scenes').where({ id: vScene.id }).del();
  const afterSceneDelete = await knex('campaigns').where({ id: victim.id }).first();
  ok('deleting the active scene clears the pointer, not the campaign',
    !!afterSceneDelete && afterSceneDelete.active_scene_id === null,
    JSON.stringify(afterSceneDelete && afterSceneDelete.active_scene_id));

  const orphanFog = await knex('fog_of_war').where({ scene_id: vScene.id });
  ok('deleted scene left no orphan fog rows', orphanFog.length === 0, `${orphanFog.length} orphans`);

  note('fog is not a confidentiality boundary',
    'scenes.img_url reaches every member, so fog geometry is sent to players by design — see the header');

  console.log('\n' + results.join('\n'));
  console.log('\n' + '='.repeat(60));
  console.log(`${pass} defended, ${fail} VULNERABLE`);
  if (findings.length) console.log('\nFINDINGS:\n' + findings.map((f) => '  - ' + f).join('\n'));
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('AUDIT CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
