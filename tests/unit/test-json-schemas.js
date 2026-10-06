// Fix 2 (2026-10-06): server-side schemas for actors.data, items.properties and
// spells.properties. No server, no database:
//     node tests/unit/test-json-schemas.js
//
// Three things are gated here, because each is a second source of truth that
// would otherwise drift silently:
//   1. each editor's field list (client/js/sheets/*.js) against the server
//      schema in src/services/validators.js — key by key, type, length and range.
//      A field the server does not know would be dropped on every save; a server
//      key with no field would be unreachable.
//   2. the migration's FROZEN copy of the schemas against validators.js, and its
//      cleaning rules against the validator on a corpus of documents, so the
//      rows the migration leaves behind are exactly what the server would store.
//   3. the validator's own behaviour: unknown keys dropped, known keys typed and
//      bounded, absent represented one way, hostile shapes refused.

const fs = require('node:fs');
const vm = require('node:vm');
const { rootPath } = require('../helpers/paths');
const v = require('../../src/services/validators');
const migration = require('../../src/db/migrations/20261006000000_json_schemas');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) pass += 1; else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Load the three editors the way the browser does, without a DOM: their
// top-level code only defines constants and functions.
const sandbox = { window: {} };
vm.createContext(sandbox);
for (const f of ['sheet.js', 'itemsheet.js', 'spellsheet.js']) {
  vm.runInContext(fs.readFileSync(rootPath(`client/js/sheets/${f}`), 'utf8'), sandbox, { filename: f });
}
const { VTTSheet, VTTItemSheet, VTTSpellSheet } = sandbox.window;

// An editor field as the schema entry it implies.
function specOfField(f) {
  if (f.type === 'bool') return { type: 'bool' };
  if (f.type === 'int') return { type: 'int', min: f.min, max: f.max };
  if (f.type === 'select') return { type: 'enum', values: f.options.filter((o) => o !== '') };
  if (f.type === 'text' || f.type === 'textarea') return { type: 'text', max: f.max };
  return { type: `unexpected:${f.type}` };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
function compare(label, fromEditor, fromServer) {
  const ek = Object.keys(fromEditor).sort();
  const sk = Object.keys(fromServer).sort();
  t(`${label}: names the same keys as the server schema`,
    JSON.stringify(ek) === JSON.stringify(sk),
    `only here: ${ek.filter((k) => !sk.includes(k)).join(',')} only in validators.js: ${sk.filter((k) => !ek.includes(k)).join(',')}`);
  const bad = ek.filter((k) => sk.includes(k)
    && JSON.stringify(plain(fromEditor[k])) !== JSON.stringify(plain(fromServer[k])));
  t(`${label}: every key has the same type and limits`, bad.length === 0,
    bad.map((k) => `${k}: here ${JSON.stringify(fromEditor[k])} validators.js ${JSON.stringify(fromServer[k])}`).join(' | '));
}

// --- 1. editors vs server schemas -------------------------------------------
{
  const editor = {};
  for (const f of VTTSheet.FIELDS.filter((x) => x.path === 'data')) editor[f.key] = specOfField(f);
  compare('actors.data (sheet.js FIELDS)', editor, v.ACTOR_DATA_SCHEMA);
  t('the folio has no raw-JSON field any more', !VTTSheet.FIELDS.some((f) => f.type === 'json' || f.key === 'data'));
  t('every text field in data has a length limit',
    VTTSheet.FIELDS.filter((f) => f.path === 'data' && f.type !== 'int' && f.type !== 'bool').every((f) => Number.isInteger(f.max)));
}
{
  const editor = {};
  for (const f of VTTItemSheet.FIELDS.filter((x) => x.path === 'properties')) editor[f.key] = specOfField(f);
  compare('items.properties (itemsheet.js FIELDS)', editor, v.ITEM_PROPERTIES_SCHEMA);
  t('item framing is not a properties key (columns since Fix 2)',
    !['img_offset_x', 'img_offset_y', 'img_scale'].some((k) => k in v.ITEM_PROPERTIES_SCHEMA));
}
{
  const editor = {};
  for (const k of VTTSpellSheet.DETAIL_KEYS) {
    editor[k] = k === 'school'
      ? { type: 'enum', values: [...VTTSpellSheet.SCHOOLS] }
      : { type: 'text', max: VTTSpellSheet.DETAIL_MAX };
  }
  compare('spells.properties (spellsheet.js DETAIL_KEYS)', editor, v.SPELL_PROPERTIES_SCHEMA);
}

// --- 2. the migration's frozen copy ----------------------------------------
const frozen = Object.fromEntries(migration._internals.DOCUMENTS.map((d) => [d.table, d.schema]));
compare('migration frozen actors.data', frozen.actors, v.ACTOR_DATA_SCHEMA);
compare('migration frozen items.properties', frozen.items, v.ITEM_PROPERTIES_SCHEMA);
compare('migration frozen spells.properties', frozen.spells, v.SPELL_PROPERTIES_SCHEMA);

// The migration must leave every row as the validator would store it, and must
// refuse exactly the documents the validator refuses (bar the size gate, which
// only applies to new writes: every stored row already passed it).
const corpus = [
  {}, { gp: 5 }, { gp: '5' }, { gp: 5.5 }, { gp: -1 }, { gp: true }, { gp: [5] },
  { background: '  Sage  ' }, { background: '' }, { background: null }, { background: 7 },
  { background: 'x'.repeat(61) }, { sk_stealth_p: true }, { sk_stealth_p: false }, { sk_stealth_p: 'true' },
  { sk_stealth_p: 1 }, { familiar: 'owl', gold: 120, sk_stealth: '+7' }, { experience_points: '999999' },
  { rarity: 'Very Rare' }, { rarity: 'mythic' }, { rarity: '' }, { armor_type: 'SHIELD' }, { charges: '0' },
  { magical: false, cost: '5 gp', homebrew: true }, { school: 'Evocation' }, { school: 'chronurgy' },
  { range: ' 60 ft ' }, { duration: 'x'.repeat(121) },
];
for (const { table, schema, field } of [
  { table: 'actors', schema: v.ACTOR_DATA_SCHEMA, field: 'data' },
  { table: 'items', schema: v.ITEM_PROPERTIES_SCHEMA, field: 'properties' },
  { table: 'spells', schema: v.SPELL_PROPERTIES_SCHEMA, field: 'properties' },
]) {
  const disagreements = [];
  for (const doc of corpus) {
    const server = v.validateJsonDocument(schema, doc, field);
    const mig = migration._internals.cleanDocument(frozen[table], doc);
    const same = server.error
      ? mig.invalid.length > 0
      : mig.invalid.length === 0 && JSON.stringify(server.value) === JSON.stringify(mig.doc);
    if (!same) disagreements.push(`${JSON.stringify(doc)} → server ${JSON.stringify(server)} migration ${JSON.stringify(mig)}`);
  }
  t(`${table}: the migration cleans every corpus document exactly as the validator does`,
    disagreements.length === 0, disagreements.slice(0, 3).join(' | '));
}
t('the migration refuses a document that is not an object',
  migration._internals.cleanDocument(frozen.actors, [1]).invalid.length === 1);
t('the migration counts unknown keys without reading them',
  migration._internals.cleanDocument(frozen.actors, { a: 1, b: { deep: 1 }, gp: 2 }).unknown === 2);
t('item framing keys are moved, not counted as unknown',
  migration._internals.cleanDocument(frozen.items, { img_scale: 2, damage: '1d6' }, migration._internals.FRAME_KEYS).unknown === 0);
{
  const f = migration._internals.cleanFrame({ img_offset_x: '0.25', img_scale: 2 });
  t('framing backfill reads numbers and numeric strings, defaulting the rest',
    f.invalid.length === 0 && f.frame.img_offset_x === 0.25 && f.frame.img_offset_y === 0 && f.frame.img_scale === 2, JSON.stringify(f));
  t('out-of-range framing is refused, not clamped',
    migration._internals.cleanFrame({ img_scale: 9 }).invalid.join() === 'img_scale'
    && migration._internals.cleanFrame({ img_offset_x: 'abc' }).invalid.join() === 'img_offset_x');
  t('the key-allow-list CHECK names exactly the schema keys',
    migration._internals.keysCheckExpr('data', { a: 1, b: 2 }) === "jsonb_typeof(data) = 'object' AND (data - ARRAY['a', 'b']::text[]) = '{}'::jsonb");
}

// --- 3. validator behaviour -------------------------------------------------
{
  const r = v.validateActorData({ gp: '12', sk_stealth: ' +7 ', sk_stealth_p: true, sv_str_p: false, familiar: 'owl', background: '', ideals: null });
  t('unknown keys are dropped, known values kept', JSON.stringify(r.value) === JSON.stringify({ gp: 12, sk_stealth_p: true, sk_stealth: '+7' }), JSON.stringify(r));
  t('a numeric string becomes a number', r.value.gp === 12);
  t('text is trimmed', r.value.sk_stealth === '+7');
  t('false, empty and null are not stored (one representation of absent)',
    !('sv_str_p' in r.value) && !('background' in r.value) && !('ideals' in r.value));
}
{
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "gp": 1}');
  const r = v.validateActorData(hostile);
  t('__proto__ and constructor keys are never copied', JSON.stringify(r.value) === '{"gp":1}' && ({}).polluted === undefined, JSON.stringify(r));
}
const err = (r) => r.error || '';
t('an out-of-range int is refused with its key', /data\.experience_points must be between 0 and 999999/.test(err(v.validateActorData({ experience_points: 1000000 }))));
t('a fractional int is refused', /whole number/.test(err(v.validateActorData({ gp: 1.5 }))));
t('an array smuggled into an int is refused', !!v.validateActorData({ gp: [5] }).error);
t('a boolean smuggled into an int is refused', !!v.validateActorData({ inspiration: true }).error);
t('a number in a text field is refused', /data\.background must be text/.test(err(v.validateActorData({ background: 5 }))));
t('an over-long text value is refused with its limit', /data\.sk_stealth is too long \(max 8/.test(err(v.validateActorData({ sk_stealth: '+123456789' }))));
t('a non-boolean flag is refused', !!v.validateActorData({ sk_stealth_p: 'yes' }).error);
t("a flag of 'true' is accepted as true", v.validateActorData({ sk_stealth_p: 'true' }).value.sk_stealth_p === true);
t('an array document is refused', /must be a JSON object/.test(err(v.validateActorData([1, 2]))));
t('a string document is refused', !!v.validateActorData('x').error);
t('undefined/null/empty become {}', ['', null, undefined].every((x) => JSON.stringify(v.validateActorData(x).value) === '{}'));
t('the 8 KB size gate still applies to what was sent, before keys are dropped',
  /too large/.test(err(v.validateActorData({ junk: 'x'.repeat(9000) }))));
t('deep nesting is refused before anything walks it', /nested too deeply/.test(err(v.validateActorData({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }))));

t('rarity matches case-insensitively and is stored lower-case', v.validateItemProperties({ rarity: 'Very Rare' }).value.rarity === 'very rare');
t('an unknown rarity is refused', /properties\.rarity must be one of/.test(err(v.validateItemProperties({ rarity: 'mythic' }))));
t('an unknown armour type is refused', !!v.validateItemProperties({ armor_type: 'chain' }).error);
t('zero charges are a real value and kept', v.validateItemProperties({ charges: 0 }).value.charges === 0);
t('item framing inside properties is dropped as an unknown key',
  JSON.stringify(v.validateItemProperties({ img_offset_x: 0.5, img_scale: 2, damage: '1d6' }).value) === '{"damage":"1d6"}');
t('a known school is accepted, case-insensitively', v.validateSpellProperties({ school: 'EVOCATION' }).value.school === 'evocation');
t('a custom school is refused', /properties\.school must be one of/.test(err(v.validateSpellProperties({ school: 'chronurgy' }))));
t('a spell detail over 120 characters is refused', !!v.validateSpellProperties({ range: 'x'.repeat(121) }).error);
t('an unknown spell key is dropped', JSON.stringify(v.validateSpellProperties({ ritual: true, range: 'Self' }).value) === '{"range":"Self"}');
{
  const out = v.validateActorData({ treasure: 'gem', background: 'Sage', gp: 1 }).value;
  t('the stored document is in schema order (stable output)', Object.keys(out).join() === 'background,gp,treasure', Object.keys(out).join());
}

// --- 4. the read-only production dry run (scripts/json-schemas-precheck.js) ---
(async () => {
  const { run } = require('../../scripts/json-schemas-precheck');
  const env = { NODE_ENV: 'production', DIRECT_DATABASE_URL: 'postgresql://runner:sentinel-secret@ep-example.eu-central-1.aws.neon.tech/vtt?sslmode=verify-full' };
  function fakeKnex(rowsByTable, log) {
    return () => ({
      transaction: async (fn) => {
        const trx = (table) => ({ select: () => ({ orderBy: async () => rowsByTable[table] || [] }) });
        trx.raw = async (sql) => { log.push(sql); };
        return fn(trx);
      },
      destroy: async () => { log.push('destroy'); },
    });
  }
  {
    const sql = []; const out = [];
    const code = await run({ env, makeKnex: fakeKnex({ actors: [{ id: 'a', data: { gp: 1, secret_value: 'do-not-print' } }], items: [{ id: 'i', properties: { img_scale: 2 } }] }, sql), log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: clean data exits 0 with PRECHECK_OK', code === 0 && out.some((x) => x === 'PRECHECK_OK: the migration can run.'), out.join(' | '));
    t('dry run: reports each table', ['actors.data', 'items.properties', 'spells.properties'].every((k) => out.some((x) => x.startsWith(`PRECHECK ${k}:`))), out.join(' | '));
    t('dry run: counts the unknown key and the framing to move',
      out.some((x) => /actors\.data: 1 rows, 1 to rewrite, 1 unknown/.test(x)) && out.some((x) => /items\.properties: 1 rows, 1 to rewrite, 0 unknown key\(s\) to remove, 1 with framing/.test(x)), out.join(' | '));
    t('dry run: the transaction is READ ONLY before any read', sql[0] === 'SET TRANSACTION READ ONLY', sql.join(' | '));
    t('dry run: the connection is closed', sql.includes('destroy'));
    t('dry run: prints no row contents and no connection secret', !out.join('\n').includes('do-not-print') && !out.join('\n').includes('sentinel-secret'));
  }
  {
    const out = [];
    const code = await run({ env, makeKnex: fakeKnex({ spells: [{ id: 's', properties: { school: 'chronurgy' } }] }, []), log: (x) => out.push(x), error: (x) => out.push(x) });
    t('dry run: a value the migration would refuse exits 2 and names table, key and count',
      code === 2 && out.some((x) => x.startsWith('PRECHECK_REFUSED') && x.includes('spells.properties.school: 1')) && !out.join().includes('chronurgy'), out.join(' | '));
  }
  {
    let created = 0; const out = [];
    const code = await run({ env: { ...env, NODE_ENV: 'test' }, makeKnex: () => { created += 1; return {}; }, error: (x) => out.push(x) });
    t('dry run: refuses a non-production environment before connecting', code === 1 && created === 0, out.join(' | '));
  }
  console.log(`\njson schemas: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('json schemas suite crashed:', e.message); process.exit(1); });
