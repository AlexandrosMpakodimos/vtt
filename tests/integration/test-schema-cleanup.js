// Fix 1 of the schema review (migration 20261005000000_schema_cleanup.js):
// the database states the invariants itself, the unused columns are gone, and
// copy/paste keeps a token's character link and framing.
//   Usage: node scripts/test-local.js test-schema-cleanup.js   (isolated server running)
//
// Three parts:
//   1. Catalog facts, read from pg_catalog / information_schema: dropped columns
//      absent, every NOT NULL / CHECK / index the migration declares present
//      (taken from the migration's own lists, so the test tracks the source).
//   2. Behaviour: rows that break a rule are REFUSED by PostgreSQL (23502 /
//      23514), and boundary values the validators accept are accepted. Every
//      probe runs in a transaction that is always rolled back, so nothing is
//      left behind in vtt_test.
//   3. Copy/paste over HTTP: a pasted copy of a linked token stays linked and
//      keeps inheriting; an owned framing over an inherited picture survives;
//      an unlinked token keeps its own picture and framing.
//   4. The socket ping bound, which read the dropped scenes.width/height.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('../../src/db');
const { FIXTURE_CAMPAIGN_HASH } = require('../helpers/campaignFixture');
const { io } = require('socket.io-client');
const migration = require('../../src/db/migrations/20261005000000_schema_cleanup');

const {
  TIMESTAMPS, OTHER_NOT_NULL, CHECKS, FK_INDEXES, DUPLICATE_INDEXES,
} = migration._internals;

let pass = 0; let fail = 0; const results = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  ok    ${name}`); } else {
    fail += 1; results.push(`  FAIL  ${name}  ${detail}`);
  }
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

// Run `work` in a transaction that is ALWAYS rolled back. Returns the
// PostgreSQL error code `work` raised, or null if it completed.
const ROLLBACK = new Error('rollback');
async function sqlState(work) {
  let code = null;
  try {
    await knex.transaction(async (trx) => {
      try {
        await work(trx);
      } catch (err) {
        code = err.code || 'NO_CODE';
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return code;
}

// A throwaway parent chain inside a transaction, for rows that need FKs.
async function fixtures(trx) {
  const tag = Math.random().toString(16).slice(2, 10);
  const [user] = await trx('users').insert({
    email: `schema-${tag}@example.invalid`, username: `schema${tag}`, password_hash: 'x',
  }).returning('*');
  const [campaign] = await trx('campaigns').insert({ owner_id: user.id, name: `schema ${tag}`, password_hash: FIXTURE_CAMPAIGN_HASH }).returning('*');
  const [scene] = await trx('scenes').insert({ campaign_id: campaign.id, name: 'S' }).returning('*');
  const [actor] = await trx('actors').insert({ campaign_id: campaign.id, name: 'A' }).returning('*');
  const [item] = await trx('items').insert({ campaign_id: campaign.id, name: 'I', type: 'misc' }).returning('*');
  const [spell] = await trx('spells').insert({ campaign_id: campaign.id, name: 'Sp' }).returning('*');
  const [token] = await trx('tokens').insert({ scene_id: scene.id, name: 'T' }).returning('*');
  const [combat] = await trx('combat').insert({ campaign_id: campaign.id, scene_id: scene.id }).returning('*');
  return { user, campaign, scene, actor, item, spell, token, combat };
}

// Insert one row built from the fixtures and expect `code`.
function probe(name, expected, build) {
  return { name, expected, build };
}

(async () => {
  // ------------------------------------------------------------ 1. catalog
  console.log('\n--- catalog: what the migration declares is what the database holds ---');
  const cols = await knex('information_schema.columns')
    .where({ table_schema: 'public' })
    .select('table_name', 'column_name', 'is_nullable', 'character_maximum_length');
  const col = (table, column) => cols.find((c) => c.table_name === table && c.column_name === column);

  const dropped = [
    ['campaigns', 'settings'], ['scenes', 'folder_id'], ['scenes', 'width'], ['scenes', 'height'],
    ['tokens', 'rotation'], ['tokens', 'bar1_value'], ['tokens', 'bar1_max'], ['tokens', 'conditions'],
    ['tokens', 'is_prop'], ['actors', 'folder_id'], ['items', 'folder_id'], ['inventory', 'sort_order'],
    ['combat', 'name'], ['assets', 'etag'],
  ];
  const stillThere = dropped.filter(([tb, c]) => col(tb, c));
  t(`all ${dropped.length} dropped columns are gone`, stillThere.length === 0, JSON.stringify(stillThere));
  t('combatants.sort_order (the initiative order) is kept', !!col('combatants', 'sort_order'));

  const notNull = [];
  for (const [table, list] of Object.entries(TIMESTAMPS)) list.forEach((c) => notNull.push([table, c]));
  for (const [table, list] of Object.entries(OTHER_NOT_NULL)) list.forEach((c) => notNull.push([table, c]));
  const tsCount = Object.values(TIMESTAMPS).reduce((n, l) => n + l.length, 0);
  t('the migration covers all 33 created_at/updated_at columns', tsCount === 33, String(tsCount));
  const nullable = notNull.filter(([tb, c]) => !col(tb, c) || col(tb, c).is_nullable !== 'NO');
  t(`all ${notNull.length} required columns are NOT NULL`, nullable.length === 0, JSON.stringify(nullable));

  // No bookkeeping timestamp anywhere in the app schema is left nullable.
  const looseTs = cols.filter((c) => ['created_at', 'updated_at', 'joined_at'].includes(c.column_name)
    && c.is_nullable === 'YES' && !c.table_name.startsWith('knex_'));
  t('no created_at/updated_at/joined_at column is nullable', looseTs.length === 0,
    JSON.stringify(looseTs.map((c) => `${c.table_name}.${c.column_name}`)));
  t('email_verification_tokens.purpose is varchar(20)',
    Number(col('email_verification_tokens', 'purpose').character_maximum_length) === 20);

  const cons = (await knex.raw(`SELECT conname, convalidated FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND contype = 'c'`)).rows;
  const missingChecks = CHECKS.filter(([, name]) => !cons.some((c) => c.conname === name && c.convalidated));
  t(`all ${CHECKS.length} CHECK constraints exist and are validated`, missingChecks.length === 0,
    JSON.stringify(missingChecks.map((c) => c[1])));

  const idx = (await knex.raw(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname);
  const missingIdx = FK_INDEXES.filter((i) => !idx.includes(i.name));
  t(`all ${FK_INDEXES.length} foreign-key indexes exist`, missingIdx.length === 0, JSON.stringify(missingIdx));
  const dupLeft = DUPLICATE_INDEXES.filter(([, , name]) => idx.includes(name));
  t(`all ${DUPLICATE_INDEXES.length} duplicate indexes are gone`, dupLeft.length === 0, JSON.stringify(dupLeft));
  // Each dropped index is still covered by a key whose LEADING column is its column.
  const keyDefs = (await knex.raw(`SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`)).rows;
  const uncovered = DUPLICATE_INDEXES.filter(([table, column]) => !keyDefs.some((k) => k.tablename === table
    && new RegExp(`\\(${column}, `).test(k.indexdef)));
  t('every dropped index is still served by a composite key', uncovered.length === 0, JSON.stringify(uncovered));

  // ---------------------------------------------------------- 2. behaviour
  console.log('\n--- behaviour: the database refuses what the validators refuse ---');
  const NOT_NULL = '23502';
  const CHECK = '23514';
  const probes = [
    probe('users.created_at NULL', NOT_NULL, (f, trx) => trx('users').insert({
      email: 'n@example.invalid', username: 'nullts', password_hash: 'x', created_at: null })),
    probe('tokens.updated_at NULL', NOT_NULL, (f, trx) => trx('tokens').where({ id: f.token.id }).update({ updated_at: null })),
    probe('campaign_members.joined_at NULL', NOT_NULL, (f, trx) => trx('campaign_members').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, joined_at: null })),
    probe('messages.speaker_name NULL', NOT_NULL, (f, trx) => trx('messages').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, speaker_role: 'gm', content: 'x' })),
    probe('messages.speaker_role NULL', NOT_NULL, (f, trx) => trx('messages').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, speaker_name: 'n', content: 'x' })),
    probe('storage_cleanup.next_attempt_at NULL', NOT_NULL, (f, trx) => trx('storage_cleanup').insert({
      storage_key: 'k', reason: 'delete_failed', next_attempt_at: null })),
    probe('verification purpose outside the set', CHECK, (f, trx) => trx('email_verification_tokens').insert({
      user_id: f.user.id, token_hash: 'h', expires_at: knex.fn.now(), purpose: 'admin' })),
    probe('member colour not a hex value', CHECK, (f, trx) => trx('campaign_members').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, color: 'red' })),
    probe('token of zero size', CHECK, (f, trx) => trx('tokens').where({ id: f.token.id }).update({ width: 0 })),
    probe('token far off the grid', CHECK, (f, trx) => trx('tokens').where({ id: f.token.id }).update({ x: 10001 })),
    probe('token scale out of range', CHECK, (f, trx) => trx('tokens').where({ id: f.token.id }).update({ img_scale: 9 })),
    probe('avatar offset out of range', CHECK, (f, trx) => trx('users').where({ id: f.user.id }).update({ avatar_offset_x: 3 })),
    probe('fog type outside the set', CHECK, (f, trx) => trx('fog_of_war').insert({
      scene_id: f.scene.id, type: 'hex', points: JSON.stringify([]) })),
    probe('actor level 0', CHECK, (f, trx) => trx('actors').where({ id: f.actor.id }).update({ level: 0 })),
    probe('actor hp_max negative', CHECK, (f, trx) => trx('actors').where({ id: f.actor.id }).update({ hp_max: -1 })),
    probe('actor strength 31', CHECK, (f, trx) => trx('actors').where({ id: f.actor.id }).update({ strength: 31 })),
    probe('actor death saves 11', CHECK, (f, trx) => trx('actors').where({ id: f.actor.id }).update({ death_save_failures: 11 })),
    probe('actor size outside the set', CHECK, (f, trx) => trx('actors').where({ id: f.actor.id }).update({ size: 'medium' })),
    probe('item type outside the set', CHECK, (f, trx) => trx('items').where({ id: f.item.id }).update({ type: 'ring' })),
    probe('item weight negative', CHECK, (f, trx) => trx('items').where({ id: f.item.id }).update({ weight: -1 })),
    probe('inventory quantity 0', CHECK, (f, trx) => trx('inventory').insert({
      actor_id: f.actor.id, item_id: f.item.id, quantity: 0 })),
    probe('spell level 10', CHECK, (f, trx) => trx('spells').where({ id: f.spell.id }).update({ level: 10 })),
    probe('spell source outside the set', CHECK, (f, trx) => trx('actor_spells').insert({
      actor_id: f.actor.id, spell_id: f.spell.id, source: 'feat' })),
    probe('combat round 0', CHECK, (f, trx) => trx('combat').where({ id: f.combat.id }).update({ round: 0 })),
    probe('combat turn_index negative', CHECK, (f, trx) => trx('combat').where({ id: f.combat.id }).update({ turn_index: -1 })),
    probe('combatant hp_override beyond the bound', CHECK, (f, trx) => trx('combatants').insert({
      combat_id: f.combat.id, token_id: f.token.id, hp_override: 10000 })),
    probe('message with neither text nor roll', CHECK, (f, trx) => trx('messages').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, speaker_name: 'n', speaker_role: 'gm' })),
    probe('message speaker_role outside the set', CHECK, (f, trx) => trx('messages').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, speaker_name: 'n', speaker_role: 'admin', content: 'x' })),
    probe('asset status outside the set', CHECK, (f, trx) => trx('assets').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, url: 'https://example.invalid/x.png',
      kind: 'map', status: 'served' })),
    probe('asset kind outside the set', CHECK, (f, trx) => trx('assets').insert({
      campaign_id: f.campaign.id, user_id: f.user.id, url: 'https://example.invalid/x.png',
      kind: 'banner', status: 'ready' })),
    probe('budget period_source outside the set', CHECK, (f, trx) => trx('storage_budget').where({ id: true }).update({ period_source: 'guess' })),
    probe('cleanup reason outside the set', CHECK, (f, trx) => trx('storage_cleanup').insert({
      storage_key: 'k', reason: 'because' })),
  ];
  for (const p of probes) {
    // eslint-disable-next-line no-await-in-loop
    const code = await sqlState(async (trx) => { const f = await fixtures(trx); await p.build(f, trx); });
    t(`refused (${p.expected}): ${p.name}`, code === p.expected, `got ${code}`);
  }
  // Every CHECK has at least one refusal probe above, by constraint table.
  const probedTables = new Set(['email_verification_tokens', 'campaign_members', 'tokens', 'users', 'fog_of_war',
    'actors', 'items', 'inventory', 'spells', 'actor_spells', 'combat', 'combatants', 'messages', 'assets',
    'storage_budget', 'storage_cleanup']);
  t('every table with a CHECK has a refusal probe', CHECKS.every(([table]) => probedTables.has(table)));

  console.log('\n--- behaviour: the validators\' own boundary values are accepted ---');
  const edges = await sqlState(async (trx) => {
    const f = await fixtures(trx);
    await trx('actors').where({ id: f.actor.id }).update({
      level: 20, hp_current: -9999, hp_max: 9999, hp_temp: 0, armor_class: 99, speed: 999,
      strength: 30, dexterity: 1, death_save_successes: 10, size: 'Gargantuan',
      img_offset_x: -2, img_offset_y: 2, img_scale: 0.1,
    });
    await trx('tokens').where({ id: f.token.id }).update({
      width: 0.1, height: 100, x: -10000, y: 10000, img_offset_x: null, img_scale: null,
    });
    await trx('items').where({ id: f.item.id }).update({ weight: 10000, type: 'weapon' });
    await trx('inventory').insert({ actor_id: f.actor.id, item_id: f.item.id, quantity: 9999 });
    await trx('actor_spells').insert({ actor_id: f.actor.id, spell_id: f.spell.id, source: null });
    await trx('combat').where({ id: f.combat.id }).update({ round: 9999, turn_index: 0 });
    await trx('combatants').insert({ combat_id: f.combat.id, token_id: f.token.id, hp_override: -9999, sort_order: 9999 });
    await trx('campaign_members').insert({ campaign_id: f.campaign.id, user_id: f.user.id, color: '#A1b2C3' });
    await trx('messages').insert({ campaign_id: f.campaign.id, user_id: null, speaker_name: 'n',
      speaker_role: 'player', content: null, roll_data: JSON.stringify({ total: 1 }) });
    await trx('email_verification_tokens').insert({
      user_id: f.user.id, token_hash: 'h', expires_at: knex.fn.now(), purpose: 'email_change' });
  });
  t('boundary values, NULL-as-absent and a roll-only message are all accepted', edges === null, `got ${edges}`);

  // ------------------------------------------------------ 3. copy / paste
  console.log('\n--- copy/paste keeps the character link and framing ---');
  const gm = await mk('schemagm');
  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Schema cleanup', is_public: true })).data.campaign;
  const scene = (await gm.req('POST', `/api/campaigns/${camp.id}/scenes`, { name: 'Board' })).data.scene;
  const S = `/api/campaigns/${camp.id}/scenes/${scene.id}`;
  const A = `/api/campaigns/${camp.id}/actors`;
  const actor = (await gm.req('POST', A, {
    name: 'Goblin', is_npc: true, img_url: 'https://example.com/goblin.png', size: 'Large',
  })).data.actor;
  await gm.req('PATCH', `${A}/${actor.id}`, { img_offset_x: 0.1, img_offset_y: 0.2, img_scale: 1.5 });
  t('setup: framed character', !!actor);

  const linked = (await gm.req('POST', `${S}/tokens`, { actor_id: actor.id, x: 1, y: 1 })).data.token;
  t('setup: a placed linked token inherits picture and framing',
    linked.img_inherited === true && linked.frame_inherited === true && linked.img_scale === 1.5);
  const reframed = (await gm.req('POST', `${S}/tokens`, { actor_id: actor.id, x: 2, y: 1, name: 'Goblin 2' })).data.token;
  const rf = await gm.req('PATCH', `${S}/tokens/${reframed.id}`, { img_offset_x: 0.3, img_offset_y: -0.4, img_scale: 2 });
  t('setup: a linked token re-framed over its inherited picture',
    rf.status === 200 && rf.data.token.img_inherited === true && rf.data.token.frame_inherited === false);
  const door = (await gm.req('POST', `${S}/tokens`, {
    name: 'Door', img_url: 'https://example.com/door.png', img_offset_y: 0.25, img_scale: 1.2, x: 3, y: 1, hidden: true,
  })).data.token;
  t('setup: an unlinked token with its own framed picture', door.img_scale === 1.2 && door.actor_id === null);

  // The specs the client's snapshotToken now produces for these three.
  const pasted = await gm.req('POST', `${S}/tokens/copy`, {
    tokens: [
      { actor_id: actor.id, name: 'Goblin', width: 2, height: 2, hidden: false, x: 5, y: 5 },
      { actor_id: actor.id, name: 'Goblin 2', width: 2, height: 2, hidden: false, x: 6, y: 5,
        img_offset_x: 0.3, img_offset_y: -0.4, img_scale: 2 },
      { name: 'Door', img_url: 'https://example.com/door.png', width: 1, height: 1, hidden: true, x: 7, y: 5,
        img_offset_x: 0, img_offset_y: 0.25, img_scale: 1.2 },
    ],
  });
  t('paste succeeds', pasted.status === 201, `${pasted.status} ${JSON.stringify(pasted.data)}`);
  const [c1, c2, c3] = pasted.data.tokens || [];
  t('the copy of a linked token is still linked', c1 && c1.actor_id === actor.id, JSON.stringify(c1));
  t('...and still INHERITS picture and framing (nothing baked in)',
    c1 && c1.img_inherited === true && c1.frame_inherited === true, JSON.stringify(c1));
  const raw1 = c1 && await knex('tokens').where({ id: c1.id }).first();
  t('...its stored picture and framing are NULL (the inherit state)',
    raw1 && raw1.img_url === null && raw1.img_scale === null && raw1.img_offset_x === null);
  t('the re-framed copy keeps its own framing over the inherited picture',
    c2 && c2.actor_id === actor.id && c2.img_inherited === true && c2.frame_inherited === false
      && c2.img_offset_x === 0.3 && c2.img_offset_y === -0.4 && c2.img_scale === 2, JSON.stringify(c2));
  t('the unlinked copy keeps its own picture, framing and hidden flag',
    c3 && c3.actor_id === null && c3.img_url && c3.img_url.endsWith('/door.png')
      && c3.img_offset_y === 0.25 && c3.img_scale === 1.2 && c3.hidden === true, JSON.stringify(c3));

  // The point of keeping the link: a later change to the character reaches the copy.
  await gm.req('PATCH', `${A}/${actor.id}`, { img_url: 'https://example.com/goblin-wounded.png', img_scale: 1.1 });
  const board = (await gm.req('GET', S)).data.tokens;
  const after1 = board.find((x) => x.id === c1.id);
  const after2 = board.find((x) => x.id === c2.id);
  t('a later portrait change reaches the pasted copy',
    after1 && after1.img_url.endsWith('/goblin-wounded.png') && after1.img_scale === 1.1, JSON.stringify(after1));
  t('...and the re-framed copy takes the new picture but keeps its own framing',
    after2 && after2.img_url.endsWith('/goblin-wounded.png') && after2.img_scale === 2, JSON.stringify(after2));

  // ------------------------------------------------- 4. ping bound (socket)
  // scene:ping bounds x/y to the scene. It used to read scenes.width/height;
  // with those dropped it must use the server constants, or the bound would
  // silently become NaN and accept any coordinate.
  console.log('\n--- scene:ping is still bounded to the 1400x1050 canvas ---');
  const sock = io(BASE, { extraHeaders: { Cookie: gm.cookie }, transports: ['websocket'], forceNew: true });
  await new Promise((res, rej) => {
    sock.on('connect', res); sock.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 3000);
  });
  const emitAck = (ev, p) => new Promise((r) => {
    sock.emit(ev, p, r); setTimeout(() => r({ ok: false, error: 'timeout' }), 3000);
  });
  await emitAck('campaign:join', { campaign_id: camp.id });
  const ping = (x, y) => emitAck('scene:ping', { campaign_id: camp.id, scene_id: scene.id, x, y });
  // 1400/50 = 28 columns, 1050/50 = 21 rows; one square of slack either side.
  const inside = await ping(28, 21);
  t('a ping on the far corner square is accepted', inside && inside.ok === true, JSON.stringify(inside));
  const outX = await ping(30, 1);
  t('a ping past the right edge is refused', outX && outX.ok === false && /outside/.test(outX.error), JSON.stringify(outX));
  const outY = await ping(1, 23);
  t('a ping past the bottom edge is refused', outY && outY.ok === false && /outside/.test(outY.error), JSON.stringify(outY));
  const far = await ping(5000, 5000);
  t('a far-away ping is refused (the bound is not NaN)', far && far.ok === false, JSON.stringify(far));
  sock.close();

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
