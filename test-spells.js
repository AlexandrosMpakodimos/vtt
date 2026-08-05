// Spells: catalogue and spellbooks (M6).
//   Usage: SKIP_HIBP=1 node test-spells.js   (server on npm run dev:test)
//
// Functional and adversarial in one file, as test-speaker-color.js and
// test-scene-grid.js are: the security surface here is not a separate subject
// from the behaviour. "A player may fill their own spellbook" and "a player may
// NOT read the lich's" are one rule from two sides.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA  — a spell or spellbook reached through the wrong campaign/actor
//   API3 BOPLA — forged ids; the rules boundary on `prepared` and `source`
//   API4 URC   — the catalogue and spellbook caps, under a race
//   API5 BFLA  — a player authoring the catalogue
//
// THE PROBE THAT MATTERS is the NPC spellbook. Spells reach `actors` through a
// new door, and the rule it must not bypass is the one M4's V2 was: knowing
// which spells the villain has prepared is the GM's preparation in exactly the
// sense a monster's pockets are. The gate is reused, not rewritten, so these
// probes are checking that the reuse actually took.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

let pass = 0; let fail = 0; const results = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  ok    ${name}`); } else {
    fail += 1; results.push(`  FAIL  ${name}  ${detail}`);
  }
}
function note(name, detail) { results.push(`  NOTE  ${name}  ${detail}`); }

function agent() {
  let cookie = '';
  return {
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
      try { data = await res.json(); } catch { /* empty */ }
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

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const pl2 = await mk('pl2');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Spells', is_public: true })).data.campaign;
  const other = (await outsider.req('POST', '/api/campaigns', { name: 'Other', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  await pl2.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const C = `/api/campaigns/${camp.id}`;
  const SP = `${C}/spells`;
  const A = `${C}/actors`;
  t('setup: campaign created', !!camp);

  const aria = (await pl.req('POST', A, { name: 'Aria' })).data.actor;
  const borin = (await pl2.req('POST', A, { name: 'Borin' })).data.actor;
  const lich = (await gm.req('POST', A, { name: 'Lich', is_npc: true })).data.actor;
  t('setup: two PCs and an NPC', !!aria && !!borin && !!lich);

  console.log('\n--- the catalogue ---');
  const mm = await gm.req('POST', SP, {
    name: 'Magic Missile', level: 1,
    description: 'Three darts of force.',
    properties: { school: 'evocation', range: '120 feet', casting_time: '1 action' },
  });
  t('the GM authors a spell', mm.status === 201, `${mm.status}`);
  t('...with its level', mm.data.spell.level === 1);
  t('...and its properties blob', mm.data.spell.properties.school === 'evocation');
  const missile = mm.data.spell;
  const cantrip = (await gm.req('POST', SP, { name: 'Fire Bolt', level: 0 })).data.spell;
  t('level 0 (a cantrip) is valid', cantrip.level === 0);
  const counter = (await gm.req('POST', SP, { name: 'Counterspell', level: 3 })).data.spell;
  t('setup: three spells in the catalogue', !!counter);

  t('a spell with no name is refused', (await gm.req('POST', SP, { level: 1 })).status === 400);
  t('level 10 is refused', (await gm.req('POST', SP, { name: 'X', level: 10 })).status === 400);
  t('level -1 is refused', (await gm.req('POST', SP, { name: 'X', level: -1 })).status === 400);
  t('an array level is refused (type confusion)',
    (await gm.req('POST', SP, { name: 'X', level: [[3]] })).status === 400);
  t('an array properties blob is refused',
    (await gm.req('POST', SP, { name: 'X', properties: [1, 2] })).status === 400);
  t('an oversized properties blob is refused',
    (await gm.req('POST', SP, { name: 'X', properties: { a: 'x'.repeat(9000) } })).status === 400);

  console.log('\n--- the catalogue is NOT confidential, deliberately ---');
  const plCat = await pl.req('GET', SP);
  t('a player reads the catalogue', plCat.status === 200 && plCat.data.spells.length >= 3);
  const seenMM = plCat.data.spells.find((s) => s.id === missile.id);
  t('...in full, description included', seenMM && seenMM.description === 'Three darts of force.');
  note('why no `identified`', 'a player must read what a spell does in order to cast it');
  t('the list is sorted by level then name',
    plCat.data.spells[0].level <= plCat.data.spells[1].level);
  const filtered = await pl.req('GET', `${SP}?level=1`);
  t('the level filter works', filtered.status === 200
    && filtered.data.spells.every((s) => s.level === 1));
  t('a bad level filter is refused', (await pl.req('GET', `${SP}?level=99`)).status === 400);

  console.log('\n--- BFLA: players do not author the catalogue ---');
  t('a player cannot author a spell',
    (await pl.req('POST', SP, { name: 'Wish', level: 9 })).status === 403);
  t('a player cannot edit one',
    (await pl.req('PATCH', `${SP}/${missile.id}`, { level: 9 })).status === 403);
  t('a player cannot delete one',
    (await pl.req('DELETE', `${SP}/${missile.id}`)).status === 403);
  const intact = await knex('spells').where({ id: missile.id }).first();
  t('no player write left a trace', intact.level === 1);

  console.log('\n--- BOLA: cross-campaign ---');
  t('a non-member cannot list spells -> 404 (no existence leak)',
    (await outsider.req('GET', SP)).status === 404);
  t('a non-member cannot read one -> 404', (await outsider.req('GET', `${SP}/${missile.id}`)).status === 404);
  t('a spell cannot be reached through another campaign -> 404',
    (await outsider.req('GET', `/api/campaigns/${other.id}/spells/${missile.id}`)).status === 404);
  t('a malformed spell id -> 404, not 500', (await pl.req('GET', `${SP}/not-a-uuid`)).status === 404);

  console.log('\n--- spellbooks: a player fills their own ---');
  const learn = await pl.req('POST', `${A}/${aria.id}/spells`, {
    spell_id: missile.id, source: 'class',
  });
  t('a player learns a spell', learn.status === 201, `${learn.status}`);
  t('prepared defaults to false', learn.data.entry.prepared === false);
  t('source is stored', learn.data.entry.source === 'class');
  const book = await pl.req('GET', `${A}/${aria.id}/spells`);
  t('the spellbook lists it with the spell attached',
    book.status === 200 && book.data.spells[0].spell.name === 'Magic Missile');

  const again = await pl.req('POST', `${A}/${aria.id}/spells`, { spell_id: missile.id });
  t('learning a known spell is a no-op, not a duplicate or a 500',
    again.status === 201, `${again.status}`);
  const rows = Number((await knex('actor_spells')
    .where({ actor_id: aria.id, spell_id: missile.id }).count({ n: '*' }).first()).n);
  t('...and exactly one row exists (composite PK)', rows === 1, `${rows}`);

  console.log('\n--- prepared is a CHECKBOX, not a computation ---');
  const prep = await pl.req('PATCH', `${A}/${aria.id}/spells/${missile.id}`, { prepared: true });
  t('a player prepares a spell', prep.status === 200 && prep.data.entry.prepared === true);
  // Learn and prepare everything available. If the server counted preparations
  // against a limit, one of these would be refused.
  await pl.req('POST', `${A}/${aria.id}/spells`, { spell_id: cantrip.id, source: 'race' });
  await pl.req('POST', `${A}/${aria.id}/spells`, { spell_id: counter.id, source: 'item' });
  const p2 = await pl.req('PATCH', `${A}/${aria.id}/spells/${cantrip.id}`, { prepared: true });
  const p3 = await pl.req('PATCH', `${A}/${aria.id}/spells/${counter.id}`, { prepared: true });
  t('EVERY spell can be prepared at once — no limit is computed',
    p2.status === 200 && p3.status === 200,
    'a preparation limit would be the 5e rules engine this project excludes');
  const preparedCount = Number((await knex('actor_spells')
    .where({ actor_id: aria.id, prepared: true }).count({ n: '*' }).first()).n);
  t('...and all three are prepared', preparedCount === 3, `${preparedCount}`);
  t('a level-3 spell on a level-1 character is accepted — the server does not check',
    (await knex('actor_spells').where({ actor_id: aria.id, spell_id: counter.id }).first()) !== undefined);
  note('rules boundary', 'source is recorded and never interpreted; race spells are not exempted from anything');

  t('an unknown source is refused',
    (await pl.req('PATCH', `${A}/${aria.id}/spells/${missile.id}`, { source: 'divine' })).status === 400);
  t('a non-boolean prepared is refused',
    (await pl.req('PATCH', `${A}/${aria.id}/spells/${missile.id}`, { prepared: 'yes' })).status === 400);
  t('an empty PATCH is refused',
    (await pl.req('PATCH', `${A}/${aria.id}/spells/${missile.id}`, {})).status === 400);

  console.log('\n--- THE DOOR: an NPC spellbook is the GM\'s preparation ---');
  await gm.req('POST', `${A}/${lich.id}/spells`, { spell_id: counter.id, source: 'class' });
  const peek = await pl.req('GET', `${A}/${lich.id}/spells`);
  t('a player CANNOT read an NPC spellbook -> 404 (M4 V2 shape, gate reused)',
    peek.status === 404, `${peek.status}`);
  t('...and the refusal is 404, not 403 (no enumeration oracle)', peek.status === 404);
  t('...and carries no spell data at all',
    !peek.data || !peek.data.spells, JSON.stringify(peek.data));
  const write = await pl.req('POST', `${A}/${lich.id}/spells`, { spell_id: missile.id });
  t('a player cannot ADD to an NPC spellbook', write.status === 404, `${write.status}`);
  const lichRows = Number((await knex('actor_spells')
    .where({ actor_id: lich.id }).count({ n: '*' }).first()).n);
  t('...and the NPC spellbook is unchanged', lichRows === 1, `${lichRows}`);
  t('the GM still reads it in full',
    (await gm.req('GET', `${A}/${lich.id}/spells`)).data.spells.length === 1);

  console.log('\n--- a player character\'s spellbook IS shared (recorded non-claim) ---');
  const peer = await pl2.req('GET', `${A}/${aria.id}/spells`);
  t('another player reads a PC spellbook', peer.status === 200 && peer.data.spells.length === 3);
  note('deliberate', 'the party shares a table — the same non-claim recorded for actor sheets and bags');
  t('but cannot WRITE to it (403, and that is not an oracle)',
    (await pl2.req('POST', `${A}/${aria.id}/spells`, { spell_id: missile.id })).status === 403);
  t('nor delete from it',
    (await pl2.req('DELETE', `${A}/${aria.id}/spells/${missile.id}`)).status === 403);

  console.log('\n--- BOLA / BOPLA on the spellbook ---');
  t('a spell from another campaign cannot be learned -> 404',
    (await gm.req('POST', `${A}/${aria.id}/spells`, {
      spell_id: (await outsider.req('POST', `/api/campaigns/${other.id}/spells`, { name: 'Foreign', level: 1 })).data.spell.id,
    })).status === 404);
  t('a missing spell_id is refused',
    (await pl.req('POST', `${A}/${aria.id}/spells`, {})).status === 400);
  t('a non-uuid spell_id is refused',
    (await pl.req('POST', `${A}/${aria.id}/spells`, { spell_id: 'x' })).status === 400);
  t('forgetting a spell the character never knew -> 404',
    (await pl.req('DELETE', `${A}/${aria.id}/spells/00000000-0000-4000-8000-000000000000`)).status === 404);

  console.log('\n--- forgetting, and the cascades ---');
  const forget = await pl.req('DELETE', `${A}/${aria.id}/spells/${missile.id}`);
  t('a player forgets a spell', forget.status === 200, `${forget.status}`);
  t('...and the catalogue entry SURVIVES',
    (await pl.req('GET', `${SP}/${missile.id}`)).status === 200);

  const del = await gm.req('DELETE', `${SP}/${counter.id}`);
  t('the GM deletes a catalogue spell', del.status === 200, `${del.status}`);
  t('...and the response NAMES the spellbooks it emptied',
    del.data.deleted.spellbook_entries === 2, JSON.stringify(del.data.deleted));
  const orphans = Number((await knex('actor_spells')
    .where({ spell_id: counter.id }).count({ n: '*' }).first()).n);
  t('...leaving no orphan spellbook rows', orphans === 0, `${orphans}`);

  const delActor = await gm.req('DELETE', `${A}/${aria.id}`);
  t('deleting a character reports its spellbook size',
    delActor.data.spellbook_entries === 1, JSON.stringify(delActor.data));
  t('...and tokens_unlinked still means what it meant',
    delActor.data.tokens_unlinked === 0, `${delActor.data.tokens_unlinked}`);
  const actorOrphans = Number((await knex('actor_spells')
    .where({ actor_id: aria.id }).count({ n: '*' }).first()).n);
  t('...leaving no orphan rows', actorOrphans === 0, `${actorOrphans}`);

  console.log('\n--- API4: the spellbook cap holds EXACTLY under a race ---');
  const capActor = (await gm.req('POST', A, { name: 'Archmage', is_npc: true })).data.actor;
  const MAX = 300;
  // Fixtures via knex; only the racing writes go over HTTP.
  const fixtures = await knex('spells').insert(
    Array.from({ length: MAX + 10 }, (_, i) => ({
      campaign_id: camp.id, name: `Fixture ${i}`, level: 1,
    })),
  ).returning('id');
  await knex('actor_spells').insert(
    fixtures.slice(0, MAX - 5).map((r) => ({ actor_id: capActor.id, spell_id: r.id })),
  );
  const preload = Number((await knex('actor_spells')
    .where({ actor_id: capActor.id }).count({ n: '*' }).first()).n);
  t('setup: spellbook preloaded to exactly the cap minus five',
    preload === MAX - 5, `${preload}`);

  const racers = fixtures.slice(MAX - 5, MAX + 10);
  const outcome = await Promise.all(racers.map((r) => gm.req(
    'POST', `${A}/${capActor.id}/spells`, { spell_id: r.id },
  )));
  const accepted = outcome.filter((r) => r.status === 201).length;
  const refused = outcome.filter((r) => r.status === 409).length;
  const landed = Number((await knex('actor_spells')
    .where({ actor_id: capActor.id }).count({ n: '*' }).first()).n);
  t('the spellbook cap lands on EXACTLY its maximum under 15 parallel adds',
    landed === MAX && accepted === 5 && refused === 10,
    `landed ${landed}, accepted ${accepted}, refused ${refused}`);

  console.log('\n--- API4: the catalogue cap ---');
  const before = Number((await knex('spells')
    .where({ campaign_id: camp.id }).count({ n: '*' }).first()).n);
  await knex('spells').insert(
    Array.from({ length: 500 - before }, (_, i) => ({
      campaign_id: camp.id, name: `Filler ${i}`, level: 0,
    })),
  );
  const overCap = await gm.req('POST', SP, { name: 'One Too Many', level: 1 });
  t('the catalogue cap refuses the 501st spell', overCap.status === 409, `${overCap.status}`);
  const total = Number((await knex('spells')
    .where({ campaign_id: camp.id }).count({ n: '*' }).first()).n);
  t('...and the campaign holds exactly its maximum', total === 500, `${total}`);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  console.log(results.join('\n'));
  await knex.destroy();
  process.exit(1);
});
