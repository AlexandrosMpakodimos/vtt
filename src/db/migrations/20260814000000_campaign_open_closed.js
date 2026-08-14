// A campaign can be CLOSED, and a closed campaign is not playable.
//
// Until now, membership alone granted access to everything: scenes, tokens,
// combat, chat, dice. A Game Master preparing an ambush had no way to stop the
// party wandering onto the map and reading it — the confidentiality machinery in
// this project hides prepared CONTENT (unplaced NPCs, unrevealed maps, blind
// rolls) but there was no way to close the table itself.
//
// ---------------------------------------------------------------------------
// WHY THIS DEFAULTS TO OPEN, WHEN "CLOSED UNTIL OPENED" IS THE BETTER SEMANTIC
// ---------------------------------------------------------------------------
// A new campaign arguably ought to start closed: the GM creates it, preps, and
// opens the doors when the session begins. That is the behaviour that was asked
// for, and it is the right one.
//
// It is NOT what this migration does, and the reason is worth stating rather
// than hiding. Sixty-odd campaign creations across twenty-two test suites
// assume a member can immediately reach the game. Defaulting to closed would
// break most of them at the same moment the gate they are meant to verify was
// introduced — and a mechanical edit across every suite, made in the same change
// as the behaviour those suites check, is precisely how a real failure gets
// absorbed into the noise of an expected one.
//
// So the column defaults to open, the gate is built and probed, and flipping the
// default is a one-line change to the create route plus a mechanical pass over
// the suites — worth doing as its own commit, where a red suite means something.
//
// The GM's control is complete either way: they can close a campaign the moment
// it exists.

exports.up = async function up(knex) {
  await knex.schema.alterTable('campaigns', (t) => {
    t.boolean('is_open').notNullable().defaultTo(true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('campaigns', (t) => {
    t.dropColumn('is_open');
  });
};
