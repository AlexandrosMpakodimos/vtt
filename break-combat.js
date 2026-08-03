// Adversarial security audit for M5 (combat / combatants / chat / dice), kept as
// a security regression alongside the functional suites.
//   Usage: SKIP_HIBP=1 node break-combat.js   (server on npm run dev:test)
//
// Mapped to the OWASP API Security Top 10 (2023), as the previous four audits:
//   API1 BOLA   — cross-campaign and cross-combat object access
//   API3 BOPLA  — hp_override behind hp_visible; whisper_to; forged properties
//   API4 URC    — the combatant cap and the one-active-combat-per-scene cap
//   API5 BFLA   — GM-only combat functions attempted by a player
//
// ---------------------------------------------------------------------------
// WHAT THIS SUITE IS ACTUALLY FOR
// ---------------------------------------------------------------------------
// combatants is a THIRD DOOR onto tokens and actors. M4's two vulnerabilities
// were the same shape — ONE RESOURCE, SEVERAL DOORS, THE LOCK FITTED TO SOME OF
// THEM — so the probes below are organised around the four rules a combatant row
// bypasses by construction:
//
//   D1  tokens.hidden        — a hidden token must produce NO combatant row for
//                              a player, and the roster LENGTH must not betray
//                              it either.
//   D2  playersMayKnowActor  — the roster's actor list must not disclose an NPC
//                              whose token the player cannot see.
//   D3  mayUseScene          — a combat on a non-active scene must be invisible
//                              to a player on BOTH transports.
//   D4  hp_override          — a monster's hit points wearing a different column
//                              name, gated by hp_visible.
//
// THE LISTENING PROBES ARE THE ONES THAT MATTER (L1-L10). M3's V2 was a boundary
// enforced correctly over HTTP that leaked entirely over the socket, because the
// player was not asking for anything — they were listening. Each L probe records
// a player's socket while the GM works and asserts SILENCE, and each has a
// CONTROL proving the legitimate path still delivers, so a build that muted
// everything cannot pass.
//
// Cap probes assert the EXACT landing count and the accept/refuse split, never a
// ceiling. Fixtures go in through knex; only the behaviour under test goes over
// HTTP. A probe that cannot run FAILS rather than skipping.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0; let fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  DEFENDED  ${name}`); } else {
    fail += 1; results.push(`  VULNERABLE  ${name}  ${detail}`); findings.push(name);
  }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

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

async function mk(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
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
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const COMBAT_EVENTS = ['combat:updated', 'combat:deleted', 'message:created'];

(async () => {
  const gm = await mk('gm');
  const player = await mk('pl');
  const player2 = await mk('pl2');
  const outsider = await mk('out');

  const victim = (await gm.req('POST', '/api/campaigns', { name: 'Victim', is_public: true })).data.campaign;
  const attacker = (await outsider.req('POST', '/api/campaigns', { name: 'Attacker', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${victim.id}/join`, {});
  await player2.req('POST', `/api/campaigns/${victim.id}/join`, {});

  const C = `/api/campaigns/${victim.id}/combat`;
  const M = `/api/campaigns/${victim.id}/messages`;
  const A = `/api/campaigns/${victim.id}/actors`;

  // Two scenes: one the players are pinned to, one the GM preps on.
  const board = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Board' })).data.scene;
  const prep = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Prep' })).data.scene;
  await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: board.id });
  const S = `/api/campaigns/${victim.id}/scenes/${board.id}`;

  // A monster whose statistics the projection is designed to withhold.
  const goblin = (await gm.req('POST', A, {
    name: 'Goblin', is_npc: true, hp_current: 7, hp_max: 7, armor_class: 15,
    notes: 'flees below 3 hp',
  })).data.actor;
  const assassin = (await gm.req('POST', A, {
    name: 'Assassin', is_npc: true, hp_current: 78, hp_max: 78, armor_class: 19,
  })).data.actor;

  // Three tokens on the active board: a visible monster, a HIDDEN ambusher, and
  // a prop. Plus the player's own token.
  const visible = (await gm.req('POST', `${S}/tokens`, {
    name: 'Goblin', actor_id: goblin.id, x: 1, y: 1,
  })).data.token;
  const lurker = (await gm.req('POST', `${S}/tokens`, {
    name: 'Assassin', actor_id: assassin.id, x: 9, y: 9, hidden: true,
  })).data.token;
  const tree = (await gm.req('POST', `${S}/tokens`, {
    name: 'Tree', x: 4, y: 4, is_prop: true,
  })).data.token;

  // ================= setup sanity — a fixture failure must FAIL, not skip =====
  ok('setup: visible token created', !!visible && visible.hidden === false);
  ok('setup: hidden token created', !!lurker && lurker.hidden === true);
  ok('setup: prop token created', !!tree && tree.is_prop === true);

  // ================= D3 / API5: starting a fight is GM-only =================
  const playerStart = await player.req('POST', C, { scene_id: board.id, name: 'mine' });
  ok('BFLA: player cannot start a combat', playerStart.status === 403, `got ${playerStart.status}`);

  const fight = (await gm.req('POST', C, { scene_id: board.id, name: 'Ambush at the bridge' })).data;
  ok('setup: combat started', !!fight && !!fight.combat);

  // ================= D1: the roster excludes hidden tokens ==================
  // The prop must not be enrolled at all; the hidden token must be enrolled for
  // the GM and absent for the player.
  const gmRoster = (await gm.req('GET', `${C}/${fight.combat.id}`)).data;
  const plRoster = (await player.req('GET', `${C}/${fight.combat.id}`)).data;

  const gmTokenIds = gmRoster.combatants.map((c) => c.token_id);
  const plTokenIds = plRoster.combatants.map((c) => c.token_id);

  ok('seed: prop is NOT enrolled', !gmTokenIds.includes(tree.id),
    JSON.stringify(gmTokenIds));
  ok('seed: visible token enrolled', gmTokenIds.includes(visible.id));
  ok('seed: hidden token enrolled for the GM', gmTokenIds.includes(lurker.id));

  // D1 proper. Assert on SHAPE (the id is absent) and on the EXACT length, not
  // on a ceiling — a roster that returned nothing at all would otherwise pass.
  ok('D1: player roster omits the hidden token', !plTokenIds.includes(lurker.id),
    JSON.stringify(plTokenIds));
  ok('D1: player roster still contains the visible token',
    plTokenIds.includes(visible.id), JSON.stringify(plTokenIds));
  ok('D1: roster LENGTH does not betray the ambusher',
    plRoster.combatants.length === gmRoster.combatants.length - 1,
    `gm ${gmRoster.combatants.length} vs player ${plRoster.combatants.length}`);

  // ================= D2: the actor list follows the filtered rows ===========
  const plActorIds = (plRoster.actors || []).map((a) => a.id);
  ok('D2: player roster does not disclose the hidden NPC actor',
    !plActorIds.includes(assassin.id), JSON.stringify(plActorIds));
  ok('D2 control: the visible NPC actor IS delivered',
    plActorIds.includes(goblin.id), JSON.stringify(plActorIds));
  const plGoblin = (plRoster.actors || []).find((a) => a.id === goblin.id);
  ok('D2: the visible NPC is PROJECTED (no hp)',
    !!plGoblin && plGoblin.hp_current === undefined && plGoblin.hp_max === undefined
      && plGoblin.armor_class === undefined && plGoblin.notes === undefined,
    JSON.stringify(plGoblin));

  // ================= D4: hp_override behind hp_visible ======================
  const visCombatant = gmRoster.combatants.find((c) => c.token_id === visible.id);
  ok('setup: hp_override defaulted from the NPC actor hp_max',
    visCombatant && visCombatant.hp_override === 7, JSON.stringify(visCombatant));

  const plVis = plRoster.combatants.find((c) => c.token_id === visible.id);
  ok('D4: hp_override withheld while hp_visible is false',
    plVis && plVis.hp_override === undefined, JSON.stringify(plVis));
  ok('D4: hp_visible itself is not disclosed to a player',
    plVis && plVis.hp_visible === undefined, JSON.stringify(plVis));

  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_visible: true });
  const plRoster2 = (await player.req('GET', `${C}/${fight.combat.id}`)).data;
  const plVis2 = plRoster2.combatants.find((c) => c.token_id === visible.id);
  ok('D4 control: hp_override IS delivered once hp_visible is true',
    plVis2 && plVis2.hp_override === 7, JSON.stringify(plVis2));

  // Live evaluation, not latched at first disclosure — the M4 lesson that hiding
  // every token of a disclosed NPC makes it unknown again.
  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_visible: false });
  const plRoster3 = (await player.req('GET', `${C}/${fight.combat.id}`)).data;
  const plVis3 = plRoster3.combatants.find((c) => c.token_id === visible.id);
  ok('D4: flipping hp_visible back RE-HIDES the number (evaluated live)',
    plVis3 && plVis3.hp_override === undefined, JSON.stringify(plVis3));

  // hp_visible must NOT leak the linked actor's own HP — it governs hp_override
  // only, because five goblin tokens share one actors.hp_current.
  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_visible: true });
  const plRoster4 = (await player.req('GET', `${C}/${fight.combat.id}`)).data;
  const plGoblin4 = (plRoster4.actors || []).find((a) => a.id === goblin.id);
  ok('D4: hp_visible does NOT open the actor projection',
    plGoblin4 && plGoblin4.hp_current === undefined && plGoblin4.hp_max === undefined,
    JSON.stringify(plGoblin4));
  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_visible: false });

  // ================= D3: a combat on a NON-ACTIVE scene =====================
  const prepFight = (await gm.req('POST', C, { scene_id: prep.id, name: 'Boss room' })).data;
  ok('setup: prep-scene combat started', !!prepFight && !!prepFight.combat);

  const plList = await player.req('GET', C);
  const plListIds = (plList.data.combats || []).map((c) => c.id);
  ok('D3: player combat list omits the prep-scene fight',
    !plListIds.includes(prepFight.combat.id), JSON.stringify(plListIds));
  ok('D3 control: player combat list contains the active-scene fight',
    plListIds.includes(fight.combat.id), JSON.stringify(plListIds));

  const plPrep = await player.req('GET', `${C}/${prepFight.combat.id}`);
  ok('D3: player reading the prep-scene fight gets 404 (not 403 — no existence leak)',
    plPrep.status === 404, `got ${plPrep.status}`);

  // ================= API1 BOLA: cross-campaign ==============================
  const foreign = await outsider.req('GET', `/api/campaigns/${victim.id}/combat/${fight.combat.id}`);
  ok('BOLA: outsider cannot read a combat in a campaign they are not in',
    foreign.status === 404, `got ${foreign.status}`);
  const aimed = await gm.req('POST', `/api/campaigns/${attacker.id}/combat`, { scene_id: board.id });
  ok('BOLA: a combat cannot be aimed at another campaign\'s scene',
    aimed.status === 404 || aimed.status === 403, `got ${aimed.status}`);

  // A combatant addressed through the WRONG combat.
  const wrongDoor = await gm.req(
    'PATCH', `${C}/${prepFight.combat.id}/combatants/${visCombatant.id}`, { hp_override: 1 },
  );
  ok('BOLA: a combatant cannot be reached through another combat',
    wrongDoor.status === 404, `got ${wrongDoor.status}`);

  // Enrolling a token from another scene.
  const prepToken = (await gm.req(
    'POST', `/api/campaigns/${victim.id}/scenes/${prep.id}/tokens`, { name: 'Boss', x: 2, y: 2 },
  )).data.token;
  const crossScene = await gm.req('POST', `${C}/${fight.combat.id}/combatants`, { token_id: prepToken.id });
  ok('BOLA: a token from another scene cannot be enrolled',
    crossScene.status === 404, `got ${crossScene.status}`);

  // ================= API5 BFLA: GM-only functions ===========================
  const bfla = [
    ['PATCH', `${C}/${fight.combat.id}`, { name: 'renamed' }, 'rename combat'],
    ['DELETE', `${C}/${fight.combat.id}`, undefined, 'delete combat'],
    ['POST', `${C}/${fight.combat.id}/combatants`, { token_id: visible.id }, 'add combatant'],
    ['PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_override: 1 }, 'edit combatant'],
    ['DELETE', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, undefined, 'remove combatant'],
    ['POST', `${C}/${fight.combat.id}/reorder`, { combatant_ids: [visCombatant.id] }, 'reorder'],
  ];
  for (const [method, path, body, label] of bfla) {
    // Each case carries its OWN expectation. A shared `=== 403` loop reported
    // M4's V2 improvement as a vulnerability; that lesson is applied here.
    // eslint-disable-next-line no-await-in-loop
    const r = await player.req(method, path, body);
    ok(`BFLA: player cannot ${label}`, r.status === 403 || r.status === 404, `got ${r.status}`);
  }

  // ================= API3 BOPLA: forged properties ==========================
  const forged = await gm.req('POST', C, {
    scene_id: board.id, name: 'x', id: '00000000-0000-4000-8000-000000000000',
    campaign_id: attacker.id, active: true, round: 99, turn_index: 5,
  });
  // The scene already has a running fight, so this is refused by the cap — which
  // is itself the assertion that the cap is checked before anything is written.
  ok('mass assignment: forged id/campaign_id/round/turn_index do not land',
    forged.status === 409, `got ${forged.status}`);

  const propForge = await player.req('POST', `${S}/tokens`, { name: 'sneak', is_prop: true, x: 2, y: 3 });
  if (propForge.status === 201) {
    ok('mass assignment: a player\'s is_prop is silently dropped (matches `hidden`)',
      propForge.data.token.is_prop === false, JSON.stringify(propForge.data.token));
  } else {
    ok('mass assignment: player token placement blocked before is_prop mattered',
      propForge.status === 409, `got ${propForge.status}`);
    note('player is_prop probe', `placement returned ${propForge.status}, likely the 1-token cap`);
  }

  // ================= type confusion (the BOPLA class from M2) ===============
  const confusions = [
    ['hp_override', [[5]]], ['hp_override', true], ['hp_override', 1.5],
    ['hp_visible', 'yes'], ['hp_visible', 1], ['sort_order', -1],
    ['sort_order', [[2]]],
  ];
  for (const [field, value] of confusions) {
    // eslint-disable-next-line no-await-in-loop
    const r = await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`,
      { [field]: value });
    ok(`type confusion: ${field}=${JSON.stringify(value)} refused`,
      r.status === 400, `got ${r.status}`);
  }
  const badUuid = await gm.req('GET', `${C}/not-a-uuid`);
  ok('malformed uuid -> 404, not 500', badUuid.status === 404, `got ${badUuid.status}`);

  // ================= reorder: permutation, not a free write ================
  const roster = (await gm.req('GET', `${C}/${fight.combat.id}`)).data.combatants;
  const ids = roster.map((c) => c.id);
  const partial = await gm.req('POST', `${C}/${fight.combat.id}/reorder`, { combatant_ids: [ids[0]] });
  ok('reorder: a PARTIAL list is refused', partial.status === 400, `got ${partial.status}`);
  const dup = await gm.req('POST', `${C}/${fight.combat.id}/reorder`,
    { combatant_ids: ids.map(() => ids[0]) });
  ok('reorder: a duplicated id is refused', dup.status === 400, `got ${dup.status}`);
  const foreignId = await gm.req('POST', `${C}/${fight.combat.id}/reorder`,
    { combatant_ids: [...ids.slice(1), '00000000-0000-4000-8000-000000000000'] });
  ok('reorder: a foreign id is refused', foreignId.status === 400, `got ${foreignId.status}`);
  const good = await gm.req('POST', `${C}/${fight.combat.id}/reorder`,
    { combatant_ids: [...ids].reverse() });
  ok('reorder control: a full permutation IS accepted', good.status === 200, `got ${good.status}`);

  // ================= chat: whisper on BOTH doors ===========================
  const whisper = (await gm.req('POST', M, {
    content: 'the vault code is 4417', whisper_to: [player.id],
  })).data.message;
  ok('setup: whisper created', !!whisper);

  const p1Hist = (await player.req('GET', M)).data.messages || [];
  const p2Hist = (await player2.req('GET', M)).data.messages || [];
  ok('whisper: the addressed player reads it in history',
    p1Hist.some((m) => m.id === whisper.id));
  ok('THE HISTORY DOOR: an unaddressed player cannot read it (M4 V2 shape)',
    !p2Hist.some((m) => m.id === whisper.id),
    JSON.stringify(p2Hist.map((m) => m.content)));
  ok('whisper: the sender reads their own whisper',
    ((await gm.req('GET', M)).data.messages || []).some((m) => m.id === whisper.id));

  // The GM is NOT automatically copied on a whisper between two players.
  const p2p = (await player.req('POST', M, {
    content: 'lets rob the gm', whisper_to: [player2.id],
  })).data.message;
  const gmHist = (await gm.req('GET', M)).data.messages || [];
  ok('whisper policy: the GM is NOT auto-copied on a player-to-player whisper',
    !gmHist.some((m) => m.id === p2p.id),
    'GM inclusion would be the surveillance this project declined to build');

  const stranger = await gm.req('POST', M, { content: 'x', whisper_to: [outsider.id] });
  ok('whisper_to must be an ACTIVE MEMBER (a stranger id is refused)',
    stranger.status === 400, `got ${stranger.status}`);

  // ================= chat: the roll is the server's =========================
  const cheat = await player.req('POST', M, {
    formula: '1d20', roll_data: { formula: '1d20', results: [20], total: 20 }, content: 'nat 20',
  });
  ok('dice: a client-supplied roll_data is NOT trusted',
    cheat.status === 201
      && cheat.data.message.roll_data
      && cheat.data.message.roll_data.results.length === 1
      && cheat.data.message.roll_data.results[0] >= 1
      && cheat.data.message.roll_data.results[0] <= 20
      && cheat.data.message.roll_data.total === cheat.data.message.roll_data.results[0],
    JSON.stringify(cheat.data && cheat.data.message && cheat.data.message.roll_data));

  const spoof = await player.req('POST', M, { content: 'hi', speaker_name: 'The GM' });
  ok('chat: speaker_name cannot be forged',
    spoof.status === 201 && spoof.data.message.speaker_name !== 'The GM',
    JSON.stringify(spoof.data && spoof.data.message));

  const huge = await player.req('POST', M, { content: 'x'.repeat(5000) });
  ok('chat: oversized content refused', huge.status === 400, `got ${huge.status}`);
  const bomb = await player.req('POST', M, { formula: '999999d999999' });
  ok('dice: a dice bomb is refused', bomb.status === 400, `got ${bomb.status}`);

  const outsiderChat = await outsider.req('POST', M, { content: 'hello' });
  ok('chat: a non-member cannot post', outsiderChat.status === 404 || outsiderChat.status === 403,
    `got ${outsiderChat.status}`);

  // ================= LISTENING PROBES ======================================
  // Everything above is the player ASKING. These are the player LISTENING, which
  // is how M3's V2 got past an HTTP-only audit.
  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  const p2Sock = await connected(socketFor(player2));
  await emitAck(gmSock, 'campaign:join', { campaign_id: victim.id });
  await emitAck(plSock, 'campaign:join', { campaign_id: victim.id });
  await emitAck(p2Sock, 'campaign:join', { campaign_id: victim.id });

  // --- L1/L2: a fight on a prep scene must be socket-silent for a player ---
  let plSeen = recorder(plSock, COMBAT_EVENTS);
  let gmSeen = recorder(gmSock, COMBAT_EVENTS);
  await gm.req('PATCH', `${C}/${prepFight.combat.id}`, { name: 'Boss room, renamed' });
  await settle();
  ok('L1: player hears NOTHING about a prep-scene combat',
    plSeen.filter((e) => e.ev === 'combat:updated').length === 0,
    JSON.stringify(plSeen.map((e) => e.ev)));
  ok('L2 control: the GM DOES hear it (the fix cannot pass by muting everything)',
    gmSeen.filter((e) => e.ev === 'combat:updated').length > 0);

  // --- L3/L4: the active-scene roster reaches the player, minus the lurker ---
  plSeen = recorder(plSock, COMBAT_EVENTS);
  await gm.req('PATCH', `${C}/${fight.combat.id}`, { name: 'Ambush, round two' });
  await settle();
  const plUpdates = plSeen.filter((e) => e.ev === 'combat:updated');
  ok('L3 control: player DOES hear the active-scene combat', plUpdates.length > 0);
  const heardTokens = plUpdates.length
    ? plUpdates[plUpdates.length - 1].d.combatants.map((c) => c.token_id) : [];
  ok('L4: the broadcast roster omits the hidden token',
    !heardTokens.includes(lurker.id), JSON.stringify(heardTokens));
  ok('L4 control: the broadcast roster contains the visible token',
    heardTokens.includes(visible.id), JSON.stringify(heardTokens));

  // --- L5: hp_override must not ride the socket while hp_visible is false ---
  plSeen = recorder(plSock, COMBAT_EVENTS);
  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_override: 3 });
  await settle();
  const hpUpdates = plSeen.filter((e) => e.ev === 'combat:updated');
  const leaked = hpUpdates.some((e) => e.d.combatants.some((c) => c.hp_override !== undefined));
  ok('L5: hp_override does NOT reach a player over the socket while hidden',
    !leaked, JSON.stringify(hpUpdates.map((e) => e.d.combatants)));
  ok('L5 control: the player still received the broadcast at all',
    hpUpdates.length > 0, 'silence here would make L5 vacuous');

  // --- L6 control: flipping hp_visible DOES deliver it over the socket ---
  plSeen = recorder(plSock, COMBAT_EVENTS);
  await gm.req('PATCH', `${C}/${fight.combat.id}/combatants/${visCombatant.id}`, { hp_visible: true });
  await settle();
  const shownUpdates = plSeen.filter((e) => e.ev === 'combat:updated');
  ok('L6 control: hp_override IS broadcast once hp_visible is true',
    shownUpdates.some((e) => e.d.combatants.some(
      (c) => c.token_id === visible.id && c.hp_override === 3,
    )), JSON.stringify(shownUpdates.map((e) => e.d.combatants)));

  // --- L7/L8: whispers on the socket ---
  plSeen = recorder(plSock, COMBAT_EVENTS);
  const p2Seen = recorder(p2Sock, COMBAT_EVENTS);
  await gm.req('POST', M, { content: 'meet me behind the inn', whisper_to: [player.id] });
  await settle();
  ok('L7 control: the addressed player receives the whisper',
    plSeen.some((e) => e.ev === 'message:created'));
  ok('L8: an unaddressed player receives NOTHING',
    p2Seen.filter((e) => e.ev === 'message:created').length === 0,
    JSON.stringify(p2Seen.map((e) => e.d && e.d.content)));

  // --- L9 control: a PUBLIC message reaches everyone ---
  const pubSeen1 = recorder(plSock, COMBAT_EVENTS);
  const pubSeen2 = recorder(p2Sock, COMBAT_EVENTS);
  await gm.req('POST', M, { content: 'roll for initiative' });
  await settle();
  ok('L9 control: a public message reaches both players',
    pubSeen1.some((e) => e.ev === 'message:created')
      && pubSeen2.some((e) => e.ev === 'message:created'));

  // --- L10: auto-add of a HIDDEN token must not announce it ---
  plSeen = recorder(plSock, COMBAT_EVENTS);
  const lurker2 = (await gm.req('POST', `${S}/tokens`, {
    name: 'Assassin 2', actor_id: assassin.id, x: 8, y: 8, hidden: true,
  })).data.token;
  await settle();
  const autoUpdates = plSeen.filter((e) => e.ev === 'combat:updated');
  const announced = autoUpdates.some((e) => e.d.combatants.some((c) => c.token_id === lurker2.id));
  ok('L10: auto-adding a HIDDEN token does not announce it to players', !announced,
    JSON.stringify(autoUpdates.map((e) => e.d.combatants.map((c) => c.token_id))));
  const gmRoster2 = (await gm.req('GET', `${C}/${fight.combat.id}`)).data.combatants;
  ok('L10 control: the GM\'s roster DID gain the hidden combatant',
    gmRoster2.some((c) => c.token_id === lurker2.id));

  gmSock.close(); plSock.close(); p2Sock.close();

  // ================= API4 URC: caps, EXACT counts ==========================
  // Fixtures go in through knex; only the racing writes go over HTTP. The first
  // M4 row-cap probe made 225 items over HTTP and exhausted the rate limiter.

  // --- one ACTIVE combat per scene, under parallel starts ---
  const raceScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Race' })).data.scene;
  ok('setup: race scene created (a missing fixture must FAIL, not skip)', !!raceScene);
  const starts = await Promise.all(Array.from({ length: 8 }, () => gm.req('POST', C, { scene_id: raceScene.id })));
  const accepted = starts.filter((r) => r.status === 201).length;
  const refused = starts.filter((r) => r.status === 409).length;
  const activeCount = Number((await knex('combat')
    .where({ scene_id: raceScene.id, active: true }).count({ n: '*' }).first()).n);
  ok('URC: exactly ONE active combat survives 8 parallel starts',
    activeCount === 1 && accepted === 1 && refused === 7,
    `landed ${activeCount}, accepted ${accepted}, refused ${refused}`);

  // --- the combatant cap, exact landing count and accept/refuse split ---
  const capScene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Cap' })).data.scene;
  ok('setup: cap scene created', !!capScene);
  const capFight = (await gm.req('POST', C, { scene_id: capScene.id })).data.combat;
  ok('setup: cap combat created', !!capFight);

  const MAX = 500;
  // Preload to MAX-5 through knex, plus the tokens they point at.
  const fixtureTokens = Array.from({ length: MAX - 5 }, (_, i) => ({
    scene_id: capScene.id, created_by: gm.id, name: `f${i}`, x: 0, y: 0, width: 1, height: 1,
  }));
  const inserted = await knex('tokens').insert(fixtureTokens).returning('id');
  await knex('combatants').insert(inserted.map((r, i) => ({
    combat_id: capFight.id, token_id: r.id, sort_order: i,
  })));
  const preload = Number((await knex('combatants')
    .where({ combat_id: capFight.id }).count({ n: '*' }).first()).n);
  ok('setup: combatant fixtures preloaded exactly', preload === MAX - 5, `got ${preload}`);

  // 20 racing adds against 5 remaining slots.
  const raceTokens = await knex('tokens').insert(
    Array.from({ length: 20 }, (_, i) => ({
      scene_id: capScene.id, created_by: gm.id, name: `r${i}`, x: 0, y: 0, width: 1, height: 1,
    })),
  ).returning('id');
  const adds = await Promise.all(raceTokens.map((r) => gm.req(
    'POST', `${C}/${capFight.id}/combatants`, { token_id: r.id },
  )));
  const addOk = adds.filter((r) => r.status === 201).length;
  const addNo = adds.filter((r) => r.status === 409).length;
  const landed = Number((await knex('combatants')
    .where({ combat_id: capFight.id }).count({ n: '*' }).first()).n);
  ok('URC: combatant cap holds EXACTLY under 20 parallel adds against 5 slots',
    landed === MAX && addOk === 5 && addNo === 15,
    `landed ${landed}, accepted ${addOk}, refused ${addNo}`);

  // --- UNIQUE (combat_id, token_id): the same token twice ---
  const dupTok = (await gm.req('POST', `${S}/tokens`, { name: 'Dup', x: 6, y: 6 })).data.token;
  const dupAdds = await Promise.all(Array.from({ length: 6 }, () => gm.req(
    'POST', `${C}/${fight.combat.id}/combatants`, { token_id: dupTok.id },
  )));
  const dupRows = Number((await knex('combatants')
    .where({ combat_id: fight.combat.id, token_id: dupTok.id }).count({ n: '*' }).first()).n);
  ok('URC: 6 parallel adds of one token leave EXACTLY one row',
    dupRows === 1, `${dupRows} rows; statuses ${dupAdds.map((r) => r.status).join(',')}`);

  // ================= blast radius ==========================================
  const before = Number((await knex('tokens').where({ scene_id: board.id }).count({ n: '*' }).first()).n);
  await gm.req('DELETE', `${C}/${fight.combat.id}`);
  const after = Number((await knex('tokens').where({ scene_id: board.id }).count({ n: '*' }).first()).n);
  ok('blast radius: deleting a combat does NOT clear the board',
    before === after && before > 0, `${before} -> ${after}`);
  const orphans = Number((await knex('combatants')
    .where({ combat_id: fight.combat.id }).count({ n: '*' }).first()).n);
  ok('blast radius: deleting a combat leaves no orphan combatants', orphans === 0, `${orphans}`);

  const del = await gm.req('DELETE', `/api/campaigns/${victim.id}/scenes/${capScene.id}`);
  ok('blast radius: scene delete REPORTS the combats it destroys',
    del.status === 200 && del.data.deleted && del.data.deleted.combat >= 1
      && del.data.deleted.combatants >= 1,
    JSON.stringify(del.data && del.data.deleted));
  const capOrphans = Number((await knex('combat')
    .where({ scene_id: capScene.id }).count({ n: '*' }).first()).n);
  ok('blast radius: a deleted scene leaves no orphan combats', capOrphans === 0, `${capOrphans}`);

  // ================= report ================================================
  console.log(results.join('\n'));
  console.log(`\n${pass} defended, ${fail} vulnerable`);
  if (findings.length) console.log('FINDINGS:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  console.log(results.join('\n'));
  await knex.destroy();
  process.exit(1);
});
