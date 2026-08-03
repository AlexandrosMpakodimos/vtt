// Functional test suite for M4 (actors + token linking), run against a real
// PostgreSQL with the server running.
//   Usage: SKIP_HIBP=1 node test-actors.js
//
// Covers the session's done-criteria and their failure modes:
//   - A player creates their OWN characters (user_id and is_npc are forced
//     server-side), up to the per-campaign cap of 3.
//   - The GM authors NPCs and may assign a character to any active member.
//   - The PROJECTION: a player receives an NPC's name, portrait and size and
//     none of its statistics, while a player character is readable in full by
//     the whole table.
//   - Actors are AUTHORISED by user_id and DISCLOSED by is_npc — two orthogonal
//     rules that must not collapse into one another.
//   - tokens.actor_id, NULL for every token since M2, is finally populated: a
//     token links to a character, inherits its name/portrait/footprint, and the
//     scene load returns the characters behind the tokens it returned.
//   - Death changes nothing automatically: hp_current goes negative, is not
//     clamped to hp_max, and the owner keeps write access at 0 hp.
//   - Deleting a character SET-NULLs its tokens rather than deleting them.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}  ${detail}`); }
}
function note(name, detail) { results.push(`  NOTE  ${name}  ${detail}`); }

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
  return a;
}

function socketFor(a) {
  return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
}
const connected = (s) => new Promise((resolve, reject) => {
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 3000);
});
const emitAck = (s, event, payload) => new Promise((resolve) => {
  s.emit(event, payload, resolve);
  setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
});
function recorder(socket, events) {
  const seen = [];
  for (const ev of events) socket.on(ev, (d) => seen.push({ ev, d }));
  return seen;
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

// Every mechanical field a player must never receive for an NPC.
const STAT_FIELDS = [
  'hp_current', 'hp_max', 'hp_temp', 'armor_class', 'speed', 'level',
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'death_save_successes', 'death_save_failures', 'notes', 'data', 'class', 'race',
];

(async () => {
  const gm = await makeUser('gm');
  const player = await makeUser('pl');
  const player2 = await makeUser('pl2');
  const stranger = await makeUser('str');

  const created = await gm.req('POST', '/api/campaigns', {
    name: 'Actor Test', is_public: false, password: 'roompw',
  });
  check('campaign create', created.status === 201, JSON.stringify(created.data));
  const C = created.data.campaign.id;
  await player.req('POST', `/api/campaigns/${C}/join`, { password: 'roompw' });
  await player2.req('POST', `/api/campaigns/${C}/join`, { password: 'roompw' });

  const scene = (await gm.req('POST', `/api/campaigns/${C}/scenes`, { name: 'Hall' })).data.scene;
  const S = `/api/campaigns/${C}/scenes/${scene.id}`;
  // Players are pinned to the active scene (M3), so every player-reachable
  // token assertion below needs this scene to BE the active one.
  await gm.req('PUT', `/api/campaigns/${C}/scenes/active`, { scene_id: scene.id });

  const A = `/api/campaigns/${C}/actors`;

  // ---------- creation ----------
  // A player creates a character SHELL: name, portrait, condition, notes. `size`
  // and `hp_max` are capabilities and belong to the GM, so they are not sent —
  // sending them would now earn a 403 (see the probe below).
  const mine = await player.req('POST', A, {
    name: 'Aria', hp_current: 11, notes: 'wants revenge',
  });
  check('player creates their own character (201)', mine.status === 201, JSON.stringify(mine.data));
  check('user_id is forced to the caller', mine.data.actor.user_id === player.id);
  check('is_npc is forced false for a player', mine.data.actor.is_npc === false);
  const aria = mine.data.actor;

  // user_id and is_npc are what authorisation and disclosure are derived from,
  // so a player must not be able to supply either. Forging is_npc would let them
  // hide their own sheet from the rest of the table; forging user_id would let
  // them hand a character to somebody else — or claim one.
  const forgedOwn = await player.req('POST', A, {
    name: 'Forged', user_id: gm.id, is_npc: true, campaign_id: C,
  });
  // user_id and is_npc are SERVER-SET rather than merely unwritable: they are
  // forced regardless of what arrives, which is a stronger guarantee than
  // refusing, so they are deliberately exempt from the 403 above.
  check('player cannot forge user_id at create (forced, not refused)',
    forgedOwn.status === 201 && forgedOwn.data.actor.user_id === player.id, JSON.stringify(forgedOwn.data));
  check('player cannot forge is_npc at create (forced, not refused)', forgedOwn.data.actor.is_npc === false);
  const forgedOwnId = forgedOwn.data.actor.id;

  // RESOLVED 2026-08-02. Create now refuses GM-owned fields exactly as PATCH
  // does; it used to accept the request and discard the values, so the same body
  // earned a 403 on one path and a 201 on the other.
  const statAttempt = await player.req('POST', A, { name: 'Cheat', strength: 20, armor_class: 25, level: 12 });
  check('player create REFUSES GM-only stats (403, not a silent 201)',
    statAttempt.status === 403, JSON.stringify(statAttempt.data));
  check('and the refusal names the fields', statAttempt.data
    && typeof statAttempt.data.error === 'string'
    && statAttempt.data.error.includes('strength'), JSON.stringify(statAttempt.data));
  const cheats = await knex('actors').where({ campaign_id: C, name: 'Cheat' });
  check('the refused create wrote nothing', cheats.length === 0, `${cheats.length} rows`);
  for (const field of ['size', 'hp_max', 'class', 'race', 'speed']) {
    const r = await player.req('POST', A, { name: 'Probe', [field]: field === 'size' ? 'Large' : 5 });
    check(`player create refuses ${field} (403)`, r.status === 403, `got ${r.status}`);
  }

  // A third legitimate character, so the per-player cap section below still has
  // three to work with now that 'Cheat' is refused rather than created.
  const spare = await player.req('POST', A, { name: 'Spare', hp_current: 1 });
  check('a player may still create a plain character shell (201)', spare.status === 201, JSON.stringify(spare.data));
  const cheatId = spare.data.actor.id;

  const goblin = await gm.req('POST', A, {
    name: 'Goblin', is_npc: true, size: 'Small', hp_current: 7, hp_max: 7,
    armor_class: 15, strength: 8, notes: 'ambushes at the ford',
  });
  check('GM creates an NPC (201)', goblin.status === 201, JSON.stringify(goblin.data));
  check('NPC has no controlling user', goblin.data.actor.user_id === null);
  check('NPC size stored Title-cased', goblin.data.actor.size === 'Small');
  const gob = goblin.data.actor;

  const assigned = await gm.req('POST', A, { name: 'Brom', user_id: player2.id, hp_max: 20 });
  check('GM assigns a character to a member (201)', assigned.status === 201 && assigned.data.actor.user_id === player2.id, JSON.stringify(assigned.data));
  const brom = assigned.data.actor;

  const toStranger = await gm.req('POST', A, { name: 'Nobody', user_id: stranger.id });
  check('assigning to a non-member is rejected (400)', toStranger.status === 400, JSON.stringify(toStranger.data));

  // ---------- the projection ----------
  const gmList = await gm.req('GET', A);
  const gmGoblin = gmList.data.actors.find((a) => a.id === gob.id);
  check('GM list carries the NPC in full', gmGoblin.hp_max === 7 && gmGoblin.armor_class === 15 && gmGoblin.notes === 'ambushes at the ford');

  const plList = await player.req('GET', A);
  // V1 (found by break-actors.js L9/L10). An NPC with no token on the board is
  // not merely projected — it is not disclosed at all. The GM's prep stays the
  // GM's until they put it on the map. The projection assertions move to after
  // the goblin's token is placed, further down.
  check('an un-placed NPC does not appear in a player\'s list at all',
    !plList.data.actors.some((a) => a.id === gob.id),
    JSON.stringify(plList.data.actors.map((a) => a.name)));
  const oneNpc = await player.req('GET', `${A}/${gob.id}`);
  check('and reading it directly answers 404, not 403 (no enumeration oracle)',
    oneNpc.status === 404, `got ${oneNpc.status}`);

  const plBrom = plList.data.actors.find((a) => a.id === brom.id);
  check('a player character is readable in full by another player', plBrom && plBrom.hp_max === 20, JSON.stringify(plBrom));

  // ---------- editing ----------
  const heal = await player.req('PATCH', `${A}/${aria.id}`, { hp_current: 4, notes: 'bleeding' });
  check('player edits their own condition (200)', heal.status === 200 && heal.data.actor.hp_current === 4, JSON.stringify(heal.data));

  const cheat = await player.req('PATCH', `${A}/${aria.id}`, { strength: 20 });
  check('player cannot raise their own strength (403)', cheat.status === 403, JSON.stringify(cheat.data));
  check('the refusal names the field rather than failing silently',
    cheat.data && typeof cheat.data.error === 'string' && cheat.data.error.includes('strength'), JSON.stringify(cheat.data));
  const ariaRow = await knex('actors').where({ id: aria.id }).first();
  check('the refused edit did not land', ariaRow.strength === 10);

  for (const [field, value] of [['is_npc', true], ['user_id', null], ['hp_max', 999], ['level', 20], ['armor_class', 30]]) {
    const r = await player.req('PATCH', `${A}/${aria.id}`, { [field]: value });
    check(`player cannot change ${field} (403)`, r.status === 403, `got ${r.status}`);
  }

  const other = await player.req('PATCH', `${A}/${brom.id}`, { hp_current: 1 });
  check('player cannot edit another player\'s character (403)', other.status === 403, JSON.stringify(other.data));

  const gmEdit = await gm.req('PATCH', `${A}/${aria.id}`, { strength: 16, level: 3 });
  check('the GM may change capabilities (200)', gmEdit.status === 200 && gmEdit.data.actor.strength === 16, JSON.stringify(gmEdit.data));

  const immutable = await player.req('PATCH', `${A}/${aria.id}`, { campaign_id: C, id: aria.id });
  check('fields outside both lists are ignored, leaving nothing to update (400)', immutable.status === 400, JSON.stringify(immutable.data));

  // ---------- death is not a mechanic ----------
  const downed = await player.req('PATCH', `${A}/${aria.id}`, { hp_current: -6 });
  check('hp_current may go NEGATIVE (no clamp at zero)', downed.status === 200 && downed.data.actor.hp_current === -6, JSON.stringify(downed.data));
  const stillMine = await player.req('PATCH', `${A}/${aria.id}`, { notes: 'unconscious but still mine' });
  check('the owner keeps write access at 0 hp (authority is not derived from hp)', stillMine.status === 200);
  const overHeal = await player.req('PATCH', `${A}/${aria.id}`, { hp_current: 500 });
  check('hp_current is NOT clamped to hp_max (the server does not interpret it)',
    overHeal.status === 200 && overHeal.data.actor.hp_current === 500, JSON.stringify(overHeal.data));
  const saves = await player.req('PATCH', `${A}/${aria.id}`, { death_save_failures: 3 });
  check('three death-save failures change nothing automatically', saves.status === 200 && saves.data.actor.death_save_failures === 3);
  const afterSaves = await knex('actors').where({ id: aria.id }).first();
  check('no status column appeared and hp was untouched by the save count', afterSaves.hp_current === 500);
  const overSaves = await player.req('PATCH', `${A}/${aria.id}`, { death_save_failures: 11 });
  check('death saves are still bounded (400 past the bound)', overSaves.status === 400);

  // ---------- validation ----------
  const frac = await gm.req('PATCH', `${A}/${aria.id}`, { hp_max: 4.5 });
  check('fractional hit points rejected (400)', frac.status === 400);
  const smuggled = await gm.req('PATCH', `${A}/${aria.id}`, { strength: [[5]] });
  check('type confusion [[5]] rejected on an actor stat (400)', smuggled.status === 400, JSON.stringify(smuggled.data));
  const bigStr = await gm.req('PATCH', `${A}/${aria.id}`, { strength: 31 });
  check('out-of-range ability score rejected (400)', bigStr.status === 400);
  const badSize = await gm.req('PATCH', `${A}/${aria.id}`, { size: 'Colossal' });
  check('unknown size rejected (400)', badSize.status === 400);
  const goodData = await player.req('PATCH', `${A}/${aria.id}`, { data: { gold: 120, slots: { 1: 3 } } });
  check('the data blob accepts an object (200)', goodData.status === 200 && goodData.data.actor.data.gold === 120, JSON.stringify(goodData.data));
  const arrData = await player.req('PATCH', `${A}/${aria.id}`, { data: [1, 2, 3] });
  check('the data blob rejects an array (400)', arrData.status === 400);
  const hugeData = await player.req('PATCH', `${A}/${aria.id}`, { data: { s: 'x'.repeat(9000) } });
  check('an oversized data blob is rejected (400)', hugeData.status === 400, JSON.stringify(hugeData.data));

  // ---------- the two-payload broadcast ----------
  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  await emitAck(gmSock, 'campaign:join', { campaign_id: C });
  await emitAck(plSock, 'campaign:join', { campaign_id: C });

  const gmHeard = recorder(gmSock, ['actor:updated']);
  const plHeard = recorder(plSock, ['actor:updated']);
  await gm.req('PATCH', `${A}/${gob.id}`, { hp_current: 3 });
  await settle();
  check('the GM is told an NPC changed', gmHeard.length >= 1, `heard ${gmHeard.length}`);
  check('the GM\'s payload carries the hit points', gmHeard.some((h) => h.d.hp_current === 3), JSON.stringify(gmHeard.map((h) => h.d)));
  // V1 again, on the socket: the goblin has no token yet, so the player must
  // hear nothing at all — not a projected payload, nothing.
  check('a player hears NOTHING about an NPC that is not on the board',
    plHeard.length === 0, JSON.stringify(plHeard.map((h) => h.d)));

  // ---------- tokens become characters ----------
  const linked = await gm.req('POST', `${S}/tokens`, { actor_id: gob.id, x: 3, y: 3 });
  check('a token can be linked to an actor (201)', linked.status === 201 && linked.data.token.actor_id === gob.id, JSON.stringify(linked.data));
  check('the token inherits the character\'s name', linked.data.token.name === 'Goblin');
  check('a Small actor gives a 1x1 token', linked.data.token.width === 1 && linked.data.token.height === 1);

  const big = await gm.req('POST', A, { name: 'Ogre', is_npc: true, size: 'Large', hp_max: 59 });
  const ogreTok = await gm.req('POST', `${S}/tokens`, { actor_id: big.data.actor.id, x: 8, y: 8 });
  check('a Large actor gives a 2x2 token (size maps to the 5e presets)',
    ogreTok.data.token.width === 2 && ogreTok.data.token.height === 2, JSON.stringify(ogreTok.data.token));

  const named = await gm.req('POST', `${S}/tokens`, { actor_id: gob.id, name: 'Goblin B', x: 5, y: 3 });
  check('an explicit name still overrides the character\'s', named.data.token.name === 'Goblin B');

  const playerLink = await player.req('POST', `${S}/tokens`, { actor_id: aria.id, x: 1, y: 1 });
  check('a player may place a token for their OWN character (201)', playerLink.status === 201 && playerLink.data.token.actor_id === aria.id, JSON.stringify(playerLink.data));

  const stealNpc = await player2.req('POST', `${S}/tokens`, { actor_id: gob.id, x: 2, y: 2 });
  check('a player cannot place a token for the GM\'s NPC (404, not 403)', stealNpc.status === 404, JSON.stringify(stealNpc.data));

  // ---------- the NPC is now on the board, so the player may learn about it ----
  // Everything below was true from the moment the NPC was CREATED in the first
  // build. V1 moved the boundary: disclosure begins when a visible token of the
  // creature reaches the player, and not before.
  const plListAfter = await player.req('GET', A);
  const plGoblin = plListAfter.data.actors.find((a) => a.id === gob.id);
  check('once its token is on the board the player learns the NPC exists', !!plGoblin,
    JSON.stringify(plListAfter.data.actors.map((a) => a.name)));
  check('and receives its name and portrait', plGoblin && plGoblin.name === 'Goblin');
  check('and its size (the token footprint is visible anyway)', plGoblin && plGoblin.size === 'Small');
  const leaked = STAT_FIELDS.filter((f) => plGoblin && f in plGoblin);
  check('but still NO statistics', leaked.length === 0, `leaked: ${leaked.join(', ')}`);
  const oneNpcNow = await player.req('GET', `${A}/${gob.id}`);
  check('and the detail route now projects it identically to the list',
    oneNpcNow.status === 200 && !('hp_max' in oneNpcNow.data.actor), JSON.stringify(oneNpcNow.data));

  const gmHeard2 = recorder(gmSock, ['actor:updated']);
  const plHeard2 = recorder(plSock, ['actor:updated']);
  await gm.req('PATCH', `${A}/${gob.id}`, { hp_current: 3, armor_class: 16 });
  await settle();
  check('editing an on-board NPC DOES reach the player (its token re-renders)',
    plHeard2.length >= 1, `heard ${plHeard2.length}`);
  const plLeak2 = plHeard2.filter((h) => STAT_FIELDS.some((f) => f in h.d));
  check('and that payload still carries no statistics', plLeak2.length === 0, JSON.stringify(plLeak2.map((h) => h.d)));
  check('while the GM receives the full row', gmHeard2.some((h) => h.d.armor_class === 16), JSON.stringify(gmHeard2.map((h) => h.d)));

  // ---------- the scene load ----------
  const gmLoad = await gm.req('GET', S);
  check('the scene load returns an actors array', Array.isArray(gmLoad.data.actors), JSON.stringify(Object.keys(gmLoad.data)));
  const gmGob = gmLoad.data.actors.find((a) => a.id === gob.id);
  check('the GM\'s scene load carries the NPC\'s hit points (the bar is derived from them)',
    gmGob && gmGob.hp_current === 3 && gmGob.hp_max === 7, JSON.stringify(gmGob));

  const plLoad = await player.req('GET', S);
  const plGob = plLoad.data.actors.find((a) => a.id === gob.id);
  check('the player\'s scene load carries the NPC so the token can render', !!plGob);
  const loadLeak = STAT_FIELDS.filter((f) => plGob && f in plGob);
  check('with no statistics — so a monster token shows the player no bar at all',
    loadLeak.length === 0, `leaked: ${loadLeak.join(', ')}`);
  const plAria = plLoad.data.actors.find((a) => a.id === aria.id);
  check('their own character arrives in full (their bar renders)', plAria && plAria.hp_max !== undefined);

  // A hidden token's actor must not reach the player either — the actors array
  // is built from the ALREADY-FILTERED token list, so this falls out rather than
  // needing a second rule.
  const secretActor = (await gm.req('POST', A, { name: 'Lurker', is_npc: true, hp_max: 40 })).data.actor;
  await gm.req('POST', `${S}/tokens`, { actor_id: secretActor.id, x: 9, y: 9, hidden: true });
  const plLoad2 = await player.req('GET', S);
  check('the actor behind a HIDDEN token never reaches the player at all',
    !plLoad2.data.actors.some((a) => a.id === secretActor.id), JSON.stringify(plLoad2.data.actors.map((a) => a.name)));
  const gmLoad2 = await gm.req('GET', S);
  check('while the GM receives it', gmLoad2.data.actors.some((a) => a.id === secretActor.id));

  // ---------- unlinking ----------
  const tokenId = linked.data.token.id;
  const del = await gm.req('DELETE', `${A}/${gob.id}`);
  check('the GM deletes a character (200)', del.status === 200, JSON.stringify(del.data));
  check('the response reports how many tokens it unlinked', del.data.tokens_unlinked === 2, JSON.stringify(del.data));
  const survivor = await knex('tokens').where({ id: tokenId }).first();
  check('the token SURVIVES the deletion (ON DELETE SET NULL, not CASCADE)', !!survivor, 'token was deleted with the actor');
  check('and is left on the board as an unlinked marker', survivor && survivor.actor_id === null);

  // ---------- the per-player cap ----------
  // The player already holds Aria + Forged + Cheat = 3, the cap.
  const fourth = await player.req('POST', A, { name: 'One Too Many' });
  check('a player is capped at 3 characters per campaign (409)', fourth.status === 409, JSON.stringify(fourth.data));
  const mineCount = await knex('actors').where({ campaign_id: C, user_id: player.id }).count({ n: '*' }).first();
  check('and holds exactly 3', Number(mineCount.n) === 3, `${mineCount.n} rows`);
  await player.req('DELETE', `${A}/${cheatId}`);
  const afterFree = await player.req('POST', A, { name: 'Replacement' });
  check('deleting one frees a slot — a dead character can be replaced', afterFree.status === 201, JSON.stringify(afterFree.data));
  await player.req('DELETE', `${A}/${forgedOwnId}`);

  // ---------- outsiders ----------
  for (const [label, call] of [
    ['list actors', () => stranger.req('GET', A)],
    ['read one actor', () => stranger.req('GET', `${A}/${aria.id}`)],
    ['create an actor', () => stranger.req('POST', A, { name: 'Intruder' })],
    ['edit an actor', () => stranger.req('PATCH', `${A}/${aria.id}`, { hp_current: 0 })],
    ['delete an actor', () => stranger.req('DELETE', `${A}/${aria.id}`)],
  ]) {
    const r = await call();
    check(`a non-member cannot ${label} -> 404 (no existence leak)`, r.status === 404, `got ${r.status}`);
  }
  const stillThere = await knex('actors').where({ id: aria.id }).first();
  check('the character survived every outsider attempt', !!stillThere);

  const malformed = await gm.req('GET', `${A}/not-a-uuid`);
  check('malformed uuid -> 404, not a 500', malformed.status === 404, `got ${malformed.status}`);

  note('create/PATCH asymmetry',
    'RESOLVED 2026-08-02 — create now refuses GM-owned fields with a 403 exactly as PATCH does. user_id and is_npc stay server-SET rather than refused, because forcing is a stronger guarantee than rejecting.');

  gmSock.close(); plSock.close();
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
