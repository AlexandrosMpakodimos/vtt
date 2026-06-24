exports.up = async function (knex) {
  await knex.schema.alterTable('email_verification_tokens', (t) => {
    // Distinguishes a signup-verification token from an email-change token so
    // each route can only consume its own kind. Existing rows backfill to 'signup'.
    t.string('purpose').notNullable().defaultTo('signup');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('email_verification_tokens', (t) => {
    t.dropColumn('purpose');
  });
};