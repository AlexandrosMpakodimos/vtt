// M2 canvas: scenes + tokens.
//
// Columns follow SCHEMA_REFERENCE.md verbatim, with two deliberate, documented
// deviations recorded here and in SCHEMA_REFERENCE at session end:
//
//   1. scenes.folder_id is added as a NULLABLE COLUMN WITHOUT its FK constraint.
//      The folders table is not migrated yet (it lands with a later milestone),
//      so the constraint cannot be created now. This mirrors exactly how the
//      campaigns migration deferred active_scene_id: keep the column for schema
//      fidelity, add the constraint when its target table exists.
//
//   2. tokens.created_by (UUID -> users.id, NULL) is NOT in SCHEMA_REFERENCE.
//      It is added because the M2-canvas placement/movement rules are
//      server-authoritative and per-user: a player may place ONE token and may
//      move ONLY tokens they placed, while the GM places/moves any. actor_id
//      (the schema's identity link) stays NULL this pass by design, so it cannot
//      carry placer identity. created_by records who placed a token so those
//      rules can be enforced at the server. NULL = not attributable to a player
//      (system/GM-tool placement or, later, an actor-linked token).
//
// This migration also installs the deferred circular FK campaigns.active_scene_id
// -> scenes.id, which the campaigns migration explicitly left "for the scenes
// migration". It is ON DELETE SET NULL: deleting the active scene must not
// cascade-delete the campaign — it just unsets the pointer.

exports.up = async function (knex) {
  await knex.schema.createTable('scenes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    // FK constraint deferred until the folders table exists (see header note 1).
    t.uuid('folder_id');
    t.string('name', 100).notNullable();
    t.text('img_url');
    // Canvas dimensions in pixels; the schema's reasonable starting canvas.
    t.integer('width').notNullable().defaultTo(1400);
    t.integer('height').notNullable().defaultTo(1050);
    // {size, type, color, opacity} — grid config, flexible without schema churn.
    t.jsonb('grid').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('campaign_id'); // scene list per campaign
  });

  await knex.schema.createTable('tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scene_id').notNullable()
      .references('id').inTable('scenes').onDelete('CASCADE');
    // actor_id stays NULL this pass — actors land in M4. NULL = standalone /
    // decorative token (name + image only).
    t.uuid('actor_id');
    // Who placed this token. NOT in SCHEMA_REFERENCE — added for the per-user
    // placement/movement rules (see header note 2). NULL = not player-owned.
    // ON DELETE SET NULL: deleting a user must not vaporise their placed tokens
    // out from under a running scene; the token stays, just loses attribution.
    t.uuid('created_by')
      .references('id').inTable('users').onDelete('SET NULL');
    t.string('name', 100);
    t.text('img_url');
    // Grid coordinates and size in GRID UNITS (1 = one square), not pixels.
    t.decimal('x').notNullable().defaultTo(0);
    t.decimal('y').notNullable().defaultTo(0);
    t.decimal('width').notNullable().defaultTo(1);
    t.decimal('height').notNullable().defaultTo(1);
    t.decimal('rotation').notNullable().defaultTo(0);
    t.boolean('hidden').notNullable().defaultTo(false);
    t.boolean('locked').notNullable().defaultTo(false);
    // The single HP bar every VTT shows. Nullable: a decorative token has no HP.
    t.integer('bar1_value');
    t.integer('bar1_max');
    // Visual status icons, e.g. ["Poisoned","Blessed"].
    t.jsonb('conditions').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('scene_id'); // every scene load fetches all tokens for that scene
  });

  // Install the deferred circular FK the campaigns migration left for us.
  // SET NULL, not CASCADE: an active scene being deleted unsets the pointer,
  // it does not delete the campaign.
  await knex.schema.raw(`
    ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_active_scene_id_fkey
    FOREIGN KEY (active_scene_id) REFERENCES scenes(id) ON DELETE SET NULL
  `);
};

exports.down = async function (knex) {
  // Drop the circular FK before the table it references.
  await knex.schema.raw(`
    ALTER TABLE campaigns
    DROP CONSTRAINT IF EXISTS campaigns_active_scene_id_fkey
  `);
  await knex.schema.dropTableIfExists('tokens');
  await knex.schema.dropTableIfExists('scenes');
};
