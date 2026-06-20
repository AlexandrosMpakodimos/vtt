exports.up = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('pending_email'); // staged new email, awaiting confirmation via a link sent to it
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('pending_email');
  });
};
