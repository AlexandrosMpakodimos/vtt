// Fix 3 of the schema review (migration 20261007000000_redundancy_cleanup.js):
// campaigns.is_public, assets.source, assets.source_url and messages.type are
// dropped (computed where the API still reports them), and combat.campaign_id
// is tied to its scene by a composite foreign key.
//   Usage: node scripts/test-local.js test-redundancy-cleanup.js   (isolated server running)
//
// Five parts:
//   1. Catalog facts: the four columns are gone; scenes has UNIQUE (id,
//      campaign_id); combat has the composite FK with ON DELETE CASCADE and no
//      longer the single-column one.
//   2. Database refusals and cascades (rolled back): a combat row naming another
//      campaign's scene is refused (23503); moving a scene that has a combat to
//      another campaign is refused; deleting a scene still removes its combats
//      and combatants.
//   3. The migration itself, down and up again inside a transaction that is
//      rolled back: down restores and backfills the columns from the computed
//      values; a campaign whose is_public disagrees with its hash, or a combat
//      row on another campaign's scene, stops up with nothing changed; values
//      that differ from the computed ones in the dropped asset/message columns
//      are reported, not refused.
//   4. The read-only dry run (scripts/redundancy-precheck.js): exit 0 on this
//      database inside a READ ONLY transaction, exit 2 on a refusal, exit 1
//      outside production, no secrets or row contents printed.
//   5. Over HTTP: is_public computed from the hash in create/detail/search,
//      the search visibility filters, PATCH to public and back, and a
//      DB-inserted private fixture still asks for its password.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('../../src/db');
const migration = require('../../src/db/migrations/20261007000000_redundancy_cleanup');
const { FIXTURE_CAMPAIGN_HASH, FIXTURE_CAMPAIGN_PASSWORD } = require('../helpers/campaignFixture');

const { SCENES_UNIQUE, COMBAT_SCENE_FK, OLD_COMBAT_SCENE_FK } = migration._internals;

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

// Runs `work` in a savepoint and returns the error code it raised (or null), so
// the enclosing rolled-back transaction stays usable.
async function codeOf(trx, work) {
  try { await trx.transaction(async (sp) => { await work(sp); }); return null; } catch (err) { return err.code || 'NO_CODE'; }
}

// Two campaigns, each with a scene; the first has a combat with a combatant.
async function parents(trx) {
  const tag = Math.random().toString(16).slice(2, 10);
  const [user] = await trx('users').insert({
    email: `fix3-${tag}@example.invalid`, username: `fix3${tag}`, password_hash: 'x',
  }).returning('*');
  const [a] = await trx('campaigns').insert({ owner_id: user.id, name: `fix3 a ${tag}`, password_hash: FIXTURE_CAMPAIGN_HASH }).returning('*');
  const [b] = await trx('campaigns').insert({ owner_id: user.id, name: `fix3 b ${tag}` }).returning('*');
  const [sceneA] = await trx('scenes').insert({ campaign_id: a.id, name: 'A' }).returning('*');
  const [sceneB] = await trx('scenes').insert({ campaign_id: b.id, name: 'B' }).returning('*');
  const [token] = await trx('tokens').insert({ scene_id: sceneA.id, name: 'T' }).returning('*');
  const [combat] = await trx('combat').insert({ campaign_id: a.id, scene_id: sceneA.id }).returning('*');
  const [combatant] = await trx('combatants').insert({ combat_id: combat.id, token_id: token.id }).returning('*');
  return { user, a, b, sceneA, sceneB, token, combat, combatant };
}

async function columnsOf(db, table, names) {
  const rows = await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: table }).whereIn('column_name', names).select('column_name');
  return rows.map((r) => r.column_name).sort();
}

async function constraint(db, table, name) {
  const { rows } = await db.raw(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
    WHERE c.conrelid = ?::regclass AND c.conname = ?`, [table, name]);
  return rows[0] ? rows[0].def : null;
}

async function quietly(work) {
  const logs = []; const errs = [];
  const log = console.log; const error = console.error;
  console.log = (...a) => { logs.push(a.join(' ')); }; console.error = (...a) => { errs.push(a.join(' ')); };
  try { return { value: await work(), logs, errs }; } finally { console.log = log; console.error = error; }
}

(async () => {
  // ------------------------------------------------------------ 1. catalog
  console.log('\n--- catalog ---');
  t('campaigns.is_public is gone', (await columnsOf(knex, 'campaigns', ['is_public'])).length === 0);
  t('assets.source and assets.source_url are gone', (await columnsOf(knex, 'assets', ['source', 'source_url'])).length === 0);
  t('messages.type is gone', (await columnsOf(knex, 'messages', ['type'])).length === 0);
  t('scenes has UNIQUE (id, campaign_id)', (await constraint(knex, 'scenes', SCENES_UNIQUE)) === 'UNIQUE (id, campaign_id)',
    String(await constraint(knex, 'scenes', SCENES_UNIQUE)));
  const fk = await constraint(knex, 'combat', COMBAT_SCENE_FK);
  t('combat has the composite FK to scenes (id, campaign_id), ON DELETE CASCADE',
    fk === 'FOREIGN KEY (scene_id, campaign_id) REFERENCES scenes(id, campaign_id) ON DELETE CASCADE', String(fk));
  t('the single-column combat.scene_id FK it replaces is gone', (await constraint(knex, 'combat', OLD_COMBAT_SCENE_FK)) === null);

  // ------------------------------------------------- 2. refusals and cascades
  console.log('\n--- database refusals and cascades (rolled back) ---');
  const db = await rolledBack(async (trx) => {
    const p = await parents(trx);
    const mismatched = await codeOf(trx, (sp) => sp('combat').insert({ campaign_id: p.b.id, scene_id: p.sceneA.id }));
    const matching = await codeOf(trx, (sp) => sp('combat').insert({ campaign_id: p.b.id, scene_id: p.sceneB.id }));
    const retarget = await codeOf(trx, (sp) => sp('combat').where({ id: p.combat.id }).update({ campaign_id: p.b.id }));
    const moveScene = await codeOf(trx, (sp) => sp('scenes').where({ id: p.sceneA.id }).update({ campaign_id: p.b.id }));
    await trx('scenes').where({ id: p.sceneA.id }).del();
    return {
      mismatched, matching, retarget, moveScene,
      combatLeft: await trx('combat').where({ id: p.combat.id }).first(),
      combatantLeft: await trx('combatants').where({ id: p.combatant.id }).first(),
    };
  });
  if (db && db.err) {
    t('refusal probes ran', false, `${db.code} ${db.err.message}`);
  } else {
    t('a combat row naming another campaign\'s scene is refused (23503)', db.mismatched === '23503', String(db.mismatched));
    t('a combat row on its own campaign\'s scene is accepted', db.matching === null, String(db.matching));
    t('re-pointing a combat at another campaign is refused (23503)', db.retarget === '23503', String(db.retarget));
    t('moving a scene that has a combat to another campaign is refused (23503)', db.moveScene === '23503', String(db.moveScene));
    t('deleting a scene still removes its combat (CASCADE kept)', db.combatLeft === undefined);
    t('...and that combat\'s combatants', db.combatantLeft === undefined);
  }

  // ------------------------------------------------------------ 3. the migration
  console.log('\n--- the migration: down, legacy rows, up (rolled back) ---');
  const round = await rolledBack(async (trx) => {
    const p = await parents(trx);
    const [upload] = await trx('assets').insert({ campaign_id: p.a.id, user_id: p.user.id, storage_key: `fix3/${p.a.id}/u.png`, url: 'https://objects.invalid/u.png', kind: 'map', status: 'ready' }).returning('*');
    const [external] = await trx('assets').insert({ campaign_id: p.a.id, user_id: p.user.id, url: 'https://example.com/e.png', kind: 'portrait', status: 'ready' }).returning('*');
    const base = { campaign_id: p.a.id, user_id: p.user.id, speaker_name: 'n', speaker_role: 'gm' };
    const [chat] = await trx('messages').insert({ ...base, content: 'hi' }).returning('*');
    const [rolled] = await trx('messages').insert({ ...base, content: 'Perception', roll_data: JSON.stringify({ formula: 'd20', results: [7], total: 7 }) }).returning('*');
    const [whisper] = await trx('messages').insert({ ...base, content: 'psst', whisper_to: [p.user.id] }).returning('*');
    const [rolledWhisper] = await trx('messages').insert({ ...base, roll_data: JSON.stringify({ formula: 'd4', results: [2], total: 2 }), whisper_to: [p.user.id] }).returning('*');

    await migration.down(trx);
    const read = (table, id) => trx(table).where({ id }).first();
    const afterDown = {
      columns: [
        ...await columnsOf(trx, 'campaigns', ['is_public']),
        ...await columnsOf(trx, 'assets', ['source', 'source_url']),
        ...await columnsOf(trx, 'messages', ['type']),
      ].sort(),
      oldFk: await constraint(trx, 'combat', OLD_COMBAT_SCENE_FK),
      newFk: await constraint(trx, 'combat', COMBAT_SCENE_FK),
      unique: await constraint(trx, 'scenes', SCENES_UNIQUE),
      a: await read('campaigns', p.a.id), b: await read('campaigns', p.b.id),
      upload: await read('assets', upload.id), external: await read('assets', external.id),
      chat: await read('messages', chat.id), rolled: await read('messages', rolled.id),
      whisper: await read('messages', whisper.id), rolledWhisper: await read('messages', rolledWhisper.id),
    };

    // A value that differs from the computed one in a dropped column is
    // reported, not refused.
    await trx('messages').where({ id: chat.id }).update({ type: 'system' });
    await trx('assets').where({ id: external.id }).update({ source_url: null });

    // A disagreeing is_public stops the migration with nothing changed.
    await trx('campaigns').where({ id: p.b.id }).update({ is_public: false });
    const refusedVisibility = await quietly(() => codeOf(trx, (sp) => migration.up(sp)));
    const stillThere = await columnsOf(trx, 'campaigns', ['is_public']);
    await trx('campaigns').where({ id: p.b.id }).update({ is_public: true });

    // So does a combat row on another campaign's scene (possible after down,
    // which restores the single-column FK).
    const [stray] = await trx('combat').insert({ campaign_id: p.b.id, scene_id: p.sceneA.id }).returning('*');
    const refusedCombat = await quietly(() => codeOf(trx, (sp) => migration.up(sp)));
    await trx('combat').where({ id: stray.id }).del();

    const upAgain = await quietly(() => codeOf(trx, (sp) => migration.up(sp)));
    return {
      afterDown, refusedVisibility, stillThere, refusedCombat, upAgain,
      afterUp: {
        columns: [
          ...await columnsOf(trx, 'campaigns', ['is_public']),
          ...await columnsOf(trx, 'assets', ['source', 'source_url']),
          ...await columnsOf(trx, 'messages', ['type']),
        ],
        newFk: await constraint(trx, 'combat', COMBAT_SCENE_FK),
        oldFk: await constraint(trx, 'combat', OLD_COMBAT_SCENE_FK),
      },
    };
  });
  if (round && round.err) {
    t('the migration runs down and up', false, `${round.code} ${round.err.message}`);
  } else {
    const d = round.afterDown;
    t('down restores the four columns', JSON.stringify(d.columns) === JSON.stringify(['is_public', 'source', 'source_url', 'type']), JSON.stringify(d.columns));
    t('down restores the single-column combat FK and removes the composite one and the UNIQUE',
      d.oldFk === 'FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE' && d.newFk === null && d.unique === null, `${d.oldFk} / ${d.newFk} / ${d.unique}`);
    t('down backfills is_public from the hash', d.a.is_public === false && d.b.is_public === true);
    t('down backfills assets.source from storage_key', d.upload.source === 'upload' && d.external.source === 'external');
    t('down backfills source_url only for external links', d.upload.source_url === null && d.external.source_url === 'https://example.com/e.png');
    t('down backfills messages.type as the old route chose it (roll > whisper > chat)',
      d.chat.type === 'chat' && d.rolled.type === 'roll' && d.whisper.type === 'whisper' && d.rolledWhisper.type === 'roll',
      [d.chat.type, d.rolled.type, d.whisper.type, d.rolledWhisper.type].join());

    const rv = round.refusedVisibility;
    t('a campaign whose is_public disagrees with its hash stops the migration (REDUNDANCY_PRECHECK)', rv.value === 'REDUNDANCY_PRECHECK', String(rv.value));
    t('...naming the check and the count, never row contents',
      rv.errs.some((e) => e.includes('campaigns.is_public <> (password_hash IS NULL): 1')) && !rv.errs.join(' ').includes('fix3'), rv.errs.join(' | '));
    t('...with the schema unchanged', JSON.stringify(round.stillThere) === '["is_public"]');
    const rc = round.refusedCombat;
    t('a combat row on another campaign\'s scene stops the migration',
      rc.value === 'REDUNDANCY_PRECHECK' && rc.errs.some((e) => e.includes('combat.campaign_id <> its scene\'s campaign_id: 1')), `${rc.value} ${rc.errs.join(' | ')}`);
    const ua = round.upAgain;
    t('with the data consistent, up runs again', ua.value === null, String(ua.value));
    t('the pre-check reports the differing dropped values without refusing',
      ua.logs.some((l) => /^REDUNDANCY_PRECHECK: .*assets\.source_url differs from the computed value: 1 \(reported only\); messages\.type differs from the computed value: 1 \(reported only\)/.test(l)),
      ua.logs.join(' | '));
    t('after up again the columns are gone and the composite FK is back',
      round.afterUp.columns.length === 0 && round.afterUp.newFk && round.afterUp.oldFk === null, JSON.stringify(round.afterUp));
  }

  // ---------------------------------------------- 4. the read-only dry run
  console.log('\n--- the read-only dry run (scripts/redundancy-precheck.js) ---');
  const { run } = require('../../scripts/redundancy-precheck');
  const env = { NODE_ENV: 'production', DIRECT_DATABASE_URL: 'postgresql://runner:sentinel-secret@ep-example.eu-central-1.aws.neon.tech/vtt?sslmode=verify-full' };
  {
    // A real PostgreSQL transaction, to prove run() opens it READ ONLY. This
    // database is already migrated, so the pre-check's own queries (which need
    // the dropped columns) are answered with zero counts; the counting itself is
    // covered by part 3 and by the fake connections below.
    const out = []; let writeCode = null; let destroyed = 0;
    const realKnex = () => ({
      transaction: (fn) => knex.transaction(async (trx) => {
        const result = await fn({ raw: async (sql) => {
          // The pre-check's queries need the dropped columns; answer them with
          // zero counts so this probe only exercises the transaction wrapper.
          if (/^SET TRANSACTION/.test(sql)) return trx.raw(sql);
          return { rows: [{ n: 0 }] };
        } });
        try { await trx.transaction((sp) => sp.raw('CREATE TEMP TABLE fix3_probe (i int)')); } catch (err) { writeCode = err.code; }
        return result;
      }),
      destroy: async () => { destroyed += 1; },
    });
    const code = await run({ env, makeKnex: realKnex, log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: exit 0 and PRECHECK_OK when nothing would be refused', code === 0 && out.includes('PRECHECK_OK: the migration can run.'), out.join(' | '));
    t('dry run: the transaction really is READ ONLY (a write is refused, 25006)', writeCode === '25006', String(writeCode));
    t('dry run: one line per check', migration._internals.CHECKS.every((c) => out.some((x) => x.startsWith(`PRECHECK ${c.name}: 0`))), out.join(' | '));
    t('dry run: the connection is closed', destroyed === 1);
  }
  function fakeKnex(counts, log) {
    return () => ({
      transaction: async (fn) => {
        let i = 0;
        const trx = {};
        trx.raw = async (sql) => { log.push(sql); if (/^SET TRANSACTION/.test(sql)) return {}; return { rows: [{ n: counts[i++] || 0 }] }; };
        return fn(trx);
      },
      destroy: async () => { log.push('destroy'); },
    });
  }
  {
    const sql = []; const out = [];
    const code = await run({ env, makeKnex: fakeKnex([2, 0, 0, 0, 0], sql), log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: a disagreeing is_public exits 2 with the check and count', code === 2
      && out.some((x) => x.startsWith('PRECHECK_REFUSED') && x.includes('campaigns.is_public <> (password_hash IS NULL): 2')), out.join(' | '));
    t('dry run: READ ONLY is set before any read', sql[0] === 'SET TRANSACTION READ ONLY', sql.join(' | '));
    t('dry run: prints no connection secret', !out.join('\n').includes('sentinel-secret'));
  }
  {
    const out = [];
    const code = await run({ env, makeKnex: fakeKnex([0, 1, 0, 0, 0], []), log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: a combat row on another campaign\'s scene exits 2', code === 2 && out.some((x) => x.includes('combat.campaign_id <> its scene\'s campaign_id: 1')), out.join(' | '));
  }
  {
    const out = [];
    const code = await run({ env, makeKnex: fakeKnex([0, 0, 3, 4, 5], []), log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: differing dropped values are reported and still exit 0', code === 0
      && out.some((x) => x === 'PRECHECK messages.type differs from the computed value: 5 (reported only)'), out.join(' | '));
  }
  {
    let created = 0; const out = [];
    const code = await run({ env: { ...env, NODE_ENV: 'test' }, makeKnex: () => { created += 1; return {}; }, error: (x) => out.push(x) });
    t('dry run: refuses a non-production environment before connecting', code === 1 && created === 0, out.join(' | '));
  }

  // ------------------------------------------------------------ 5. HTTP
  console.log('\n--- over HTTP ---');
  const gm = await mk('fix3gm');
  const pl = await mk('fix3pl');
  const tag = `Fix3 ${Date.now()}`;
  const priv = await gm.req('POST', '/api/campaigns', { name: `${tag} private`, is_public: false, password: 'roompw' });
  const pub = await gm.req('POST', '/api/campaigns', { name: `${tag} public`, is_public: true });
  t('a private campaign is reported is_public false, has_password true',
    priv.status === 201 && priv.data.campaign.is_public === false && priv.data.campaign.has_password === true, JSON.stringify(priv.data));
  t('a public campaign is reported is_public true, has_password false',
    pub.status === 201 && pub.data.campaign.is_public === true && pub.data.campaign.has_password === false, JSON.stringify(pub.data));
  t('the stored row of the public campaign has no hash', (await knex('campaigns').where({ id: pub.data.campaign.id }).first()).password_hash === null);

  const q = encodeURIComponent(tag);
  const names = (r) => (r.data && r.data.campaigns || []).map((c) => c.name).sort();
  const all = await pl.req('GET', `/api/campaigns/search?q=${q}`);
  const onlyPub = await pl.req('GET', `/api/campaigns/search?q=${q}&visibility=public`);
  const onlyPriv = await pl.req('GET', `/api/campaigns/search?q=${q}&visibility=private`);
  t('search lists both', JSON.stringify(names(all)) === JSON.stringify([`${tag} private`, `${tag} public`]), JSON.stringify(names(all)));
  t('visibility=public filters on a NULL hash', JSON.stringify(names(onlyPub)) === JSON.stringify([`${tag} public`]), JSON.stringify(names(onlyPub)));
  t('visibility=private filters on a set hash', JSON.stringify(names(onlyPriv)) === JSON.stringify([`${tag} private`]), JSON.stringify(names(onlyPriv)));
  t('search results carry the computed flag',
    all.data.campaigns.every((c) => c.is_public === (c.name === `${tag} public`) && c.has_password === !c.is_public));

  const P = `/api/campaigns/${priv.data.campaign.id}`;
  t('joining the private campaign without its password is refused', (await pl.req('POST', `${P}/join`, {})).status === 401);
  const toPublic = await gm.req('PATCH', P, { is_public: true });
  t('PATCH to public clears the hash and reports is_public true',
    toPublic.status === 200 && toPublic.data.campaign.is_public === true
    && (await knex('campaigns').where({ id: priv.data.campaign.id }).first()).password_hash === null, JSON.stringify(toPublic.data));
  t('...and the campaign is now joinable without a password', (await pl.req('POST', `${P}/join`, {})).status === 200);
  const again = await gm.req('PATCH', P, { is_public: true });
  t('PATCH with an unchanged visibility alone still succeeds', again.status === 200 && again.data.campaign.is_public === true, `${again.status}`);
  const noPw = await gm.req('PATCH', P, { is_public: false });
  t('going private without a password is still refused', noPw.status === 400);
  const toPrivate = await gm.req('PATCH', P, { is_public: false, password: 'newroom' });
  t('PATCH to private stores a hash and reports is_public false',
    toPrivate.status === 200 && toPrivate.data.campaign.is_public === false && toPrivate.data.campaign.has_password === true);
  const detail = await pl.req('GET', P);
  t('detail for a member reports the computed flag', detail.status === 200 && detail.data.campaign.is_public === false);

  // A campaign inserted straight into the database with the fixture hash, as
  // the media and storage suites do, is private and asks for that password.
  const [fx] = await knex('campaigns').insert({ owner_id: gm.id, name: `${tag} fixture`, password_hash: FIXTURE_CAMPAIGN_HASH }).returning('id');
  const fxId = fx.id || fx;
  await knex('campaign_members').insert({ campaign_id: fxId, user_id: gm.id, status: 'active' });
  t('a DB-inserted fixture with the fixture hash is private', (await pl.req('POST', `/api/campaigns/${fxId}/join`, { password: 'nope' })).status === 401);
  t('...and the fixture password opens it', (await pl.req('POST', `/api/campaigns/${fxId}/join`, { password: FIXTURE_CAMPAIGN_PASSWORD })).status === 200);

  for (const id of [priv.data.campaign.id, pub.data.campaign.id, fxId]) {
    await knex('campaigns').where({ id }).del();
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('redundancy cleanup suite crashed:', e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  try { await knex.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
