// Fix 2 of the schema review (claude/SCHEMA_RULES.md, rule C): the three JSONB
// documents get a schema, and item image framing becomes columns. One
// migration, one transaction (Knex wraps each migration in a transaction and
// PostgreSQL DDL is transactional), so a failed pre-check leaves everything as it
// was.
//
// What it does:
//   C2  actors.data, items.properties and spells.properties keep only the keys
//       their editors write (the allow-lists below). Unknown keys are removed
//       from every existing row, and a CHECK states the key allow-list so no
//       writer (route, script, manual repair) can add one again. The value TYPES
//       per key are checked by the validators, not by the database: a CHECK per
//       key would be 70 expressions for a document the server never interprets.
//   C3  items.img_offset_x / img_offset_y / img_scale: numeric(6,3) NOT NULL,
//       defaults 0 / 0 / 1 (the identity crop), CHECK like actors and tokens,
//       backfilled from the keys of the same names in items.properties, which
//       are then removed from the document.
//
// PRE-CHECK. Before anything changes, every row is read and its document is run
// through the same rules the server applies on save (a FROZEN copy below, so the
// migration means the same thing in a year as today). Per table it reports the
// rows read, the rows that will change and the number of unknown keys that will
// be removed. A row the rules would REFUSE (a document that is not an object, a
// known key whose value has the wrong type or is out of range, item framing out
// of range) is not rewritten: the migration stops, prints the table, key and
// count (never row contents) and changes nothing, so the data can be looked at.
// scripts/json-schemas-precheck.js runs the same pre-check read-only against a
// database without migrating it.
//
// Normalisation, stated: known text values are trimmed and an empty string,
// null or false is dropped (one representation of absent, rule B8) — the same
// result the server now gives the next time the row is saved. updated_at is not
// touched: this is a schema change, not an edit by a user.
//
// DOWN puts non-identity item framing back into items.properties and drops the
// three columns and the CHECKs. Keys removed from documents cannot come back
// (that is the point of the migration); take the Neon backup branch before it.

// ---------------------------------------------------------------------------
// Frozen schemas — copied from src/services/validators.js on 2026-10-06.
// tests/integration/test-json-schemas.js asserts that they still agree.
// ---------------------------------------------------------------------------
const text = (max) => ({ type: 'text', max });
const int = (min, max) => ({ type: 'int', min, max });
const bool = () => ({ type: 'bool' });
const oneOf = (values) => ({ type: 'enum', values });

const ACTOR_DATA = (() => {
  const s = {
    background: text(60), alignment: text(30),
    experience_points: int(0, 999999), inspiration: int(0, 99),
    hit_dice: text(40), passive_perception: int(0, 99),
    cp: int(0, 9999999), sp: int(0, 9999999), ep: int(0, 9999999), gp: int(0, 9999999), pp: int(0, 9999999),
    attacks: text(800), proficiencies_languages: text(500), features_traits: text(1000),
    personality_traits: text(400), ideals: text(300), bonds: text(300), flaws: text(300),
    appearance: text(400), allies_organisations: text(600), treasure: text(600),
  };
  for (const k of ['sv_str', 'sv_dex', 'sv_con', 'sv_int', 'sv_wis', 'sv_cha',
    'sk_acrobatics', 'sk_animal', 'sk_arcana', 'sk_athletics', 'sk_deception', 'sk_history',
    'sk_insight', 'sk_intimidation', 'sk_investigation', 'sk_medicine', 'sk_nature', 'sk_perception',
    'sk_performance', 'sk_persuasion', 'sk_religion', 'sk_sleight', 'sk_stealth', 'sk_survival']) {
    s[`${k}_p`] = bool();
    s[k] = text(8);
  }
  return s;
})();

const ITEM_PROPERTIES = {
  rarity: oneOf(['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact']),
  magical: bool(), requires_attunement: bool(),
  cost: text(30), attunement_note: text(120),
  damage: text(30), damage_type: text(30), weapon_range: text(30), weapon_properties: text(120),
  armor_class: text(40), armor_type: oneOf(['light', 'medium', 'heavy', 'shield']),
  strength_req: text(20), stealth_disadvantage: bool(),
  charges: int(0, 9999), charges_max: int(0, 9999), recharge: text(40), save_dc: text(20),
  effect: text(2000), source: text(200),
};

const SPELL_PROPERTIES = {
  school: oneOf(['abjuration', 'conjuration', 'divination', 'enchantment',
    'evocation', 'illusion', 'necromancy', 'transmutation']),
  casting_time: text(120), range: text(120), components: text(120), duration: text(120),
};

const DOCUMENTS = [
  { table: 'actors', column: 'data', schema: ACTOR_DATA, check: 'actors_data_keys_check' },
  { table: 'items', column: 'properties', schema: ITEM_PROPERTIES, check: 'items_properties_keys_check' },
  { table: 'spells', column: 'properties', schema: SPELL_PROPERTIES, check: 'spells_properties_keys_check' },
];

const FRAME_KEYS = ['img_offset_x', 'img_offset_y', 'img_scale'];
const FRAME_DEFAULTS = { img_offset_x: 0, img_offset_y: 0, img_scale: 1 };
const FRAME_RANGES = { img_offset_x: [-2, 2], img_offset_y: [-2, 2], img_scale: [0.1, 5] };
const ITEMS_FRAME_CHECK = 'items_frame_check';
const range = (col, [min, max]) => `${col} BETWEEN ${min} AND ${max}`;
const ITEMS_FRAME_EXPR = FRAME_KEYS.map((k) => range(k, FRAME_RANGES[k])).join(' AND ');

// The key allow-list as a CHECK: removing every allowed key must leave an empty
// object. (jsonb - text[] deletes the named top-level keys.) The allow-lists are
// fixed identifiers written here, never user input.
function keysCheckExpr(column, schema) {
  const keys = Object.keys(schema).map((k) => `'${k}'`).join(', ');
  return `jsonb_typeof(${column}) = 'object' AND (${column} - ARRAY[${keys}]::text[]) = '{}'::jsonb`;
}

// --- the rules, as the server applies them (validators.js) --------------------
function numeric(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
// Returns { value } (undefined = not stored) or { invalid: true }.
function cleanValue(spec, v) {
  if (v === undefined || v === null || v === '') return { value: undefined };
  switch (spec.type) {
    case 'text': {
      if (typeof v !== 'string') return { invalid: true };
      const s = v.trim();
      return s.length > spec.max ? { invalid: true } : { value: s || undefined };
    }
    case 'int': {
      const n = numeric(v);
      return Number.isInteger(n) && n >= spec.min && n <= spec.max ? { value: n } : { invalid: true };
    }
    case 'bool':
      if (v === true || v === 'true') return { value: true };
      if (v === false || v === 'false') return { value: undefined };
      return { invalid: true };
    case 'enum': {
      if (typeof v !== 'string') return { invalid: true };
      const w = v.trim().toLowerCase();
      if (w === '') return { value: undefined };
      return spec.values.includes(w) ? { value: w } : { invalid: true };
    }
    default:
      return { invalid: true };
  }
}
// { doc, unknown: n, invalid: [key, ...] } — iterates the schema, so unknown
// keys are only counted, never read.
function cleanDocument(schema, src, ignore = []) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { invalid: ['(not an object)'], unknown: 0 };
  const doc = {};
  const invalid = [];
  for (const [key, spec] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const r = cleanValue(spec, src[key]);
    if (r.invalid) invalid.push(key);
    else if (r.value !== undefined) doc[key] = r.value;
  }
  const unknown = Object.keys(src).filter((k) => !Object.prototype.hasOwnProperty.call(schema, k) && !ignore.includes(k)).length;
  return { doc, unknown, invalid };
}
function cleanFrame(src) {
  const frame = { ...FRAME_DEFAULTS };
  const invalid = [];
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { frame, invalid };
  for (const key of FRAME_KEYS) {
    const v = src[key];
    if (v === undefined || v === null || v === '') continue;
    const n = numeric(v);
    const [min, max] = FRAME_RANGES[key];
    if (!Number.isFinite(n) || n < min || n > max) invalid.push(key);
    else frame[key] = n;
  }
  return { frame, invalid };
}

// Order-insensitive equality for two JSON documents (jsonb does not keep the
// key order JavaScript writes).
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Reads every row; changes nothing. Returns the plan and a per-table report.
async function precheck(knex) {
  const report = [];
  const problems = [];
  const plan = {};
  for (const { table, column, schema } of DOCUMENTS) {
    const isItems = table === 'items';
    const rows = await knex(table).select('id', column).orderBy('id');
    const changes = [];
    const invalidByKey = {};
    let unknown = 0;
    let framed = 0;
    for (const row of rows) {
      const src = row[column];
      const r = cleanDocument(schema, src, isItems ? FRAME_KEYS : []);
      for (const k of r.invalid) invalidByKey[k] = (invalidByKey[k] || 0) + 1;
      unknown += r.unknown;
      const change = { id: row.id };
      if (isItems) {
        const f = cleanFrame(src);
        for (const k of f.invalid) invalidByKey[k] = (invalidByKey[k] || 0) + 1;
        if (src && typeof src === 'object' && FRAME_KEYS.some((k) => k in src)) framed += 1;
        change.frame = f.frame;
      }
      if (r.invalid.length) continue;
      if (!same(r.doc, src) || (isItems && !same(change.frame, FRAME_DEFAULTS))) {
        change.doc = r.doc;
        changes.push(change);
      }
    }
    plan[table] = changes;
    const invalidCount = Object.values(invalidByKey).reduce((a, b) => a + b, 0);
    report.push(`${table}.${column}: ${rows.length} rows, ${changes.length} to rewrite, `
      + `${unknown} unknown key(s) to remove${isItems ? `, ${framed} with framing to move` : ''}`
      + `${invalidCount ? `, REFUSED VALUES ${Object.entries(invalidByKey).map(([k, n]) => `${k}=${n}`).join(' ')}` : ''}`);
    for (const [k, n] of Object.entries(invalidByKey)) problems.push(`${table}.${column}.${k}: ${n}`);
  }
  return { report, problems, plan };
}

exports.up = async function up(knex) {
  const { report, problems, plan } = await precheck(knex);
  console.log(`JSON_SCHEMAS_PRECHECK: ${report.join('; ')}`);
  if (problems.length) {
    // The production runner prints only a generic code for a failure, so the
    // summary goes to stderr here (constraint/key names and counts only).
    console.error(`JSON_SCHEMAS_PRECHECK_FAILED (no changes made): ${problems.join('; ')}`);
    const error = new Error(`json schemas pre-check failed: ${problems.join('; ')}`);
    error.code = 'JSON_SCHEMAS_PRECHECK';
    throw error;
  }

  await knex.schema.alterTable('items', (t) => {
    t.decimal('img_offset_x', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_offset_y', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_scale', 6, 3).notNullable().defaultTo(1);
  });

  for (const { table, column } of DOCUMENTS) {
    for (const change of plan[table]) {
      const updates = { [column]: JSON.stringify(change.doc) };
      if (change.frame) Object.assign(updates, change.frame);
      await knex(table).where({ id: change.id }).update(updates);
    }
  }

  await knex.raw(`ALTER TABLE items ADD CONSTRAINT ?? CHECK (${ITEMS_FRAME_EXPR})`, [ITEMS_FRAME_CHECK]);
  for (const { table, column, schema, check } of DOCUMENTS) {
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${keysCheckExpr(column, schema)})`, [table, check]);
  }
};

exports.down = async function down(knex) {
  for (const { table, check } of DOCUMENTS) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, check]);
  }
  await knex.raw('ALTER TABLE items DROP CONSTRAINT IF EXISTS ??', [ITEMS_FRAME_CHECK]);
  // Framing goes back where the old code reads it. The identity crop is left
  // out, which the old code reads as the same thing (missing = 0, 0, 1).
  await knex.raw(`
    UPDATE items SET properties = properties || jsonb_build_object(
      'img_offset_x', img_offset_x::float8, 'img_offset_y', img_offset_y::float8, 'img_scale', img_scale::float8)
    WHERE img_offset_x <> 0 OR img_offset_y <> 0 OR img_scale <> 1`);
  await knex.schema.alterTable('items', (t) => { t.dropColumns(...FRAME_KEYS); });
};

// Exported for the migration test and scripts/json-schemas-precheck.js.
exports._internals = {
  DOCUMENTS, FRAME_KEYS, FRAME_RANGES, ITEMS_FRAME_CHECK, ITEMS_FRAME_EXPR,
  keysCheckExpr, cleanDocument, cleanFrame, precheck,
};
