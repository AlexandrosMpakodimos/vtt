exports.up = async function (knex) {
  await knex.schema.createTable('campaigns', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // The owner IS the GM — the role is derived, not stored. Transferable.
    t.uuid('owner_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.text('description');
    t.text('img_url');
    // public = listed, no password. private = listed, password required.
    t.boolean('is_public').notNullable().defaultTo(false);
    t.string('password_hash', 255); // null for public campaigns
    // Circular FK to scenes; scenes don't exist yet, so the constraint lands
    // with the scenes migration (M3). Nullable either way — set after creation.
    t.uuid('active_scene_id');
    t.jsonb('settings').notNullable().defaultTo('{}');
    // Soft delete: recoverable for 30 days, then swept. EVERY listing query
    // must filter deleted_at IS NULL or deleted campaigns leak back into search.
    t.timestamp('deleted_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('owner_id');                    // "campaigns I own"
    t.index(['deleted_at', 'name']);        // search: live rows, ordered/filtered by name
  });

  await knex.schema.createTable('campaign_members', (t) => {
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    t.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // 'active' | 'left' | 'banned'. Rows are NEVER deleted — membership is a
    // persistent history. Live presence lives in the socket layer, not here.
    t.string('status', 20).notNullable().defaultTo('active');
    t.string('color', 7);
    t.timestamp('joined_at', { useTz: true }).defaultTo(knex.fn.now());

    // One row per person per campaign, ever.
    t.primary(['campaign_id', 'user_id']);
    t.index('user_id');      // the "my campaigns" dashboard query
    t.index('campaign_id');  // member list per campaign
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('campaign_members');
  await knex.schema.dropTableIfExists('campaigns');
};
