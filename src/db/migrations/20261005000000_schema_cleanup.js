// Fix 1 of the schema review (claude/SCHEMA_RULES.md, decided 2026-10-05):
// remove what is unused, and let the database state the invariants the
// validators already enforce. One migration, one transaction (Knex wraps each
// migration in a transaction and PostgreSQL DDL is transactional), so a failed
// pre-check or constraint leaves the schema exactly as it was.
//
// What it does, by rule:
//   A1/A2  drop never-written columns: campaigns.settings; tokens.rotation,
//          bar1_value, bar1_max, conditions, is_prop; scenes/actors/items
//          .folder_id; scenes.width/height (now constants in the client);
//          inventory.sort_order; combat.name; assets.etag.
//   A3     drop five indexes that duplicate the leading column of a key.
//   B7     NOT NULL on all 33 created_at/updated_at columns and on
//          campaign_members.joined_at; also messages.speaker_name,
//          messages.speaker_role (after a backfill) and
//          storage_cleanup.next_attempt_at (a NULL row would never be retried).
//   E      CHECK constraints for every enumeration and numeric range the
//          validators enforce. The validators stay: they give the user-facing
//          error; the CHECK makes the invariant hold for every writer.
//   F      indexes on foreign keys whose parent rows are deleted by normal use.
//
// PRE-CHECK. Before anything changes, every row that would violate a new NOT
// NULL or CHECK is counted. If any exist the migration stops and prints the
// constraint names and counts (never row contents), so the data can be looked
// at rather than silently rewritten. The production migration runner prints only
// a generic code for a failure, which is why the summary goes to stderr here.
//
// DOWN re-creates the dropped columns with their original types and defaults.
// Values that differed from the default cannot come back (none were written by
// the live app, which is why the columns were dropped); the messages.speaker_role
// backfill is kept, since it only filled NULLs.

const TIMESTAMPS = {
  users: ['created_at', 'updated_at'],
  email_verification_tokens: ['created_at'],
  password_reset_tokens: ['created_at'],
  campaigns: ['created_at', 'updated_at'],
  scenes: ['created_at', 'updated_at'],
  tokens: ['created_at', 'updated_at'],
  fog_of_war: ['created_at', 'updated_at'],
  actors: ['created_at', 'updated_at'],
  items: ['created_at', 'updated_at'],
  inventory: ['created_at', 'updated_at'],
  combat: ['created_at', 'updated_at'],
  combatants: ['created_at', 'updated_at'],
  messages: ['created_at'],
  spells: ['created_at', 'updated_at'],
  actor_spells: ['created_at', 'updated_at'],
  assets: ['created_at', 'updated_at'],
  storage_budget: ['created_at', 'updated_at'],
  storage_cleanup: ['created_at', 'updated_at'],
};

// Other columns that become NOT NULL. speaker_role is backfilled first.
const OTHER_NOT_NULL = {
  campaign_members: ['joined_at'],
  messages: ['speaker_name', 'speaker_role'],
  storage_cleanup: ['next_attempt_at'],
};

const range = (col, min, max) => `${col} BETWEEN ${min} AND ${max}`;
const oneOf = (col, values) => `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;

// Each CHECK mirrors a validator in src/services/validators.js (or the value set
// a service writes). A NULL passes a CHECK, so nullable columns keep NULL as
// their "absent" state (rule B).
const CHECKS = [
  ['email_verification_tokens', 'email_verification_tokens_purpose_check', oneOf('purpose', ['signup', 'email_change'])],
  ['campaign_members', 'campaign_members_color_check', "color ~ '^#[0-9A-Fa-f]{6}$'"],
  // validateTokenSize, validateGridCoord, validateImgFrame/validateImgScale
  ['tokens', 'tokens_size_check', `${range('width', 0.1, 100)} AND ${range('height', 0.1, 100)}`],
  ['tokens', 'tokens_position_check', `${range('x', -10000, 10000)} AND ${range('y', -10000, 10000)}`],
  ['tokens', 'tokens_frame_check', `${range('img_offset_x', -2, 2)} AND ${range('img_offset_y', -2, 2)} AND ${range('img_scale', 0.1, 5)}`],
  ['users', 'users_avatar_frame_check', `${range('avatar_offset_x', -2, 2)} AND ${range('avatar_offset_y', -2, 2)} AND ${range('avatar_scale', 0.1, 5)}`],
  ['fog_of_war', 'fog_of_war_type_check', oneOf('type', ['rect', 'circle', 'poly'])],
  // ACTOR_INT_FIELDS, ACTOR_SIZES
  ['actors', 'actors_level_check', range('level', 1, 20)],
  ['actors', 'actors_hp_check', `${range('hp_current', -9999, 9999)} AND ${range('hp_max', 0, 9999)} AND ${range('hp_temp', 0, 9999)}`],
  ['actors', 'actors_armor_class_check', range('armor_class', 0, 99)],
  ['actors', 'actors_speed_check', range('speed', 0, 999)],
  ['actors', 'actors_abilities_check', ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'].map((c) => range(c, 1, 30)).join(' AND ')],
  ['actors', 'actors_death_saves_check', `${range('death_save_successes', 0, 10)} AND ${range('death_save_failures', 0, 10)}`],
  ['actors', 'actors_size_check', oneOf('size', ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'])],
  ['actors', 'actors_frame_check', `${range('img_offset_x', -2, 2)} AND ${range('img_offset_y', -2, 2)} AND ${range('img_scale', 0.1, 5)}`],
  // ITEM_TYPES, validateItemWeight, validateQuantity
  ['items', 'items_type_check', oneOf('type', ['weapon', 'armor', 'consumable', 'misc'])],
  ['items', 'items_weight_check', range('weight', 0, 10000)],
  ['inventory', 'inventory_quantity_check', range('quantity', 1, 9999)],
  // validateSpellLevel, SPELL_SOURCES
  ['spells', 'spells_level_check', range('level', 0, 9)],
  ['actor_spells', 'actor_spells_source_check', oneOf('source', ['class', 'race', 'item', 'other'])],
  // PATCH /combat: round 1..9999; turn_index is bounded by the live roster in
  // the route, so the database states only that it is a position.
  ['combat', 'combat_round_check', range('round', 1, 9999)],
  ['combat', 'combat_turn_index_check', 'turn_index >= 0'],
  ['combatants', 'combatants_sort_order_check', range('sort_order', 0, 9999)],
  ['combatants', 'combatants_hp_override_check', range('hp_override', -9999, 9999)],
  // A message must say something: text, a roll, or both (routes/chat.js).
  ['messages', 'messages_speaker_role_check', oneOf('speaker_role', ['gm', 'player'])],
  ['messages', 'messages_has_body_check', 'content IS NOT NULL OR roll_data IS NOT NULL'],
  // storage.KINDS and the asset lifecycle. status decides whether an image is
  // served, so it is the field most in need of a database guarantee.
  ['assets', 'assets_kind_check', oneOf('kind', ['map', 'portrait', 'token', 'item', 'avatar', 'cover'])],
  ['assets', 'assets_status_check', oneOf('status', ['pending', 'ready', 'rejected'])],
  ['storage_budget', 'storage_budget_period_source_check', oneOf('period_source', ['assumed', 'provider'])],
  // Reasons written by the code. 'rejected' was written by the presigned-upload
  // confirm route removed in this fix; it stays allowed so a queued row from
  // before the release is still valid until the cleanup worker removes it.
  ['storage_cleanup', 'storage_cleanup_reason_check', oneOf('reason', ['delete_failed', 'orphan_pending', 'campaign_purged', 'rejected'])],
];

// Rule F. Named explicitly so down can drop exactly these.
const FK_INDEXES = [
  ['email_verification_tokens', 'user_id'],
  ['password_reset_tokens', 'user_id'],
  ['campaigns', 'active_scene_id'],
  ['tokens', 'actor_id'],
  ['tokens', 'created_by'],
  ['actors', 'user_id'],
  ['inventory', 'item_id'],
  ['actor_spells', 'spell_id'],
  ['combatants', 'token_id'],
  ['messages', 'user_id'],
].map(([table, column]) => ({ table, column, name: `${table}_${column}_index` }));

// Rule A3: each duplicates the leading column of a primary key or unique index.
const DUPLICATE_INDEXES = [
  ['campaign_members', 'campaign_id', 'campaign_members_campaign_id_index'], // PK (campaign_id, user_id)
  ['inventory', 'actor_id', 'inventory_actor_id_index'],                     // UNIQUE (actor_id, item_id)
  ['spells', 'campaign_id', 'spells_campaign_id_index'],                     // (campaign_id, level)
  ['actor_spells', 'actor_id', 'actor_spells_actor_id_index'],               // PK (actor_id, spell_id)
  ['combatants', 'combat_id', 'combatants_combat_id_index'],                 // UNIQUE (combat_id, token_id)
];

async function precheck(knex) {
  const problems = [];
  const notNull = { ...TIMESTAMPS };
  for (const [table, cols] of Object.entries(OTHER_NOT_NULL)) {
    notNull[table] = [...(notNull[table] || []), ...cols.filter((c) => c !== 'speaker_role')];
  }
  for (const [table, cols] of Object.entries(notNull)) {
    for (const col of cols) {
      const { rows } = await knex.raw('SELECT count(*)::int AS n FROM ?? WHERE ?? IS NULL', [table, col]);
      if (rows[0].n) problems.push(`${table}.${col} IS NULL: ${rows[0].n}`);
    }
  }
  // speaker_role NULLs are backfilled; anything else outside the set is a problem.
  for (const [table, name, expr] of CHECKS) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM ?? WHERE NOT (${expr})`, [table]);
    if (rows[0].n) problems.push(`${name}: ${rows[0].n}`);
  }
  if (problems.length) {
    console.error(`SCHEMA_CLEANUP_PRECHECK_FAILED (no changes made): ${problems.join('; ')}`);
    const error = new Error(`schema cleanup pre-check failed: ${problems.join('; ')}`);
    error.code = 'SCHEMA_CLEANUP_PRECHECK';
    throw error;
  }
}

exports.up = async function up(knex) {
  await precheck(knex);

  // speaker_role was added (M6) after messages existed. Best effort, and
  // documented as such: the author's role at the time is not recorded, so a
  // message counts as the GM's when its author owns the campaign NOW. Messages
  // whose author was deleted (user_id NULL) become 'player'.
  await knex.raw(`
    UPDATE messages m SET speaker_role = CASE
      WHEN m.user_id IS NOT NULL AND m.user_id = c.owner_id THEN 'gm' ELSE 'player' END
    FROM campaigns c
    WHERE c.id = m.campaign_id AND m.speaker_role IS NULL`);

  for (const [, , name] of DUPLICATE_INDEXES) await knex.raw('DROP INDEX ??', [name]);

  await knex.schema.alterTable('campaigns', (t) => { t.dropColumn('settings'); });
  await knex.schema.alterTable('scenes', (t) => { t.dropColumns('folder_id', 'width', 'height'); });
  await knex.schema.alterTable('tokens', (t) => {
    t.dropColumns('rotation', 'bar1_value', 'bar1_max', 'conditions', 'is_prop');
  });
  await knex.schema.alterTable('actors', (t) => { t.dropColumn('folder_id'); });
  await knex.schema.alterTable('items', (t) => { t.dropColumn('folder_id'); });
  await knex.schema.alterTable('inventory', (t) => { t.dropColumn('sort_order'); });
  await knex.schema.alterTable('combat', (t) => { t.dropColumn('name'); });
  await knex.schema.alterTable('assets', (t) => { t.dropColumn('etag'); });

  // Two known values; 255 characters was never the intent.
  await knex.raw('ALTER TABLE email_verification_tokens ALTER COLUMN purpose TYPE varchar(20)');

  const notNull = { ...TIMESTAMPS };
  for (const [table, cols] of Object.entries(OTHER_NOT_NULL)) notNull[table] = [...(notNull[table] || []), ...cols];
  for (const [table, cols] of Object.entries(notNull)) {
    const clauses = cols.map((c) => knex.raw('ALTER COLUMN ?? SET NOT NULL', [c]).toQuery()).join(', ');
    await knex.raw(`ALTER TABLE ?? ${clauses}`, [table]);
  }

  for (const [table, name, expr] of CHECKS) {
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [table, name]);
  }

  for (const { table, column, name } of FK_INDEXES) {
    await knex.raw('CREATE INDEX ?? ON ?? (??)', [name, table, column]);
  }
};

exports.down = async function down(knex) {
  for (const { name } of FK_INDEXES) await knex.raw('DROP INDEX IF EXISTS ??', [name]);
  for (const [table, name] of CHECKS) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, name]);
  }

  const notNull = { ...TIMESTAMPS };
  for (const [table, cols] of Object.entries(OTHER_NOT_NULL)) notNull[table] = [...(notNull[table] || []), ...cols];
  for (const [table, cols] of Object.entries(notNull)) {
    const clauses = cols.map((c) => knex.raw('ALTER COLUMN ?? DROP NOT NULL', [c]).toQuery()).join(', ');
    await knex.raw(`ALTER TABLE ?? ${clauses}`, [table]);
  }

  await knex.raw('ALTER TABLE email_verification_tokens ALTER COLUMN purpose TYPE varchar(255)');

  // Original definitions, from the migrations that created them.
  await knex.schema.alterTable('assets', (t) => { t.text('etag'); });
  await knex.schema.alterTable('combat', (t) => { t.string('name', 100); });
  await knex.schema.alterTable('inventory', (t) => { t.integer('sort_order').notNullable().defaultTo(0); });
  await knex.schema.alterTable('items', (t) => { t.uuid('folder_id'); });
  await knex.schema.alterTable('actors', (t) => { t.uuid('folder_id'); });
  await knex.schema.alterTable('tokens', (t) => {
    t.decimal('rotation').notNullable().defaultTo(0);
    t.integer('bar1_value');
    t.integer('bar1_max');
    t.jsonb('conditions').notNullable().defaultTo('[]');
    t.boolean('is_prop').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('scenes', (t) => {
    t.uuid('folder_id');
    t.integer('width').notNullable().defaultTo(1400);
    t.integer('height').notNullable().defaultTo(1050);
  });
  await knex.schema.alterTable('campaigns', (t) => { t.jsonb('settings').notNullable().defaultTo('{}'); });

  for (const [table, column, name] of DUPLICATE_INDEXES) {
    await knex.raw('CREATE INDEX ?? ON ?? (??)', [name, table, column]);
  }
};

// Exported for the migration test.
exports._internals = { TIMESTAMPS, OTHER_NOT_NULL, CHECKS, FK_INDEXES, DUPLICATE_INDEXES };
