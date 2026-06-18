exports.up = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('email_verified_at', { useTz: true }); // null = not yet verified
  });

  await knex.schema.createTable('email_verification_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.string('token_hash').notNullable(); // sha-256 of the raw token, never the raw token
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index('token_hash');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('email_verification_tokens');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('email_verified_at');
  });
};