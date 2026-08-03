// Adversarial security audit for M4 (actors + items + inventory), kept as a
// security regression alongside the functional suites.
//   Usage: SKIP_HIBP=1 node break-actors.js
//
// Mapped to the OWASP API Security Top 10 (2023), like break-canvas.js:
//   API1 BOLA   — cross-campaign and cross-actor object access
//   API3 BOPLA  — forged server-owned properties; the NPC and unidentified-item
//                 projections, which are property-level confidentiality
//   API4 URC    — the actor / item / inventory / attunement caps under load
//   API5 BFLA   — GM-only functions attempted by a player
//
// THE PROBES THAT MATTER ARE THE LISTENING ONES.
//
// M4 adds two projections — an NPC's statistics and an unidentified item's
// details — and both have to hold on HTTP *and* on the socket. M3's V2 was an
// authorisation boundary enforced correctly over HTTP that leaked entirely over
// the socket broadcast, because the player was not ASKING for anything; they
// were listening. An HTTP-only audit passes clean against that build. So the L*
// probes below record what a player's socket actually receives while the GM
// works, and assert SILENCE on the secret fields — each with a control probe
// proving the legitimate path still delivers, so the fix cannot pass by muting
// everything.
//
// The cap probes assert EXACT counts (=== 3, not <= 3). break-canvas.js has two
// recorded instances of a ceiling assertion passing on zero, one of which hid a
// dead probe for weeks.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0, fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  DEFENDED  ${name}`); }
  else { fail++; results.push(`  VULNERABLE  ${name}  ${detail}`); findings.push(name); }
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

const STAT_FIELDS = [
  'hp_current', 'hp_max', 'hp_temp', 'armor_class', 'speed', 'level',
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'death_save_successes', 'death_save_failures', 'notes', 'data', 'class', 'race',
];
const SECRET_ITEM_FIELDS = ['name', 'description', 'properties', 'weight'];

(async () => {
  const gm = await mk('gm');
  const player = await mk('pl');
  const outsider = await mk('out');

  const victim = (await gm.req('POST', '/api/campaigns', { name: 'Victim', is_public: true })).data.campaign;
  const attacker = (await outsider.req('POST', '/api/campaigns', { name: 'Attacker', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${victim.id}/join`, {});

  const A = `/api/campaigns/${victim.id}/actors`;
  const I = `/api/campaigns/${victim.id}/items`;
  const scene = (await gm.req('POST', `/api/campaigns/${victim.id}/scenes`, { name: 'Board' })).data.scene;
  const S = `/api/campaigns/${victim.id}/scenes/${scene.id}`;
  await gm.req('PUT', `/api/campaigns/${victim.id}/scenes/active`, { scene_id: scene.id });

  const boss = (await gm.req('POST', A, {
    name: 'Dragon', is_npc: true, hp_current: 256, hp_max: 256, armor_class: 19,
    strength: 27, notes: 'hoard is in the third vault',
  })).data.actor;
  // A player creates a SHELL: hp_max is a capability and is refused at create
  // since 2026-08-02, so the GM sets it afterwards. (This fixture broke when
  // that change landed — a reminder that a permission change invalidates test
  // FIXTURES as well as assertions, and the fixtures fail as crashes rather
  // than as failures.)
  const pc = (await player.req('POST', A, { name: 'Aria' })).data.actor;
  await gm.req('PATCH', `${A}/${pc.id}`, { hp_max: 12 });
  const relic = (await gm.req('POST', I, {
    name: 'Staff of the Magi', type: 'weapon', description: 'Absorbs spells.',
    properties: { charges: 50 },
  })).data.item;

  // ============ API1: BOLA — object level ============
  const aPath = `/api/campaigns/${attacker.id}/actors`;
  ok('BOLA: victim actor via the attacker\'s campaign path -> 404',
    (await outsider.req('GET', `${aPath}/${boss.id}`)).status === 404);
  ok('BOLA: victim actor PATCH via the attacker\'s path -> 404',
    (await outsider.req('PATCH', `${aPath}/${boss.id}`, { hp_current: 0 })).status === 404);
  ok('BOLA: victim actor DELETE via the attacker\'s path -> 404',
    (await outsider.req('DELETE', `${aPath}/${boss.id}`)).status === 404);
  ok('BOLA: non-member cannot list the victim\'s actors -> 404',
    (await outsider.req('GET', A)).status === 404);
  ok('BOLA: non-member cannot list the victim\'s items -> 404',
    (await outsider.req('GET', I)).status === 404);
  const bossStill = await knex('actors').where({ id: boss.id }).first();
  ok('BOLA: the NPC survived every outsider attempt', !!bossStill && bossStill.hp_current === 256);

  // An inventory row is only addressable through the character carrying it.
  const invRow = (await player.req('POST', `${A}/${pc.id}/inventory`, { item_id: relic.id })).data.inventory;
  const dragonBag = `${A}/${boss.id}/inventory`;
  ok('BOLA: an inventory row addressed through the WRONG actor -> 404',
    (await gm.req('PATCH', `${dragonBag}/${invRow.id}`, { quantity: 99 })).status === 404);
  ok('BOLA: and deleting it through the wrong actor -> 404',
    (await gm.req('DELETE', `${dragonBag}/${invRow.id}`)).status === 404);
  const rowStill = await knex('inventory').where({ id: invRow.id }).first();
  ok('BOLA: the inventory row is untouched', !!rowStill && rowStill.quantity === 1);

  // ============ API5: BFLA — function level ============
  // Each entry carries its OWN expected status. The NPC bag answers 404 rather
  // than 403 since V2: its gate hides the creature's existence before the write
  // check is reached, which is the stronger refusal. A shared `=== 403` here
  // reported that improvement as a VULNERABILITY, so the expectation lives with
  // the case instead of being assumed across the loop.
  for (const [label, call, expected] of [
    ['author an item', () => player.req('POST', I, { name: 'Cheat', type: 'weapon' }), 403],
    ['edit an item', () => player.req('PATCH', `${I}/${relic.id}`, { name: 'Mine now' }), 403],
    ['identify an item', () => player.req('PATCH', `${I}/${relic.id}`, { identified: true }), 403],
    ['delete an item', () => player.req('DELETE', `${I}/${relic.id}`), 403],
    ['edit the GM\'s NPC', () => player.req('PATCH', `${A}/${boss.id}`, { hp_current: 1 }), 403],
    ['delete the GM\'s NPC', () => player.req('DELETE', `${A}/${boss.id}`), 403],
    // 404, not 403 — V2 hides the NPC's existence rather than confirming it.
    ['fill the NPC\'s bag', () => player.req('POST', `${A}/${boss.id}/inventory`, { item_id: relic.id }), 404],
  ]) {
    const r = await call();
    ok(`BFLA: player cannot ${label} (${expected})`, r.status === expected, `got ${r.status}`);
  }
  const untouched = await knex('actors').where({ id: boss.id }).first();
  const itemUntouched = await knex('items').where({ id: relic.id }).first();
  ok('BFLA: no player write left a trace',
    untouched.hp_current === 256 && itemUntouched.name === 'Staff of the Magi' && itemUntouched.identified === false);

  // ============ API3: BOPLA — the projection, over HTTP ============
  // V1 first: disclosure of an NPC begins when a VISIBLE token of it reaches the
  // player, not when the GM creates it. Before that the creature is not
  // projected — it is absent.
  const prepList = await player.req('GET', A);
  ok('V1: an un-placed NPC is absent from the player\'s actor list',
    !prepList.data.actors.some((a) => a.id === boss.id),
    JSON.stringify(prepList.data.actors.map((a) => a.name)));
  const prepRead = await player.req('GET', `${A}/${boss.id}`);
  ok('V1: reading an un-placed NPC answers 404, not 403 (no enumeration oracle)',
    prepRead.status === 404, `got ${prepRead.status}`);
  ok('V1: a player character is still listed normally',
    prepList.data.actors.some((a) => a.id === pc.id));

  // Put the dragon on the board. Disclosure begins — of the projected fields
  // only.
  await gm.req('POST', `${S}/tokens`, { actor_id: boss.id, x: 1, y: 1 });
  const plBoss = (await player.req('GET', `${A}/${boss.id}`)).data.actor;
  const statLeak = STAT_FIELDS.filter((f) => f in plBoss);
  ok('BOPLA: an NPC discloses no statistics to a player over HTTP', statLeak.length === 0, `leaked: ${statLeak.join(', ')}`);
  ok('BOPLA: and the GM\'s private notes never appear',
    JSON.stringify(plBoss).indexOf('third vault') === -1, JSON.stringify(plBoss));

  // And the disclosure is revocable: hide every token of it and the creature
  // goes back to being unknown, on the same rule rather than a second one.
  await knex('tokens').where({ actor_id: boss.id }).update({ hidden: true });
  const rehidden = await player.req('GET', `${A}/${boss.id}`);
  ok('V1: hiding its tokens makes the NPC unknown to the player again -> 404',
    rehidden.status === 404, `got ${rehidden.status}`);
  await knex('tokens').where({ actor_id: boss.id }).update({ hidden: false });

  const plRelic = (await player.req('GET', `${I}/${relic.id}`)).data.item;
  const itemLeak = SECRET_ITEM_FIELDS.filter((f) => f in plRelic);
  ok('BOPLA: an unidentified item discloses nothing to a player over HTTP', itemLeak.length === 0, `leaked: ${itemLeak.join(', ')}`);
  ok('BOPLA: not even its name', JSON.stringify(plRelic).indexOf('Staff of the Magi') === -1, JSON.stringify(plRelic));

  // Forged server-owned properties.
  const forged = await player.req('POST', A, {
    name: 'Forged', user_id: gm.id, is_npc: true, campaign_id: attacker.id,
    id: '00000000-0000-0000-0000-000000000000',
  });
  ok('BOPLA: create forces user_id to the caller', forged.data.actor.user_id === player.id, forged.data.actor.user_id);
  ok('BOPLA: create forces is_npc false for a player', forged.data.actor.is_npc === false);
  ok('BOPLA: create ignores a forged campaign_id', forged.data.actor.campaign_id === victim.id);
  ok('BOPLA: create ignores a forged id', forged.data.actor.id !== '00000000-0000-0000-0000-000000000000');

  // is_npc gates DISCLOSURE, so a player flipping it on their own sheet would
  // hide their character's stats from the rest of the table — and a player
  // flipping it OFF on an NPC would reveal the monster's.
  ok('BOPLA: a player cannot flip is_npc on their own character (403)',
    (await player.req('PATCH', `${A}/${pc.id}`, { is_npc: true })).status === 403);
  ok('BOPLA: nor hand their character to somebody else (403)',
    (await player.req('PATCH', `${A}/${pc.id}`, { user_id: gm.id })).status === 403);
  const pcRow = await knex('actors').where({ id: pc.id }).first();
  ok('BOPLA: neither attempt changed the row', pcRow.is_npc === false && pcRow.user_id === player.id);

  // The GM may assign a character, but only to somebody who is actually in the
  // campaign — otherwise a stranger would gain write access to a row inside a
  // campaign they cannot otherwise reach.
  ok('BOPLA: a character cannot be assigned to a non-member (400)',
    (await gm.req('PATCH', `${A}/${pc.id}`, { user_id: outsider.id })).status === 400);

  // ============ THE LISTENING PROBES ============
  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  const outSock = await connected(socketFor(outsider));
  await emitAck(gmSock, 'campaign:join', { campaign_id: victim.id });
  await emitAck(plSock, 'campaign:join', { campaign_id: victim.id });
  await emitAck(outSock, 'campaign:join', { campaign_id: victim.id });

  // L1 — the GM works on a monster. The player is not asking for anything.
  const l1 = recorder(plSock, ['actor:updated', 'actor:deleted']);
  const gmL1 = recorder(gmSock, ['actor:updated']);
  await gm.req('PATCH', `${A}/${boss.id}`, { hp_current: 128, notes: 'bloodied at 128' });
  await gm.req('PATCH', `${A}/${boss.id}`, { armor_class: 21 });
  await settle();
  const l1Leak = l1.filter((h) => STAT_FIELDS.some((f) => f in h.d));
  ok('L1: no NPC statistic reaches the player over the socket', l1Leak.length === 0, JSON.stringify(l1Leak.map((h) => h.d)));
  ok('L2: no GM note reaches the player over the socket',
    JSON.stringify(l1).indexOf('bloodied') === -1 && JSON.stringify(l1).indexOf('third vault') === -1,
    JSON.stringify(l1).slice(0, 300));
  ok('L3: the GM DID receive their own full payload (not simply muted)',
    gmL1.some((h) => h.d.hp_current === 128), JSON.stringify(gmL1.map((h) => h.d)));
  ok('control: the player still hears that the NPC changed, so its token re-renders',
    l1.length >= 1, `heard ${l1.length}`);

  // L4 — the same question for an unidentified item.
  const l4 = recorder(plSock, ['item:updated', 'item:created']);
  await gm.req('PATCH', `${I}/${relic.id}`, { description: 'Absorbs up to 50 spell levels.', properties: { charges: 50, secret: true } });
  await gm.req('POST', I, { name: 'Cursed Idol', type: 'misc', description: 'It watches.' });
  await settle();
  const l4Leak = l4.filter((h) => SECRET_ITEM_FIELDS.some((f) => f in h.d));
  ok('L4: no unidentified item detail reaches the player over the socket', l4Leak.length === 0, JSON.stringify(l4Leak.map((h) => h.d)));
  ok('L5: not even the item NAME, which is usually the spoiler',
    JSON.stringify(l4).indexOf('Staff of the Magi') === -1 && JSON.stringify(l4).indexOf('Cursed Idol') === -1,
    JSON.stringify(l4).slice(0, 300));

  // control — the reveal must actually work, or the fix is just muting.
  const l6 = recorder(plSock, ['item:updated']);
  await gm.req('PATCH', `${I}/${relic.id}`, { identified: true });
  await settle();
  ok('control: identifying the item DOES deliver it to the player in full',
    l6.some((h) => h.d.name === 'Staff of the Magi'), JSON.stringify(l6.map((h) => h.d)));

  // control — a player character is not projected at all.
  const l7 = recorder(plSock, ['actor:updated']);
  await gm.req('PATCH', `${A}/${pc.id}`, { hp_current: 7 });
  await settle();
  ok('control: a PLAYER character\'s hit points do reach the table',
    l7.some((h) => h.d.hp_current === 7), JSON.stringify(l7.map((h) => h.d)));

  // L8 — the token link must not become a side channel. A player who can see a
  // monster's token must still not learn its statistics.
  const l8 = recorder(plSock, ['actor:updated', 'token:created']);
  await gm.req('POST', `${S}/tokens`, { actor_id: boss.id, x: 2, y: 2 });
  await settle();
  const l8Leak = l8.filter((h) => STAT_FIELDS.some((f) => f in h.d));
  ok('L8: placing a linked NPC token leaks no statistics to the player', l8Leak.length === 0, JSON.stringify(l8Leak.map((h) => h.d)));
  ok('control: the player did receive the token and its character',
    l8.some((h) => h.ev === 'token:created') && l8.some((h) => h.ev === 'actor:updated'),
    JSON.stringify(l8.map((h) => h.ev)));

  // L9 — a hidden token's character must never leave the server at all.
  const l9 = recorder(plSock, ['actor:updated', 'token:created']);
  const ghost = (await gm.req('POST', A, { name: 'Assassin', is_npc: true, hp_max: 60 })).data.actor;
  await gm.req('POST', `${S}/tokens`, { actor_id: ghost.id, x: 6, y: 6, hidden: true });
  await settle();
  ok('L9: the character behind a HIDDEN token is never announced to players',
    !l9.some((h) => h.d && h.d.id === ghost.id), JSON.stringify(l9.map((h) => h.d)));
  ok('L10: and its name never reaches them', JSON.stringify(l9).indexOf('Assassin') === -1, JSON.stringify(l9).slice(0, 200));

  // L11 — an outsider in no room hears nothing at all.
  const l11 = recorder(outSock, ['actor:updated', 'actor:deleted', 'item:updated', 'item:created', 'inventory:changed']);
  await gm.req('PATCH', `${A}/${boss.id}`, { hp_current: 64 });
  await gm.req('PATCH', `${I}/${relic.id}`, { description: 'changed again' });
  await settle();
  ok('L11: a non-member hears nothing about actors or items', l11.length === 0, JSON.stringify(l11.map((h) => h.ev)));

  // L12 — inventory deltas carry no data, so there is no second place for the
  // item projection to drift or leak.
  const l12 = recorder(plSock, ['inventory:changed']);
  await gm.req('PATCH', `${I}/${relic.id}`, { identified: false });
  await gm.req('POST', `${A}/${boss.id}/inventory`, { item_id: relic.id, quantity: 4 });
  await settle();
  ok('L12: inventory events carry only an actor_id, never item data',
    l12.length >= 1 && l12.every((h) => Object.keys(h.d).length === 1 && 'actor_id' in h.d),
    JSON.stringify(l12.map((h) => h.d)));

  // ============ V2: the inventory read path ============
  // Every actor rule so far — the projection, playersMayKnowActor — is enforced
  // on the list, detail and broadcast paths. Inventory reaches the same actors
  // by a different door, so it gets its own probes rather than an assumption.
  //
  // The party shares a table, so a player reading ANOTHER PLAYER's bag is
  // deliberate and has a control probe below. A player reading the GM's monster's
  // bag is not: that is the encounter's loot list, and `identified` does not save
  // it because the ordinary workflow marks mundane loot identified at creation.
  await gm.req('POST', `${A}/${boss.id}/inventory`, { item_id: relic.id, quantity: 7 });
  const mundane = (await gm.req('POST', I, { name: 'Hoard Key', type: 'misc', identified: true, description: 'Opens the third vault.' })).data.item;
  await gm.req('POST', `${A}/${boss.id}/inventory`, { item_id: mundane.id });

  const npcBag = await player.req('GET', `${A}/${boss.id}/inventory`);
  ok('V2: a player cannot read an NPC\'s inventory -> 404',
    npcBag.status === 404, `got ${npcBag.status}: ${JSON.stringify(npcBag.data).slice(0, 200)}`);
  ok('V2: and no identified loot leaks through it',
    JSON.stringify(npcBag.data || {}).indexOf('Hoard Key') === -1
    && JSON.stringify(npcBag.data || {}).indexOf('third vault') === -1,
    JSON.stringify(npcBag.data).slice(0, 200));
  // Asserted on SHAPE, not on a magic number. The first version of this probe
  // grepped for '"quantity":7' and reported DEFENDED against a fully leaked
  // payload, because an earlier probe had already put 4 of that item in the bag
  // and the stored value was 11. A probe that greps for a literal is the
  // ceiling-assertion mistake wearing a different hat: it can only fail when the
  // leak looks exactly the way it was imagined.
  ok('V2: and the response carries no inventory rows at all',
    !npcBag.data || !Array.isArray(npcBag.data.inventory) || npcBag.data.inventory.length === 0,
    JSON.stringify(npcBag.data).slice(0, 200));

  // Controls — the legitimate paths must still work, or a fix could pass by
  // simply refusing everything.
  const ownBag = await player.req('GET', `${A}/${pc.id}/inventory`);
  ok('control: a player still reads their OWN bag', ownBag.status === 200, `got ${ownBag.status}`);
  const gmBag = await gm.req('GET', `${A}/${boss.id}/inventory`);
  ok('control: the GM still reads the NPC bag in full',
    gmBag.status === 200 && JSON.stringify(gmBag.data).indexOf('Hoard Key') !== -1, `got ${gmBag.status}`);

  // The write paths must not become an existence oracle for the GM's prep: an
  // NPC bag and a nonexistent actor have to answer identically.
  const npcWrite = await player.req('POST', `${A}/${boss.id}/inventory`, { item_id: relic.id });
  const ghostWrite = await player.req('POST', `${A}/11111111-1111-4111-8111-111111111111/inventory`, { item_id: relic.id });
  ok('V2: writing to an NPC bag is refused', npcWrite.status === 404 || npcWrite.status === 403, `got ${npcWrite.status}`);
  ok('V2: and answers identically to a nonexistent actor (no oracle)',
    npcWrite.status === ghostWrite.status, `npc ${npcWrite.status} vs ghost ${ghostWrite.status}`);
  const bagRows = Number((await knex('inventory').where({ actor_id: boss.id }).count({ n: '*' }).first()).n);
  ok('V2: the NPC bag is unchanged by the attempt', bagRows === 2, `${bagRows} rows`);

  // ============ quantity accumulation ============
  // validateQuantity caps a single REQUEST at 9999. The upsert merges
  // `quantity + ?`, so without a ceiling on the RESULT the validator bounds only
  // the increment and the stored value can exceed its own validator — and, given
  // enough requests, overflow the int4 column into an unhandled 22003.
  const stackItem = (await gm.req('POST', I, { name: 'Arrows', type: 'misc', identified: true })).data.item;
  await player.req('POST', `${A}/${pc.id}/inventory`, { item_id: stackItem.id, quantity: 9999 });
  const second = await player.req('POST', `${A}/${pc.id}/inventory`, { item_id: stackItem.id, quantity: 9999 });
  const stacked = await knex('inventory').where({ actor_id: pc.id, item_id: stackItem.id }).first();
  ok('a stack cannot be pushed past the validator\'s own bound by repeating the add',
    stacked && stacked.quantity <= 9999, `stored quantity ${stacked && stacked.quantity} (bound is 9999)`);
  ok('and the request is not a 500', second.status < 500, `got ${second.status}`);

  // The inventory ROW cap, now atomic (it was a read-then-write until
  // 2026-08-02). 30 parallel adds of 30 DISTINCT items against a cap of 200,
  // preloaded to 195, must land on exactly 200 with 5 accepted.
  const capActorRes = await gm.req('POST', A, { name: 'Mule' });
  const capActor = capActorRes.data && capActorRes.data.actor;
  ok('setup: the row-cap probe has an actor to fill', !!capActor,
     `create returned ${capActorRes.status} — do not let this crash the suite`);
  const CV = `${A}/${capActor.id}/inventory`;

  // Fixtures are seeded STRAIGHT INTO THE DATABASE rather than over HTTP. The
  // first version of this probe created 225 items through the API, which is
  // ~450 writes — enough to exhaust contentWriteLimiter at its default of 120
  // and crash the suite with an undefined response, and slow even with the
  // limiters raised. A probe should spend its request budget on the thing it is
  // measuring; here that is the 30 racing adds and nothing else.
  const seedItems = [];
  for (let i = 0; i < 225; i++) {
    seedItems.push({ campaign_id: victim.id, name: `Seed ${i}`, type: 'misc', identified: true });
  }
  const seeded = await knex('items').insert(seedItems).returning('id');
  const seededIds = seeded.map((r) => (typeof r === 'object' ? r.id : r));
  // 195 rows in the bag, 5 slots left under the 200 cap.
  await knex('inventory').insert(seededIds.slice(0, 195).map((id) => ({
    actor_id: capActor.id, item_id: id, quantity: 1,
  })));
  const racers = seededIds.slice(195, 225);

  const rowRace = await Promise.all(racers.map((id) => gm.req('POST', CV, { item_id: id })));
  const rowAccepted = rowRace.filter((r) => r.status === 201).length;
  const rowRefused = rowRace.filter((r) => r.status === 409).length;
  const rowTotal = Number((await knex('inventory').where({ actor_id: capActor.id }).count({ n: '*' }).first()).n);
  ok('TOCTOU: the inventory row cap lands on EXACTLY 200 under 30 parallel adds',
    rowTotal === 200 && rowAccepted === 5 && rowRefused === 25,
    `${rowTotal} rows, ${rowAccepted} accepted, ${rowRefused} refused`);
  note('inventory row cap race', `${rowTotal} rows after the race, ${rowAccepted} accepted, ${rowRefused} refused with 409`);

  // Topping up an EXISTING stack adds no row, so it must still be allowed at the
  // cap — the branch that breaks if an upsert is counted as +1.
  const topUp = await gm.req('POST', CV, { item_id: seededIds[0], quantity: 2 });
  ok('a full bag can still have an existing stack topped up', topUp.status === 201, `got ${topUp.status}`);
  const topped = await knex('inventory').where({ actor_id: capActor.id, item_id: seededIds[0] }).first();
  ok('and the top-up actually landed', topped && topped.quantity === 3, `quantity ${topped && topped.quantity}`);

  // ============ API4: caps under parallel load ============
  // These two exercise the branches M4 added to withAtomicCap, which no existing
  // suite reaches: `extraCaps` (two caps in one transaction) and `update` (a cap
  // on an UPDATE rather than an INSERT).
  const racer = await mk('race');
  const raceCamp = (await gm.req('POST', '/api/campaigns', { name: 'ActorRace', is_public: true })).data.campaign;
  await racer.req('POST', `/api/campaigns/${raceCamp.id}/join`, {});
  const RA = `/api/campaigns/${raceCamp.id}/actors`;
  const spawn = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    racer.req('POST', RA, { name: `Race ${i}` })));
  const spawned = spawn.filter((r) => r.status === 201).length;
  const refusedSpawn = spawn.filter((r) => r.status === 409).length;
  const actorRows = Number((await knex('actors').where({ campaign_id: raceCamp.id, user_id: racer.id }).count({ n: '*' }).first()).n);
  ok('TOCTOU: the per-player actor cap lands on EXACTLY 3 under 20 parallel creates',
    actorRows === 3 && spawned === 3 && refusedSpawn === 17,
    `${actorRows} rows, ${spawned} created, ${refusedSpawn} refused`);
  note('actor cap race', `${actorRows} rows after the race, ${spawned} created, ${refusedSpawn} refused with 409`);

  // Attunement: 20 distinct rows in one bag, all attuned in parallel against a
  // cap of 3. This is the UPDATE branch — the row already exists and the write
  // flips a boolean, so a read-then-write here would let all 20 through.
  //
  // A SECOND user owns this bag on purpose. `racer` has just had their 3-actor
  // allowance consumed by the race above, so creating another character as them
  // is correctly refused with a 409 — the per-player cap is campaign-wide, and
  // an audit that exhausts it cannot then help itself to one more actor.
  const bagOwner = await mk('bag');
  await bagOwner.req('POST', `/api/campaigns/${raceCamp.id}/join`, {});
  const raceActor = (await bagOwner.req('POST', RA, { name: 'Packrat' })).data.actor;
  ok('setup: the attunement race has an actor to work with', !!raceActor,
     'without it the attunement cap probe below cannot run — do not let this skip silently');
  const RV = `${RA}/${raceActor.id}/inventory`;
  const trinketRows = [];
  for (let i = 0; i < 20; i++) {
    const it = (await gm.req('POST', `/api/campaigns/${raceCamp.id}/items`,
      { name: `Trinket ${i}`, type: 'misc', identified: true })).data.item;
    trinketRows.push((await bagOwner.req('POST', RV, { item_id: it.id })).data.inventory);
  }
  const attuneRace = await Promise.all(trinketRows.map((row) =>
    bagOwner.req('PATCH', `${RV}/${row.id}`, { attuned: true })));
  const attuned = attuneRace.filter((r) => r.status === 200).length;
  const refusedAttune = attuneRace.filter((r) => r.status === 409).length;
  const attunedRows = Number((await knex('inventory').where({ actor_id: raceActor.id, attuned: true }).count({ n: '*' }).first()).n);
  ok('TOCTOU: the attunement cap lands on EXACTLY 3 under 20 parallel attunements',
    attunedRows === 3 && attuned === 3 && refusedAttune === 17,
    `${attunedRows} attuned, ${attuned} accepted, ${refusedAttune} refused`);
  note('attunement cap race', `${attunedRows} rows after the race, ${attuned} accepted, ${refusedAttune} refused with 409`);

  // ============ API4: payload bounds ============
  ok('DoS: an oversized data blob is rejected',
    (await player.req('PATCH', `${A}/${pc.id}`, { data: { s: 'x'.repeat(20000) } })).status === 400);
  let deep = {}; let cur = deep;
  for (let i = 0; i < 40; i++) { cur.n = {}; cur = cur.n; }
  ok('DoS: a deeply nested data blob is rejected',
    (await player.req('PATCH', `${A}/${pc.id}`, { data: deep })).status === 400);
  const manyKeys = {};
  for (let i = 0; i < 500; i++) manyKeys[`k${i}`] = i;
  ok('DoS: a data blob with too many keys is rejected',
    (await player.req('PATCH', `${A}/${pc.id}`, { data: manyKeys })).status === 400);
  ok('DoS: oversized notes rejected',
    (await player.req('PATCH', `${A}/${pc.id}`, { notes: 'n'.repeat(9000) })).status === 400);
  ok('DoS: oversized actor name rejected',
    (await player.req('PATCH', `${A}/${pc.id}`, { name: 'N'.repeat(500) })).status === 400);
  ok('DoS: an absurd quantity is rejected',
    (await player.req('PATCH', `${A}/${pc.id}/inventory/${invRow.id}`, { quantity: 999999 })).status === 400);

  // ============ type confusion ============
  for (const [label, body] of [
    ['nested array as a stat', { strength: [[5]] }],
    ['single-element array as a stat', { strength: [5] }],
    ['boolean as a stat', { strength: true }],
    ['object as a stat', { hp_max: { v: 3 } }],
    ['null as a stat', { armor_class: null }],
    ['fractional level', { level: 2.5 }],
    ['array as size', { size: ['Large'] }],
    ['array as is_npc', { is_npc: [true] }],
    ['string as data', { data: 'not-an-object' }],
    ['array as data', { data: [1, 2] }],
  ]) {
    const r = await gm.req('PATCH', `${A}/${pc.id}`, body);
    ok(`TYPE: ${label} rejected (4xx, not 500)`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  for (const [label, body] of [
    ['array as item type', { type: ['weapon'] }],
    ['object as weight', { weight: { v: 1 } }],
    ['array as identified', { identified: [true] }],
    ['string as properties', { properties: 'x' }],
  ]) {
    const r = await gm.req('PATCH', `${I}/${relic.id}`, body);
    ok(`TYPE: ${label} rejected (4xx, not 500)`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  for (const bad of ['not-a-uuid', '../../etc/passwd', '1 OR 1=1']) {
    const r = await gm.req('GET', `${A}/${encodeURIComponent(bad)}`);
    ok(`TYPE: "${bad.slice(0, 14)}" as an actor id -> 404, not a 500`, r.status === 404, `got ${r.status}`);
  }
  ok('TYPE: a non-uuid item_id in an inventory add -> 400',
    (await player.req('POST', `${A}/${pc.id}/inventory`, { item_id: 42 })).status === 400);

  // ============ blast radius ============
  const linkTok = (await gm.req('POST', `${S}/tokens`, { actor_id: pc.id, x: 4, y: 4 })).data.token;
  await gm.req('DELETE', `${A}/${pc.id}`);
  const orphanTok = await knex('tokens').where({ id: linkTok.id }).first();
  ok('deleting a character UNLINKS its tokens rather than deleting them',
    !!orphanTok && orphanTok.actor_id === null, orphanTok ? 'actor_id not cleared' : 'token was cascaded away');
  const orphanInv = await knex('inventory').where({ actor_id: pc.id });
  ok('and leaves no orphan inventory rows', orphanInv.length === 0, `${orphanInv.length} rows`);
  const campStill = await knex('campaigns').where({ id: victim.id }).first();
  ok('the campaign itself is untouched by an actor deletion', !!campStill);

  note('403 vs 404 on the token link',
    'RESOLVED with V1. The earlier build answered 403 for an actor in this campaign the caller does not control and 404 for one in another campaign — tolerable only while GET /actors listed every NPC to players. V1 removed that listing, so resolveTokenActor now answers 404 in both cases and the placement endpoint is no longer an enumeration oracle for the GM\'s prep.');
  note('actor sheets are not private between players',
    'a player character is readable in full by every member. Deliberate — the party shares a table — and it is also the only thing the socket layer can express: broadcastToPlayers targets the room minus the GM, so GM/not-GM is the only distinction available.');
  note('items disclose existence, not detail',
    'an unidentified item is still LISTED to players, projected. Filtering it out entirely would be stronger but incoherent with inventory, where a player must be able to see that they are carrying something.');

  gmSock.close(); plSock.close(); outSock.close();
  console.log('\n' + results.join('\n'));
  console.log('\n' + '='.repeat(60));
  console.log(`${pass} defended, ${fail} VULNERABLE`);
  if (findings.length) { console.log('\nFINDINGS:'); findings.forEach((f) => console.log('  - ' + f)); }
  await knex.destroy();
  process.exit(0);
})().catch(async (e) => {
  console.error('AUDIT CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
