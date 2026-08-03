// M4: actors (characters) + items + inventory.
//
// This is the migration that finally populates tokens.actor_id, NULL for every
// token created since M2. A token stops being a labelled square and becomes a
// character with statistics behind it.
//
// Columns follow SCHEMA_REFERENCE.md, with FIVE deliberate, documented
// deviations recorded here and in SCHEMA_REFERENCE at session end. The house
// rule (established by tokens.created_by in M2 and fog_of_war.updated_at in M3)
// is that a deviation is declared in the migration header, never added quietly.
//
//   1. items.updated_at — SCHEMA_REFERENCE gives items only created_at, but an
//      item is editable (name, description, properties, and now `identified`),
//      so the row is mutable. An updatable row with no updated_at contradicts
//      this schema's own "timestamps on every table" principle. Identical case
//      to fog_of_war.updated_at in M3.
//
//   2. items.identified (BOOLEAN NOT NULL DEFAULT false) — NOT in
//      SCHEMA_REFERENCE. The GM may hold an item's stats back from players until
//      it is identified in fiction. It is a REAL COLUMN and not a key inside the
//      existing `properties` JSONB, deliberately: `properties` is client-shaped
//      data, and the standing rule recorded in the campaign audit is that
//      authority is never re-derived from a client-writable JSONB column
//      (campaigns.settings). `identified` gates DISCLOSURE, so it gets a real,
//      GM-writable column — the same reasoning that keeps is_npc a real column.
//
//      It DEFAULTS FALSE, i.e. secret. That satisfies both this schema's
//      "booleans default false" convention and secure-by-default: a GM who
//      forgets the flag gets the non-disclosing outcome. The create endpoint
//      accepts `identified` explicitly, so an ordinary mundane item is marked
//      identified in the same request that creates it.
//
//   3. inventory.created_at / inventory.updated_at — SCHEMA_REFERENCE gives the
//      join table no timestamps at all, but quantity / equipped / attuned are
//      all mutable. Same reasoning as (1).
//
//   4. inventory UNIQUE (actor_id, item_id) — NOT in SCHEMA_REFERENCE. The table
//      carries a `quantity` column, which only makes sense if there is at most
//      one row per (actor, item): two rows for the same item with quantities 3
//      and 2 have no defined meaning. Without the constraint, "add this item to
//      the bag" is inherently read-then-write (look for an existing row, then
//      insert or increment) — a TOCTOU by construction, which the standing
//      atomic-cap constraint forbids. With it, the add becomes a single atomic
//      INSERT ... ON CONFLICT DO UPDATE and the race cannot happen.
//
//   5. actors.folder_id and items.folder_id are added as NULLABLE COLUMNS
//      WITHOUT their FK constraint, because the `folders` table is not migrated
//      yet. This is not a new pattern: it is exactly how scenes.folder_id was
//      handled in M2 and how campaigns.active_scene_id was handled in the
//      campaigns migration. Keep the column for schema fidelity, add the
//      constraint when its target table exists.
//
// This migration also installs the deferred FK tokens.actor_id -> actors.id,
// which the M2 canvas migration explicitly left as a bare uuid column because
// `actors` did not exist yet. It is ON DELETE SET NULL, matching
// tokens.created_by and campaigns.active_scene_id. CASCADE was rejected: it
// would let one actor deletion silently delete that character's tokens across
// every scene in the campaign, which is precisely the invisible blast radius
// that DELETE /:sceneId was built to make visible. SET NULL leaves the token on
// the board as an unlinked marker (a corpse, a spare mini) and loses only the
// link.

exports.up = async function (knex) {
  await knex.schema.createTable('actors', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    // The controlling player. NULL = no player controls it.
    //
    // ON DELETE SET NULL, matching tokens.created_by: deleting a user must not
    // vaporise a character out of a running campaign. The sheet survives and
    // becomes GM-controlled, which is the right outcome when a player leaves
    // mid-campaign. Note that is_npc is NOT touched by that transition — an
    // abandoned player character stays a player character (its stats stay
    // visible to the party); it merely has no owner. This is why authorisation
    // is derived from user_id while DISCLOSURE is derived from is_npc: the two
    // answer different questions and must not be collapsed into one column.
    t.uuid('user_id')
      .references('id').inTable('users').onDelete('SET NULL');
    // FK constraint deferred until the folders table exists (header note 5).
    t.uuid('folder_id');
    t.string('name', 100).notNullable();
    t.text('img_url');
    // Gates what leaves the server for a player (see routes/actors.js). A real
    // column, GM-writable only — never a key in the `data` JSONB below.
    t.boolean('is_npc').notNullable().defaultTo(false);
    t.integer('level').notNullable().defaultTo(1);
    // "class" is not a PostgreSQL keyword and Knex quotes identifiers anyway,
    // so the column name from SCHEMA_REFERENCE is kept verbatim.
    t.string('class', 50);
    t.string('race', 50);
    // Creature size category. Drives the DEFAULT token footprint when a token is
    // placed from this actor; it is not mechanically enforced (no squeeze/space
    // rules — see database-decisions.md).
    t.string('size', 20).notNullable().defaultTo('Medium');
    // hp_current is deliberately allowed to go NEGATIVE and is never clamped to
    // hp_max. The server stores three integers and does not interpret them:
    // there is no auto-unconscious, no auto-stabilisation at 3 successes, no
    // auto-death at 3 failures. All of those are 5e rules cut by name in
    // database-decisions.md. "Dead" is a display state the client derives from
    // hp_current <= 0; it is not a column and not a server behaviour.
    t.integer('hp_current').notNullable().defaultTo(0);
    t.integer('hp_max').notNullable().defaultTo(0);
    t.integer('hp_temp').notNullable().defaultTo(0);
    t.integer('armor_class').notNullable().defaultTo(10);
    t.integer('speed').notNullable().defaultTo(30);
    // The six ability scores as real columns: queryable, and read directly by
    // combat in M5. Modifiers and the proficiency bonus are NOT stored and NOT
    // computed server-side — database-decisions.md puts them client-side or in
    // `data`. Deriving them here would be the first step of a rules engine.
    t.integer('strength').notNullable().defaultTo(10);
    t.integer('dexterity').notNullable().defaultTo(10);
    t.integer('constitution').notNullable().defaultTo(10);
    t.integer('intelligence').notNullable().defaultTo(10);
    t.integer('wisdom').notNullable().defaultTo(10);
    t.integer('charisma').notNullable().defaultTo(10);
    // Two plain counters. The server never acts on their values.
    t.integer('death_save_successes').notNullable().defaultTo(0);
    t.integer('death_save_failures').notNullable().defaultTo(0);
    t.text('notes');
    // Overflow bucket: proficiencies, extra speeds, spell slots, currency, hit
    // dice. Never queried at the DB level. Bounded in size by validators.js —
    // an unbounded JSONB column that a player may write is a payload DoS.
    t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('campaign_id'); // character list per campaign
  });

  await knex.schema.createTable('items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    // FK constraint deferred until the folders table exists (header note 5).
    t.uuid('folder_id');
    t.string('name', 100).notNullable();
    t.text('img_url');
    // 'weapon' | 'armor' | 'consumable' | 'misc'. App-logic allow-list, no DB
    // CHECK: the house convention is app-logic allow-lists, and
    // campaign_members.status is the one stated exception because it drives
    // AUTHORISATION. Item type drives categorisation only.
    t.string('type', 30).notNullable();
    t.decimal('weight').notNullable().defaultTo(0);
    t.text('description');
    // Mechanical properties, interpreted by the GM, never by the server (items
    // do not auto-modify stats when equipped — database-decisions.md).
    t.jsonb('properties').notNullable().defaultTo('{}');
    // Deviation 2 — see header.
    t.boolean('identified').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    // Deviation 1 — see header.
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('campaign_id'); // item list per campaign
  });

  await knex.schema.createTable('inventory', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Both sides CASCADE: an inventory row is meaningless without its actor and
    // meaningless without its item. Deleting a character empties their bag;
    // deleting an item removes it from every bag that held it.
    t.uuid('actor_id').notNullable()
      .references('id').inTable('actors').onDelete('CASCADE');
    t.uuid('item_id').notNullable()
      .references('id').inTable('items').onDelete('CASCADE');
    t.integer('quantity').notNullable().defaultTo(1);
    t.boolean('equipped').notNullable().defaultTo(false);
    // Attunement is capped at 3 per actor in application code (per
    // database-decisions.md), enforced ATOMICALLY via withAtomicCap's update
    // branch — never read-then-write. It is not a DB constraint: Postgres
    // forbids subqueries in CHECK, and a trigger would put gameplay logic in
    // the database against the house convention.
    t.boolean('attuned').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    // Deviation 3 — see header.
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('actor_id'); // character inventory loading
    // Deviation 4 — see header. This is what makes "add to bag" a single atomic
    // INSERT ... ON CONFLICT DO UPDATE instead of a read-then-write race.
    t.unique(['actor_id', 'item_id']);
  });

  // Install the deferred FK the M2 canvas migration left as a bare uuid column.
  // SET NULL, not CASCADE — see the header for why.
  await knex.schema.raw(`
    ALTER TABLE tokens
    ADD CONSTRAINT tokens_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE SET NULL
  `);
};

exports.down = async function (knex) {
  // Drop the FK before the table it references, mirroring how the M2 migration
  // drops campaigns_active_scene_id_fkey before dropping scenes.
  await knex.schema.raw(`
    ALTER TABLE tokens
    DROP CONSTRAINT IF EXISTS tokens_actor_id_fkey
  `);
  // inventory first: it references both of the others.
  await knex.schema.dropTableIfExists('inventory');
  await knex.schema.dropTableIfExists('items');
  await knex.schema.dropTableIfExists('actors');
};
