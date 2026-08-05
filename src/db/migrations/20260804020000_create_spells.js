// Spells (M6) — deferred from M4 and built here.
//
// Structurally this is `items` + `inventory` a second time: a campaign-scoped
// CATALOGUE the GM authors, and a JOIN recording which character knows what.
// That is deliberate reuse rather than coincidence — the two features answer the
// same question about different nouns, so they get the same shape, the same
// atomic caps, the same two-step scoping, and the same disclosure gate.
//
// ---------------------------------------------------------------------------
// WHAT THE SERVER STORES AND WHAT IT REFUSES TO COMPUTE
// ---------------------------------------------------------------------------
// SCHEMA_REFERENCE records that the spell table was collapsed from seventeen
// columns to seven: school, casting time, range, duration, concentration,
// ritual, damage, save and attack all live in `properties`, because spells are
// DISPLAYED TEXT plus metadata, are never queried by those fields, and their
// effects are resolved by the Game Master.
//
// That collapse is the rules boundary expressed as a schema. A `damage` column
// invites something to roll it; a `concentration` column invites something to
// break it when the character is hit. Neither exists, so neither invitation is
// there to accept.
//
// `prepared` IS a real column, because it is a CHECKBOX a player ticks, not a
// computation. The server never counts prepared spells and never validates them
// against a limit. SCHEMA_REFERENCE's note that "race spells don't count against
// prepared limits" describes a rule of the source game; implementing that
// counting would be exactly the 5e rules engine this project excludes, so
// `source` is recorded and nothing is derived from it.
//
// ---------------------------------------------------------------------------
// NO `identified` EQUIVALENT, deliberately
// ---------------------------------------------------------------------------
// Items carry `identified` because loot is a surprise: the party finds a sword
// and does not know what it does. A spell in the catalogue is a rules reference
// — a player needs to read what Magic Missile does in order to cast it — so the
// catalogue is readable by every member in full.
//
// The confidentiality that actually matters here is not WHICH SPELLS EXIST but
// WHICH ONES THE VILLAIN HAS PREPARED, and that lives on the join, not the
// catalogue. It is enforced by reusing loadActorForInventory's gate rather than
// by adding a second flag: a player may read a player character's spellbook (the
// party shares a table) and never an NPC's. Adding `identified` here would be a
// second disclosure mechanism for a confidentiality question the first one
// already answers, and this project's two vulnerabilities were both about one
// resource having more locks than were kept in step.
//
// ---------------------------------------------------------------------------
// DEVIATIONS from SCHEMA_REFERENCE
// ---------------------------------------------------------------------------
//   1. spells.updated_at — the spec gives spells only created_at, but every
//      other column on the row is editable by the GM. Fourth instance of this
//      case after fog_of_war, items and combat; the precedent is settled.
//
//   2. actor_spells.created_at / updated_at — the spec gives the join none, and
//      `prepared` is mutable. Same as the inventory deviation in M4.
//
//   3. spells.folder_id is NOT created. `items` has one and `folders` exists,
//      but folders are unbuilt and nothing organises the catalogue yet. Adding
//      an unused foreign key now would be scaffolding for a feature that may
//      change shape; it is one migration to add when folders land.
//
// FOREIGN KEYS
//   spells.campaign_id           CASCADE — a catalogue without its campaign is
//     orphaned, and campaigns carry a 30-day soft delete before the sweep.
//   actor_spells.actor_id        CASCADE — SCHEMA_REFERENCE flags this
//     explicitly: "actor deletion must cascade to actor_spells when it lands".
//     M4's actor delete reports what it destroys, so that route now counts
//     spellbook rows as well.
//   actor_spells.spell_id        CASCADE — deleting a spell from the catalogue
//     removes it from every spellbook, exactly as deleting an item empties it
//     from every bag.

exports.up = async function up(knex) {
  await knex.schema.createTable('spells', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    // 0 is a cantrip, 9 the highest spell level. A BOUND, not a rule: nothing
    // derives slots, save DCs or anything else from it.
    t.integer('level').notNullable().defaultTo(0);
    t.text('description');
    t.jsonb('properties').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('campaign_id');
    // Listing a spellbook sorted by level is the one query the client always
    // makes, and it is the only ordering the schema needs to support.
    t.index(['campaign_id', 'level']);
  });

  await knex.schema.createTable('actor_spells', (t) => {
    t.uuid('actor_id').notNullable()
      .references('id').inTable('actors').onDelete('CASCADE');
    t.uuid('spell_id').notNullable()
      .references('id').inTable('spells').onDelete('CASCADE');
    t.boolean('prepared').notNullable().defaultTo(false);
    t.string('source', 30);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // COMPOSITE PRIMARY KEY, per SCHEMA_REFERENCE. It does the same work the
    // UNIQUE (actor_id, item_id) constraint does for inventory: knowing a spell
    // twice has no meaning, and without the constraint "add this spell to this
    // character" is a read followed by a write, which is a TOCTOU by
    // construction. With it the add is one INSERT ... ON CONFLICT.
    //
    // Note the difference from inventory, which needed a surrogate id because a
    // stack has a quantity that a route addresses directly. A spellbook row has
    // no such handle, so the natural key is the key.
    t.primary(['actor_id', 'spell_id']);
    t.index('actor_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('actor_spells');
  await knex.schema.dropTableIfExists('spells');
};
