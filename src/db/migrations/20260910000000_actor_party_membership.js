// Party membership is GM-managed roster visibility, independent of ownership
// and NPC statistic disclosure. The GM explicitly selects the initial party.
exports.up = async function (knex) {
  await knex.schema.alterTable('actors', (t) => {
    t.boolean('in_party').notNullable().defaultTo(false);
  });
};
exports.down = async function (knex) {
  await knex.schema.alterTable('actors', (t) => { t.dropColumn('in_party'); });
};
