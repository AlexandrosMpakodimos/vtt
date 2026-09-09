// Avatar framing — the same "position & zoom an image inside a square" transform
// the actors and tokens tables already carry, now for a user's profile picture.
//
// An avatar renders in a circle/square (profile card, campaign member list), so
// a portrait whose subject is off-centre crops badly — exactly the problem the
// frame tool solves for tokens. These three columns store the chosen transform.
//
// Defaults are the identity transform (0, 0, scale 1) = `object-fit: cover`, the
// behaviour before this migration, so every existing row renders unchanged and
// framing is opt-in per avatar. NOT NULL with a default (unlike tokens, which
// are nullable to express "inherit"): a user has nothing to inherit from, so the
// numbers are always concrete.

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.decimal('avatar_offset_x', 6, 3).notNullable().defaultTo(0);
    t.decimal('avatar_offset_y', 6, 3).notNullable().defaultTo(0);
    t.decimal('avatar_scale', 6, 3).notNullable().defaultTo(1);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('avatar_offset_x');
    t.dropColumn('avatar_offset_y');
    t.dropColumn('avatar_scale');
  });
};
