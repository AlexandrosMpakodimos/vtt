// Functional test suite for M4 (items + inventory), run against a real
// PostgreSQL with the server running.
//   Usage: SKIP_HIBP=1 node test-items-inventory.js
//
// Covers the session's done-criteria and their failure modes:
//   - The GM authors the campaign's item catalogue; players do not.
//   - IDENTIFIED: while the flag is false a player receives an item's category
//     and picture and nothing else — not even its NAME, because an item called
//     "Flame Tongue" leaks through its own name. Flipping the flag reveals it to
//     the table in real time.
//   - Inventory is a join table with a UNIQUE (actor_id, item_id) constraint, so
//     adding an item a character already carries INCREMENTS the stack in a
//     single atomic upsert rather than a read-then-write.
//   - Attunement is capped at 3 per character, enforced atomically through
//     withAtomicCap's update branch — including the two edge cases that are
//     silent bugs if missed: re-attuning an already-attuned item at the cap must
//     succeed (it adds nothing to the capped set), and un-attuning at the cap
//     must succeed (it can never breach one).
//   - Nothing is automated: equipping armour does not change armour class, and
//     weight is stored and displayed but never turned into encumbrance.

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

// Everything an unidentified item must not disclose. `name` is on this list on
// purpose: it is usually the biggest spoiler an item has.
const SECRET_FIELDS = ['name', 'description', 'properties', 'weight'];

(async () => {
  const gm = await makeUser('gm');
  const player = await makeUser('pl');
  const player2 = await makeUser('pl2');
  const stranger = await makeUser('str');

  const created = await gm.req('POST', '/api/campaigns', {
    name: 'Item Test', is_public: false, password: 'roompw',
  });
  check('campaign create', created.status === 201, JSON.stringify(created.data));
  const C = created.data.campaign.id;
  await player.req('POST', `/api/campaigns/${C}/join`, { password: 'roompw' });
  await player2.req('POST', `/api/campaigns/${C}/join`, { password: 'roompw' });

  const I = `/api/campaigns/${C}/items`;
  const A = `/api/campaigns/${C}/actors`;

  // Players create shells; hp_max is GM-owned and refused at create since
  // 2026-08-02, so the GM fills it in.
  const mine = (await player.req('POST', A, { name: 'Aria' })).data.actor;
  const theirs = (await player2.req('POST', A, { name: 'Brom' })).data.actor;
  await gm.req('PATCH', `${A}/${mine.id}`, { hp_max: 12 });
  await gm.req('PATCH', `${A}/${theirs.id}`, { hp_max: 20 });

  // ---------- the catalogue ----------
  const rope = await gm.req('POST', I, {
    name: 'Hempen Rope', type: 'misc', weight: 10, description: '50 feet.', identified: true,
  });
  check('GM creates an item (201)', rope.status === 201, JSON.stringify(rope.data));
  check('weight comes back as a number, not "10.00"', rope.data.item.weight === 10, JSON.stringify(rope.data.item.weight));

  const blade = await gm.req('POST', I, {
    name: 'Flame Tongue', type: 'weapon', weight: 3,
    description: 'Bursts into flame on command.', properties: { damage: '2d6 fire' },
  });
  check('GM creates an item without saying identified (201)', blade.status === 201, JSON.stringify(blade.data));
  check('and it defaults to SECRET — the non-disclosing default', blade.data.item.identified === false);

  const badType = await gm.req('POST', I, { name: 'Thing', type: 'artifact' });
  check('unknown item type rejected (400)', badType.status === 400, JSON.stringify(badType.data));
  const noName = await gm.req('POST', I, { type: 'misc' });
  check('an item with no name rejected (400)', noName.status === 400);
  const negWeight = await gm.req('POST', I, { name: 'Anti-rock', type: 'misc', weight: -5 });
  check('negative weight rejected (400)', negWeight.status === 400);
  const hugeProps = await gm.req('POST', I, { name: 'Bloat', type: 'misc', properties: { s: 'x'.repeat(9000) } });
  check('an oversized properties blob rejected (400)', hugeProps.status === 400, JSON.stringify(hugeProps.data));

  const playerItem = await player.req('POST', I, { name: 'Sword of Cheating', type: 'weapon' });
  check('a player cannot author items (403)', playerItem.status === 403, JSON.stringify(playerItem.data));

  // ---------- identified ----------
  const gmCat = await gm.req('GET', I);
  const gmBlade = gmCat.data.items.find((i) => i.id === blade.data.item.id);
  check('the GM sees the unidentified item in full', gmBlade.name === 'Flame Tongue' && gmBlade.description.length > 0);

  const plCat = await player.req('GET', I);
  const plBlade = plCat.data.items.find((i) => i.id === blade.data.item.id);
  check('a player still sees THAT the item exists', !!plBlade);
  check('and its category, so the client can label it', plBlade.type === 'weapon');
  const leaked = SECRET_FIELDS.filter((f) => f in plBlade);
  check('but not its name, description, properties or weight', leaked.length === 0, `leaked: ${leaked.join(', ')}`);
  const plRope = plCat.data.items.find((i) => i.id === rope.data.item.id);
  check('an identified item is fully readable by a player', plRope.name === 'Hempen Rope' && plRope.weight === 10);

  const plOne = await player.req('GET', `${I}/${blade.data.item.id}`);
  check('the detail route projects identically to the list',
    plOne.status === 200 && !('name' in plOne.data.item), JSON.stringify(plOne.data.item));

  // ---------- the reveal ----------
  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(player));
  await emitAck(gmSock, 'campaign:join', { campaign_id: C });
  await emitAck(plSock, 'campaign:join', { campaign_id: C });

  const heardSecret = recorder(plSock, ['item:updated']);
  await gm.req('PATCH', `${I}/${blade.data.item.id}`, { description: 'Bursts into flame. +2d6 fire.' });
  await settle();
  const secretLeak = heardSecret.filter((h) => SECRET_FIELDS.some((f) => f in h.d));
  check('editing an unidentified item leaks nothing over the socket either',
    secretLeak.length === 0, JSON.stringify(secretLeak.map((h) => h.d)));
  check('though the player IS told something changed', heardSecret.length >= 1, `heard ${heardSecret.length}`);

  const heardReveal = recorder(plSock, ['item:updated']);
  const reveal = await gm.req('PATCH', `${I}/${blade.data.item.id}`, { identified: true });
  await settle();
  check('the GM identifies the item (200)', reveal.status === 200 && reveal.data.item.identified === true, JSON.stringify(reveal.data));
  check('and the player is sent the full item in real time',
    heardReveal.some((h) => h.d.name === 'Flame Tongue'), JSON.stringify(heardReveal.map((h) => h.d)));

  const plAfter = await player.req('GET', `${I}/${blade.data.item.id}`);
  check('the player can now read it over HTTP too', plAfter.data.item.name === 'Flame Tongue');

  const reHide = await gm.req('PATCH', `${I}/${blade.data.item.id}`, { identified: false });
  check('the toggle is symmetric — an item can be made secret again (200)', reHide.status === 200 && reHide.data.item.identified === false);
  const plHidden = await player.req('GET', `${I}/${blade.data.item.id}`);
  check('and the player stops receiving its name again', !('name' in plHidden.data.item));
  await gm.req('PATCH', `${I}/${blade.data.item.id}`, { identified: true });

  const plPatch = await player.req('PATCH', `${I}/${blade.data.item.id}`, { identified: false });
  check('a player cannot flip identified themselves (403)', plPatch.status === 403, JSON.stringify(plPatch.data));

  // ---------- inventory ----------
  const V = `${A}/${mine.id}/inventory`;
  const add = await player.req('POST', V, { item_id: rope.data.item.id, quantity: 2 });
  check('a player puts an item in their own bag (201)', add.status === 201 && add.data.inventory.quantity === 2, JSON.stringify(add.data));
  const invId = add.data.inventory.id;

  const addAgain = await player.req('POST', V, { item_id: rope.data.item.id, quantity: 3 });
  check('adding the same item again INCREMENTS the stack', addAgain.status === 201 && addAgain.data.inventory.quantity === 5, JSON.stringify(addAgain.data));
  const rows = await knex('inventory').where({ actor_id: mine.id, item_id: rope.data.item.id });
  check('and does not create a second row (UNIQUE actor_id,item_id)', rows.length === 1, `${rows.length} rows`);

  const bagRead = await player.req('GET', V);
  check('the bag lists the row with its item attached', bagRead.data.inventory.length === 1 && bagRead.data.inventory[0].item.name === 'Hempen Rope', JSON.stringify(bagRead.data));

  // Carrying a mysterious object is not the same as knowing what it is.
  await gm.req('PATCH', `${I}/${blade.data.item.id}`, { identified: false });
  await player.req('POST', V, { item_id: blade.data.item.id });
  const bagSecret = await player.req('GET', V);
  const carried = bagSecret.data.inventory.find((r) => r.item_id === blade.data.item.id);
  const bagLeak = SECRET_FIELDS.filter((f) => f in carried.item);
  check('an unidentified item in a player\'s OWN bag is still projected', bagLeak.length === 0, `leaked: ${bagLeak.join(', ')}`);
  const gmBag = await gm.req('GET', V);
  const gmCarried = gmBag.data.inventory.find((r) => r.item_id === blade.data.item.id);
  check('while the GM reading the same bag sees the real item', gmCarried.item.name === 'Flame Tongue');
  await gm.req('PATCH', `${I}/${blade.data.item.id}`, { identified: true });

  const foreign = await player.req('POST', `${A}/${theirs.id}/inventory`, { item_id: rope.data.item.id });
  check('a player cannot put items in another character\'s bag (403)', foreign.status === 403, JSON.stringify(foreign.data));
  const gmToAny = await gm.req('POST', `${A}/${theirs.id}/inventory`, { item_id: rope.data.item.id });
  check('the GM may equip any character (201)', gmToAny.status === 201, JSON.stringify(gmToAny.data));

  const other = await gm.req('POST', '/api/campaigns', { name: 'Elsewhere', is_public: true });
  const foreignItem = (await gm.req('POST', `/api/campaigns/${other.data.campaign.id}/items`, { name: 'Alien', type: 'misc' })).data.item;
  const crossAdd = await player.req('POST', V, { item_id: foreignItem.id });
  check('an item from another campaign cannot be added -> 404', crossAdd.status === 404, JSON.stringify(crossAdd.data));

  const zeroQty = await player.req('POST', V, { item_id: rope.data.item.id, quantity: 0 });
  check('quantity 0 rejected (400)', zeroQty.status === 400);
  const noItem = await player.req('POST', V, {});
  check('a missing item_id rejected (400)', noItem.status === 400);

  // ---------- equipping changes nothing ----------
  const acBefore = (await knex('actors').where({ id: mine.id }).first()).armor_class;
  const equip = await player.req('PATCH', `${V}/${invId}`, { equipped: true });
  check('a player equips an item in their own bag (200)', equip.status === 200 && equip.data.inventory.equipped === true, JSON.stringify(equip.data));
  const acAfter = (await knex('actors').where({ id: mine.id }).first()).armor_class;
  check('equipping does NOT modify the character (GM interprets)', acBefore === acAfter, `${acBefore} -> ${acAfter}`);

  // ---------- attunement ----------
  const rings = [];
  for (let i = 0; i < 5; i++) {
    const it = (await gm.req('POST', I, { name: `Ring ${i}`, type: 'misc', identified: true })).data.item;
    const row = (await player.req('POST', V, { item_id: it.id })).data.inventory;
    rings.push(row);
  }
  for (let i = 0; i < 3; i++) {
    const r = await player.req('PATCH', `${V}/${rings[i].id}`, { attuned: true });
    check(`attunement slot ${i + 1} of 3 accepted`, r.status === 200 && r.data.inventory.attuned === true, JSON.stringify(r.data));
  }
  const fourth = await player.req('PATCH', `${V}/${rings[3].id}`, { attuned: true });
  check('a fourth attunement is refused (409)', fourth.status === 409, JSON.stringify(fourth.data));
  const attunedCount = await knex('inventory').where({ actor_id: mine.id, attuned: true }).count({ n: '*' }).first();
  check('the character holds exactly 3 attuned items', Number(attunedCount.n) === 3, `${attunedCount.n} attuned`);

  // The two edge cases in withAtomicCap's update branch. Both are silent bugs if
  // the branch counts an UPDATE as always adding one to the capped set.
  const reAttune = await player.req('PATCH', `${V}/${rings[0].id}`, { attuned: true });
  check('re-attuning an ALREADY-attuned item at the cap succeeds (it adds nothing)',
    reAttune.status === 200 && reAttune.data.inventory.attuned === true, JSON.stringify(reAttune.data));
  const unAttune = await player.req('PATCH', `${V}/${rings[0].id}`, { attuned: false });
  check('un-attuning at the cap succeeds (attuning DOWN can never breach it)',
    unAttune.status === 200 && unAttune.data.inventory.attuned === false, JSON.stringify(unAttune.data));
  const nowFits = await player.req('PATCH', `${V}/${rings[3].id}`, { attuned: true });
  check('and the freed slot is immediately usable (200)', nowFits.status === 200, JSON.stringify(nowFits.data));
  const stillThree = await knex('inventory').where({ actor_id: mine.id, attuned: true }).count({ n: '*' }).first();
  check('still exactly 3 attuned after the swap', Number(stillThree.n) === 3, `${stillThree.n} attuned`);

  // ---------- removal ----------
  const heardInv = recorder(plSock, ['inventory:changed']);
  const drop = await player.req('DELETE', `${V}/${invId}`);
  await settle();
  check('a player drops an item from their bag (200)', drop.status === 200, JSON.stringify(drop.data));
  check('the room is notified', heardInv.length >= 1, `heard ${heardInv.length}`);
  check('and the notification carries NO item data — clients re-fetch through the authorised path',
    heardInv.every((h) => Object.keys(h.d).length === 1 && 'actor_id' in h.d), JSON.stringify(heardInv.map((h) => h.d)));

  const held = await knex('inventory').where({ item_id: rope.data.item.id }).count({ n: '*' }).first();
  const delItem = await gm.req('DELETE', `${I}/${rope.data.item.id}`);
  check('the GM deletes an item (200)', delItem.status === 200, JSON.stringify(delItem.data));
  check('the response names the blast radius it cleared',
    delItem.data.inventory_rows_removed === Number(held.n), `${delItem.data.inventory_rows_removed} vs ${held.n}`);
  const orphans = await knex('inventory').where({ item_id: rope.data.item.id });
  check('no orphan inventory rows survive the cascade', orphans.length === 0, `${orphans.length} rows`);

  const playerDelete = await player.req('DELETE', `${I}/${blade.data.item.id}`);
  check('a player cannot delete a catalogue item (403)', playerDelete.status === 403, JSON.stringify(playerDelete.data));

  // Deleting a character empties their bag.
  const bagRows = await knex('inventory').where({ actor_id: mine.id }).count({ n: '*' }).first();
  check('the character is carrying things before deletion', Number(bagRows.n) > 0, `${bagRows.n} rows`);
  await player.req('DELETE', `${A}/${mine.id}`);
  const afterActor = await knex('inventory').where({ actor_id: mine.id });
  check('deleting a character cascades their inventory away', afterActor.length === 0, `${afterActor.length} rows`);

  // ---------- outsiders ----------
  for (const [label, call] of [
    ['list items', () => stranger.req('GET', I)],
    ['create an item', () => stranger.req('POST', I, { name: 'x', type: 'misc' })],
    ['read a bag', () => stranger.req('GET', `${A}/${theirs.id}/inventory`)],
    ['add to a bag', () => stranger.req('POST', `${A}/${theirs.id}/inventory`, { item_id: blade.data.item.id })],
  ]) {
    const r = await call();
    check(`a non-member cannot ${label} -> 404 (no existence leak)`, r.status === 404, `got ${r.status}`);
  }

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
