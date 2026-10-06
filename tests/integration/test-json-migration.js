// Fix 2 of the schema review (migration 20261006000000_json_schemas.js):
// server-side schemas for actors.data, items.properties and spells.properties,
// and item image framing as three columns.
//   Usage: node scripts/test-local.js test-json-migration.js   (isolated server running)
//
// Four parts:
//   1. Catalog facts: the three framing columns (type, NOT NULL, defaults) and
//      the four CHECKs, with each key allow-list read back from PostgreSQL and
//      compared with the server schema in validators.js.
//   2. Database refusals: a row with an unknown key, a non-object document or
//      out-of-range framing is refused (23514) whoever writes it; the boundary
//      values are accepted. Every probe is rolled back.
//   3. The migration itself, down and up again inside a transaction that is
//      rolled back: legacy rows (unknown keys, framing inside properties,
//      numeric strings, false flags, padded text) come out exactly as the
//      validator would store them, updated_at untouched; a row with a value the
//      rules refuse stops the migration with the schema unchanged.
//   4. Over HTTP: unknown keys dropped and absent from responses, typed keys
//      refused with the key named, item framing written and projected as columns
//      (an unidentified item's player view carries framing and no properties).

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('../../src/db');
const { FIXTURE_CAMPAIGN_HASH } = require('../helpers/campaignFixture');
const v = require('../../src/services/validators');
const migration = require('../../src/db/migrations/20261006000000_json_schemas');

const { DOCUMENTS, ITEMS_FRAME_CHECK, FRAME_KEYS } = migration._internals;
// jsonb does not keep JavaScript's key order: compare documents canonically.
const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
const SCHEMA_OF = { actors: v.ACTOR_DATA_SCHEMA, items: v.ITEM_PROPERTIES_SCHEMA, spells: v.SPELL_PROPERTIES_SCHEMA };

let pass = 0; let fail = 0; const results = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  ok    ${name}`); } else {
    fail += 1; results.push(`  FAIL  ${name}  ${detail}`);
  }
}

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

const ROLLBACK = new Error('rollback');
// Run `work` in a transaction that is ALWAYS rolled back; returns what it
// returned, or { code } for the error it raised.
async function rolledBack(work) {
  let out;
  try {
    await knex.transaction(async (trx) => {
      try { out = await work(trx); } catch (err) { out = { code: err.code || 'NO_CODE', err }; }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return out;
}

async function parents(trx) {
  const tag = Math.random().toString(16).slice(2, 10);
  const [user] = await trx('users').insert({
    email: `json-${tag}@example.invalid`, username: `json${tag}`, password_hash: 'x',
  }).returning('*');
  const [campaign] = await trx('campaigns').insert({ owner_id: user.id, name: `json ${tag}`, password_hash: FIXTURE_CAMPAIGN_HASH }).returning('*');
  return { user, campaign };
}

// The key list inside a CHECK definition: ARRAY['a'::text, 'b'::text, ...].
function keysFromCheck(def) {
  const m = /ARRAY\[(.*?)\]/.exec(def || '');
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null;
}

(async () => {
  // ------------------------------------------------------------ 1. catalog
  console.log('\n--- catalog ---');
  const cols = await knex('information_schema.columns')
    .where({ table_schema: 'public', table_name: 'items' })
    .whereIn('column_name', FRAME_KEYS)
    .select('column_name', 'is_nullable', 'data_type', 'numeric_precision', 'numeric_scale', 'column_default');
  for (const [key, def] of [['img_offset_x', '0'], ['img_offset_y', '0'], ['img_scale', '1']]) {
    const c = cols.find((x) => x.column_name === key);
    t(`items.${key} is numeric(6,3) NOT NULL DEFAULT ${def}`,
      c && c.data_type === 'numeric' && c.numeric_precision === 6 && c.numeric_scale === 3
      && c.is_nullable === 'NO' && String(c.column_default).replace(/'|::numeric/g, '') === def, JSON.stringify(c));
  }
  const checks = await knex.raw(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'c' AND conname = ANY(?)`,
  [[ITEMS_FRAME_CHECK, ...DOCUMENTS.map((d) => d.check)]]);
  const byName = Object.fromEntries(checks.rows.map((r) => [r.conname, r]));
  t('items_frame_check exists on items and covers all three columns (ranges are probed in part 2)',
    byName[ITEMS_FRAME_CHECK] && byName[ITEMS_FRAME_CHECK].tbl === 'items'
    && FRAME_KEYS.every((k) => byName[ITEMS_FRAME_CHECK].def.includes(k)), byName[ITEMS_FRAME_CHECK] && byName[ITEMS_FRAME_CHECK].def);
  for (const { table, column, check } of DOCUMENTS) {
    const row = byName[check];
    const keys = row && keysFromCheck(row.def);
    t(`${check} exists on ${table}`, !!row && row.tbl === table, JSON.stringify(row));
    t(`${check}: the database key allow-list is exactly the server schema of ${table}.${column}`,
      JSON.stringify(keys) === JSON.stringify(Object.keys(SCHEMA_OF[table]).sort()),
      `db: ${keys && keys.length} keys, server: ${Object.keys(SCHEMA_OF[table]).length}`);
  }
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/startupChecks.js'), 'utf8');
    const line = src.split('\n').find((l) => l.trim().startsWith('items:')) || '';
    t('the startup schema probe names the three framing columns', FRAME_KEYS.every((k) => line.includes(`"${k}"`)), line);
  }

  // ------------------------------------------------------------ 2. refusals
  console.log('\n--- database refusals ---');
  const probes = [
    ['an unknown key in actors.data', (trx, p) => trx('actors').insert({ campaign_id: p.campaign.id, name: 'A', data: JSON.stringify({ familiar: 'owl' }) }), '23514'],
    ['an array as actors.data', (trx, p) => trx('actors').insert({ campaign_id: p.campaign.id, name: 'A', data: JSON.stringify([1]) }), '23514'],
    ['a string as actors.data', (trx, p) => trx('actors').insert({ campaign_id: p.campaign.id, name: 'A', data: JSON.stringify('x') }), '23514'],
    ['an unknown key in items.properties', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', properties: JSON.stringify({ homebrew: true }) }), '23514'],
    ['framing inside items.properties', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', properties: JSON.stringify({ img_scale: 2 }) }), '23514'],
    ['an unknown key in spells.properties', (trx, p) => trx('spells').insert({ campaign_id: p.campaign.id, name: 'S', properties: JSON.stringify({ ritual: true }) }), '23514'],
    ['item img_scale 5.001', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', img_scale: 5.001 }), '23514'],
    ['item img_scale 0.09', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', img_scale: 0.09 }), '23514'],
    ['item img_offset_x -2.001', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', img_offset_x: -2.001 }), '23514'],
    ['item img_offset_y NULL', (trx, p) => trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', img_offset_y: null }), '23502'],
    ['every allowed actor key, and boundary framing on an item', async (trx, p) => {
      const all = Object.fromEntries(Object.entries(v.ACTOR_DATA_SCHEMA).map(([k, s]) => [k, s.type === 'bool' ? true : s.type === 'int' ? s.max : 'x']));
      await trx('actors').insert({ campaign_id: p.campaign.id, name: 'A', data: JSON.stringify(all) });
      await trx('items').insert({ campaign_id: p.campaign.id, name: 'I', type: 'misc', img_offset_x: -2, img_offset_y: 2, img_scale: 0.1, properties: JSON.stringify({ rarity: 'rare' }) });
      await trx('items').insert({ campaign_id: p.campaign.id, name: 'I2', type: 'misc', img_scale: 5 });
      await trx('spells').insert({ campaign_id: p.campaign.id, name: 'S', properties: JSON.stringify({ school: 'evocation', range: 'Self' }) });
    }, null],
  ];
  for (const [name, work, expected] of probes) {
    const r = await rolledBack(async (trx) => { const p = await parents(trx); await work(trx, p); return null; });
    const code = r && r.code ? r.code : null;
    t(expected ? `refused by the database (${expected}): ${name}` : `accepted by the database: ${name}`, code === expected, `got ${code}`);
  }

  // ------------------------------------------------------------ 3. the migration
  console.log('\n--- the migration: down, legacy rows, up (rolled back) ---');
  const migrated = await rolledBack(async (trx) => {
    const p = await parents(trx);
    await migration.down(trx);
    const stamp = new Date('2026-01-02T03:04:05Z');
    const [actor] = await trx('actors').insert({
      campaign_id: p.campaign.id, name: 'Legacy',
      data: JSON.stringify({ familiar: 'owl', slots: { 1: 3 }, gp: '120', sk_stealth: ' +7 ', sk_stealth_p: true, sv_str_p: false, background: '', ideals: 'Freedom' }),
      updated_at: stamp,
    }).returning('*');
    const [clean] = await trx('actors').insert({ campaign_id: p.campaign.id, name: 'Clean', data: JSON.stringify({ gp: 5 }), updated_at: stamp }).returning('*');
    const [framed] = await trx('items').insert({
      campaign_id: p.campaign.id, name: 'Framed', type: 'weapon',
      properties: JSON.stringify({ img_offset_x: 0.25, img_offset_y: '-0.5', img_scale: 1.75, damage: '1d8', rarity: 'Rare', homebrew: 1 }),
      updated_at: stamp,
    }).returning('*');
    const [plainItem] = await trx('items').insert({ campaign_id: p.campaign.id, name: 'Plain', type: 'misc', properties: JSON.stringify({ magical: true }) }).returning('*');
    const [spell] = await trx('spells').insert({ campaign_id: p.campaign.id, name: 'Old', properties: JSON.stringify({ school: 'Evocation', concentration: true, range: '60 ft' }) }).returning('*');

    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try { await migration.up(trx); } finally { console.log = orig; }

    const read = async (table, id) => trx(table).where({ id }).first();
    return {
      logs,
      actor: await read('actors', actor.id), clean: await read('actors', clean.id),
      framed: await read('items', framed.id), plainItem: await read('items', plainItem.id),
      spell: await read('spells', spell.id), stamp,
      everyActor: (await trx('actors').select('data')).map((r) => r.data),
      everyItem: (await trx('items').select('properties')).map((r) => r.properties),
      everySpell: (await trx('spells').select('properties')).map((r) => r.properties),
    };
  });
  if (migrated && migrated.code) {
    t('the migration runs down and up on legacy rows', false, `${migrated.code} ${migrated.err && migrated.err.message}`);
  } else {
    const m = migrated;
    t('unknown actor keys are removed, known ones kept and normalised',
      canon(m.actor.data) === canon({ gp: 120, sk_stealth: '+7', sk_stealth_p: true, ideals: 'Freedom' })
      && m.actor.data.gp === 120 && m.actor.data.sk_stealth === '+7' && !('familiar' in m.actor.data) && !('sv_str_p' in m.actor.data) && !('background' in m.actor.data),
      JSON.stringify(m.actor.data));
    t('updated_at is not touched by the migration', m.actor.updated_at.toISOString() === m.stamp.toISOString() && m.framed.updated_at.toISOString() === m.stamp.toISOString());
    t('an already-clean row is unchanged', canon(m.clean.data) === canon({ gp: 5 }));
    t('item framing moves from properties to the columns',
      Number(m.framed.img_offset_x) === 0.25 && Number(m.framed.img_offset_y) === -0.5 && Number(m.framed.img_scale) === 1.75,
      JSON.stringify([m.framed.img_offset_x, m.framed.img_offset_y, m.framed.img_scale]));
    t('...and leaves properties with only allow-listed keys',
      JSON.stringify(Object.keys(m.framed.properties).sort()) === '["damage","rarity"]' && m.framed.properties.rarity === 'rare', JSON.stringify(m.framed.properties));
    t('an item with no framing gets the identity crop', Number(m.plainItem.img_offset_x) === 0 && Number(m.plainItem.img_offset_y) === 0 && Number(m.plainItem.img_scale) === 1);
    t('spell properties keep the schema keys, school normalised',
      canon(m.spell.properties) === canon({ range: '60 ft', school: 'evocation' }),
      JSON.stringify(m.spell.properties));
    const stable = (arr, schema, field) => arr.every((d) => JSON.stringify(Object.keys(d).sort()) === JSON.stringify(Object.keys(v.validateJsonDocument(schema, d, field).value).sort()));
    t('after the migration EVERY row is a fixed point of the server validator',
      stable(m.everyActor, v.ACTOR_DATA_SCHEMA, 'data') && stable(m.everyItem, v.ITEM_PROPERTIES_SCHEMA, 'properties') && stable(m.everySpell, v.SPELL_PROPERTIES_SCHEMA, 'properties'));
    t('the pre-check reports counts per table before changing anything',
      m.logs.some((l) => /^JSON_SCHEMAS_PRECHECK: actors\.data: \d+ rows, \d+ to rewrite, \d+ unknown key\(s\) to remove; items\.properties: .* with framing to move; spells\.properties: /.test(l)), m.logs.join(' | '));
    t('the report carries no row contents', !m.logs.join(' ').includes('owl') && !m.logs.join(' ').includes('Freedom'));
  }

  // A value the rules refuse stops the migration and changes nothing.
  const refused = await rolledBack(async (trx) => {
    const p = await parents(trx);
    await migration.down(trx);
    await trx('spells').insert({ campaign_id: p.campaign.id, name: 'Chrono', properties: JSON.stringify({ school: 'chronurgy', homebrew: true }) });
    const errs = [];
    const orig = console.error; const origLog = console.log;
    console.error = (...a) => { errs.push(a.join(' ')); }; console.log = () => {};
    let code = null;
    try {
      await trx.transaction(async (sp) => { await migration.up(sp); });
    } catch (err) { code = err.code; } finally { console.error = orig; console.log = origLog; }
    const framingCols = await trx('information_schema.columns').where({ table_schema: 'public', table_name: 'items' }).whereIn('column_name', FRAME_KEYS).count({ n: '*' });
    const left = await trx('spells').where({ name: 'Chrono', campaign_id: p.campaign.id }).first();
    return { code, errs, framingCols: Number(framingCols[0].n), left };
  });
  t('a refused value stops the migration (JSON_SCHEMAS_PRECHECK)', refused.code === 'JSON_SCHEMAS_PRECHECK', JSON.stringify(refused.code));
  t('...naming table, key and count, never the value',
    refused.errs.some((e) => e.includes('spells.properties.school: 1')) && !refused.errs.join(' ').includes('chronurgy'), refused.errs.join(' | '));
  t('...with the schema and the row unchanged', refused.framingCols === 0 && refused.left && refused.left.properties.homebrew === true);

  // ------------------------------------------------------------ 4. HTTP
  console.log('\n--- over HTTP ---');
  const gm = await mk('jsongm');
  const pl = await mk('jsonpl');
  const c = await gm.req('POST', '/api/campaigns', { name: `JSON schemas ${Date.now()}`, is_public: false, password: 'roompw' });
  const C = `/api/campaigns/${c.data.campaign.id}`;
  await pl.req('POST', `${C}/join`, { password: 'roompw' });

  const pc = await pl.req('POST', `${C}/actors`, { name: 'Aria' });
  const A = `${C}/actors/${pc.data.actor.id}`;
  const patched = await pl.req('PATCH', A, { data: { gp: '15', familiar: 'owl', sk_arcana_p: true, sk_arcana: '+5' } });
  t('a player PATCH with an unknown data key succeeds (200)', patched.status === 200, JSON.stringify(patched.data));
  t('...and the response holds only allow-listed keys',
    patched.data && canon(patched.data.actor.data) === canon({ gp: 15, sk_arcana_p: true, sk_arcana: '+5' }), JSON.stringify(patched.data && patched.data.actor.data));
  const stored = await knex('actors').where({ id: pc.data.actor.id }).first();
  t('...and so does the stored row', !('familiar' in stored.data) && stored.data.gp === 15, JSON.stringify(stored.data));
  const badType = await pl.req('PATCH', A, { data: { experience_points: 'lots' } });
  t('a typed data key with a wrong value is refused (400) and named', badType.status === 400 && /data\.experience_points/.test(badType.data.error), JSON.stringify(badType.data));
  const afterBad = await knex('actors').where({ id: pc.data.actor.id }).first();
  t('...and the refused write changed nothing', afterBad.data.gp === 15);
  const created = await gm.req('POST', `${C}/actors`, { name: 'Bo', data: { treasure: 'a ruby', junk: 1 } });
  t('creating an actor applies the same schema', created.status === 201 && JSON.stringify(created.data.actor.data) === '{"treasure":"a ruby"}', JSON.stringify(created.data));

  const I = `${C}/items`;
  const item = await gm.req('POST', I, {
    name: 'Flame Tongue', type: 'weapon', img_url: 'https://example.com/sword.png',
    img_offset_x: 0.25, img_offset_y: -0.1, img_scale: 1.5,
    properties: { damage: '2d6', rarity: 'Rare', img_scale: 4, homebrew: true },
  });
  t('an item is created with framing columns (201)', item.status === 201, JSON.stringify(item.data));
  const it = item.data.item;
  t('...framing is returned as top-level numbers', it.img_offset_x === 0.25 && it.img_offset_y === -0.1 && it.img_scale === 1.5, JSON.stringify(it));
  t('...and properties hold only allow-listed keys (framing inside properties is dropped)',
    JSON.stringify(Object.keys(it.properties).sort()) === '["damage","rarity"]' && it.properties.rarity === 'rare', JSON.stringify(it.properties));
  const row = await knex('items').where({ id: it.id }).first();
  t('the stored row has the framing in its columns', Number(row.img_offset_x) === 0.25 && Number(row.img_scale) === 1.5);
  const noFrame = await gm.req('POST', I, { name: 'Rope', type: 'misc' });
  t('an item created without framing gets the identity crop', noFrame.data.item.img_offset_x === 0 && noFrame.data.item.img_offset_y === 0 && noFrame.data.item.img_scale === 1, JSON.stringify(noFrame.data.item));
  for (const [body, what] of [[{ img_scale: 9 }, 'img_scale 9'], [{ img_scale: 0 }, 'img_scale 0'], [{ img_offset_x: 3 }, 'img_offset_x 3'], [{ img_offset_y: [1] }, 'an array offset'], [{ img_scale: true }, 'a boolean scale']]) {
    const r = await gm.req('PATCH', `${I}/${it.id}`, body);
    t(`PATCH item framing refuses ${what} (400)`, r.status === 400, JSON.stringify(r.data));
  }
  const reframed = await gm.req('PATCH', `${I}/${it.id}`, { img_offset_x: -0.5 });
  t('PATCH changes one framing column and keeps the others', reframed.status === 200 && reframed.data.item.img_offset_x === -0.5 && reframed.data.item.img_scale === 1.5, JSON.stringify(reframed.data));
  const reset = await gm.req('PATCH', `${I}/${it.id}`, { img_scale: null });
  t('a null scale resets it to 1 (validateImgScale)', reset.status === 200 && reset.data.item.img_scale === 1, JSON.stringify(reset.data));
  await gm.req('PATCH', `${I}/${it.id}`, { img_scale: 1.5 });
  const badRarity = await gm.req('PATCH', `${I}/${it.id}`, { properties: { rarity: 'mythic' } });
  t('an unknown rarity is refused (400) and named', badRarity.status === 400 && /properties\.rarity/.test(badRarity.data.error), JSON.stringify(badRarity.data));

  const plList = await pl.req('GET', I);
  const plView = plList.data.items.find((x) => x.id === it.id);
  t('a player sees the unidentified item with its framing as columns',
    plView && plView.identified === false && plView.img_offset_x === -0.5 && plView.img_scale === 1.5, JSON.stringify(plView));
  t('...and with no properties and no name at all', plView && !('properties' in plView) && !('name' in plView), JSON.stringify(plView));
  await gm.req('PATCH', `${I}/${it.id}`, { identified: true });
  const plAfter = (await pl.req('GET', `${I}/${it.id}`)).data.item;
  t('once identified, the player sees properties and framing', plAfter.properties && plAfter.properties.damage === '2d6' && plAfter.img_scale === 1.5, JSON.stringify(plAfter));

  await gm.req('POST', `${A}/inventory`, { item_id: it.id });
  const inv = await pl.req('GET', `${A}/inventory`);
  const invItem = inv.data.inventory[0] && inv.data.inventory[0].item;
  t('the inventory join carries the item framing columns', invItem && invItem.img_offset_x === -0.5 && invItem.img_scale === 1.5, JSON.stringify(invItem));

  const S = `${C}/spells`;
  const sp = await gm.req('POST', S, { name: 'Fireball', level: 3, properties: { school: 'EVOCATION', range: ' 150 feet ', ritual: true } });
  t('a spell keeps only allow-listed properties, normalised', sp.status === 201 && canon(sp.data.spell.properties) === canon({ school: 'evocation', range: '150 feet' }), JSON.stringify(sp.data));
  const custom = await gm.req('PATCH', `${S}/${sp.data.spell.id}`, { properties: { school: 'chronurgy' } });
  t('a custom school is refused (400) and named', custom.status === 400 && /properties\.school/.test(custom.data.error), JSON.stringify(custom.data));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(results.join('\n'));
  console.error('SUITE CRASHED:', e);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
