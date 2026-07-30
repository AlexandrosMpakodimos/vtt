// Scene deletion: the cascade, the active-scene fallout, and who may do it.
//   SKIP_HIBP=1 node test-scene-delete.js
//
// Functional and adversarial assertions share one file, for the same reason
// test-active-scene.js does: this is an authorisation rule wrapped around a
// destructive cascade, so "does it work" and "can it be abused" are the same
// question asked from two sides.
//
// What is being pinned down:
//   - DELETE is GM-only; a player gets 403 and a non-member 404 (no existence leak).
//   - The cascade actually fires: tokens AND fog_of_war rows go with the scene,
//     and nothing belonging to a NEIGHBOURING scene is touched.
//   - The reported counts are true — the harness puts them in the confirmation
//     prompt, so a wrong count is a user lied to before an irreversible action.
//   - Deleting the ACTIVE scene clears campaigns.active_scene_id (the FK does
//     this on its own) AND tells the room, which the FK cannot do.
//   - scene:deleted reaches the GM only: a player must not learn the id of a
//     scene they were never allowed to open.

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
function recorder(socket, events) {
  const seen = [];
  for (const ev of events) socket.on(ev, (d) => seen.push({ ev, d }));
  return seen;
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const rect = (a, b, c, d) => [{ x: a, y: b }, { x: c, y: d }];

(async () => {
  const gm = await mk('gm'), player = await mk('pl'), outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Deletion', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const S = `/api/campaigns/${camp.id}/scenes`;

  const doomed = (await gm.req('POST', S, { name: 'Doomed' })).data.scene;
  const keeper = (await gm.req('POST', S, { name: 'Keeper' })).data.scene;

  // Populate BOTH scenes, so the cascade can be shown to be surgical.
  for (let i = 0; i < 3; i += 1) await gm.req('POST', `${S}/${doomed.id}/tokens`, { name: `d${i}`, x: i, y: 1 });
  for (let i = 0; i < 2; i += 1) await gm.req('POST', `${S}/${doomed.id}/fog`, { type: 'rect', points: rect(i, 0, i + 1, 2) });
  await gm.req('POST', `${S}/${keeper.id}/tokens`, { name: 'k0', x: 0, y: 0 });
  await gm.req('POST', `${S}/${keeper.id}/fog`, { type: 'rect', points: rect(0, 0, 2, 2) });

  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  await emitAck(gmSock, 'campaign:join', { campaign_id: camp.id });
  await emitAck(plSock, 'campaign:join', { campaign_id: camp.id });

  // ---- who may not ----
  const pDel = await player.req('DELETE', `${S}/${doomed.id}`);
  check('a player cannot delete a scene (403)', pDel.status === 403, `got ${pDel.status}`);
  const oDel = await outsider.req('DELETE', `${S}/${doomed.id}`);
  check('a non-member cannot delete a scene -> 404 (no existence leak)', oDel.status === 404, `got ${oDel.status}`);
  check('the scene survived both attempts', !!(await knex('scenes').where({ id: doomed.id }).first()));

  // cross-campaign: a GM may only delete inside their own campaign
  const theirs = (await outsider.req('POST', '/api/campaigns', { name: 'Theirs', is_public: true })).data.campaign;
  const theirScene = (await outsider.req('POST', `/api/campaigns/${theirs.id}/scenes`, { name: 'Foreign' })).data.scene;
  const crossDel = await gm.req('DELETE', `${S}/${theirScene.id}`);
  check('a GM cannot delete another campaign\'s scene -> 404 (IDOR blocked)', crossDel.status === 404, `got ${crossDel.status}`);
  check('the foreign scene survived', !!(await knex('scenes').where({ id: theirScene.id }).first()));

  const bad = await gm.req('DELETE', `${S}/not-a-uuid`);
  check('malformed uuid -> 404, not a 500', bad.status === 404, `got ${bad.status}`);

  // ---- the delete itself, while the scene is NOT active ----
  const gmHeard = recorder(gmSock, ['scene:deleted']);
  const plHeard = recorder(plSock, ['scene:deleted', 'scene:activated']);

  const del = await gm.req('DELETE', `${S}/${doomed.id}`);
  check('GM deletes a scene (200)', del.status === 200, JSON.stringify(del.data));
  check('the response reports the token count it destroyed',
    del.data.deleted && del.data.deleted.tokens === 3, JSON.stringify(del.data.deleted));
  check('the response reports the fog count it destroyed',
    del.data.deleted && del.data.deleted.fog === 2, JSON.stringify(del.data.deleted));
  check('was_active is false for a non-active scene', del.data.was_active === false, String(del.data.was_active));

  check('the scene row is gone', !(await knex('scenes').where({ id: doomed.id }).first()));
  check('its tokens cascaded away', (await knex('tokens').where({ scene_id: doomed.id })).length === 0);
  check('its fog cascaded away', (await knex('fog_of_war').where({ scene_id: doomed.id })).length === 0);

  // Surgical: the neighbouring scene is untouched.
  check('the other scene survived', !!(await knex('scenes').where({ id: keeper.id }).first()));
  check('the other scene kept its token', (await knex('tokens').where({ scene_id: keeper.id })).length === 1);
  check('the other scene kept its fog', (await knex('fog_of_war').where({ scene_id: keeper.id })).length === 1);

  const gone = await gm.req('GET', `${S}/${doomed.id}`);
  check('the deleted scene 404s afterwards', gone.status === 404, `got ${gone.status}`);
  const twice = await gm.req('DELETE', `${S}/${doomed.id}`);
  check('deleting it a second time -> 404', twice.status === 404, `got ${twice.status}`);
  const list = await gm.req('GET', S);
  check('it is gone from the GM\'s list', list.data.scenes.length === 1 && list.data.scenes[0].id === keeper.id,
    JSON.stringify(list.data.scenes.map((x) => x.name)));

  await settle();
  check('the GM is told the scene was deleted', gmHeard.length === 1, JSON.stringify(gmHeard));
  check('the player is NOT told about a scene they could not open',
    plHeard.length === 0, JSON.stringify(plHeard));

  // ---- deleting the ACTIVE scene ----
  await gm.req('PUT', `${S}/active`, { scene_id: keeper.id });
  const active = await knex('campaigns').where({ id: camp.id }).first();
  check('the keeper is now active', active.active_scene_id === keeper.id);

  const plHeard2 = recorder(plSock, ['scene:activated']);
  const delActive = await gm.req('DELETE', `${S}/${keeper.id}`);
  check('GM deletes the ACTIVE scene (200)', delActive.status === 200, JSON.stringify(delActive.data));
  check('the response flags it as active', delActive.data.was_active === true, String(delActive.data.was_active));

  const cleared = await knex('campaigns').where({ id: camp.id }).first();
  check('active_scene_id was cleared by the FK (ON DELETE SET NULL)',
    cleared.active_scene_id === null, String(cleared.active_scene_id));
  check('the campaign itself survived (SET NULL, not CASCADE)', !!cleared && !cleared.deleted_at);

  await settle();
  // The FK cannot notify anybody, which is the whole reason this broadcast exists.
  check('the room is told the active scene is gone',
    plHeard2.length === 1 && plHeard2[0].d.scene_id === null, JSON.stringify(plHeard2));

  const pAfter = await player.req('GET', S);
  check('the player now sees no scenes at all', pAfter.data.scenes.length === 0, JSON.stringify(pAfter.data));
  const pReopen = await player.req('GET', `${S}/${keeper.id}`);
  check('and cannot reopen the deleted scene -> 404', pReopen.status === 404, `got ${pReopen.status}`);

  const orphanTokens = await knex('tokens').where({ scene_id: keeper.id });
  const orphanFog = await knex('fog_of_war').where({ scene_id: keeper.id });
  check('no orphan tokens left behind', orphanTokens.length === 0, `${orphanTokens.length}`);
  check('no orphan fog left behind', orphanFog.length === 0, `${orphanFog.length}`);

  // ---- the cap is reclaimable, which was the point ----
  const remade = await gm.req('POST', S, { name: 'Rebuilt' });
  check('a scene can be created again after deleting one (cap reclaimable)',
    remade.status === 201, `got ${remade.status}`);

  gmSock.close(); plSock.close();
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch {}
  process.exit(1);
});
