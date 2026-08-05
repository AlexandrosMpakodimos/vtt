// Image framing for portraits and token art (M6).
//
// A portrait is rarely square and rarely centred on its subject. Dropped into a
// token's square unmodified it crops badly — a head off the top edge, a figure
// against one side. This adds a per-image offset and scale so the art can be
// placed inside its frame once and render correctly everywhere afterwards.
//
// ---------------------------------------------------------------------------
// WHY REAL COLUMNS AND NOT A JSONB BLOB
// ---------------------------------------------------------------------------
// The obvious cheap answer is to put three numbers in `actors.data`, which
// already exists as the character's overflow. It is wrong for two reasons.
//
// First, `actors.data` is PLAYER-WRITABLE and documented as character
// description; framing is presentation, and mixing them means a validator for
// one has to reason about the other. Second, this data is FIXED-SHAPE — always
// exactly three numbers, always the same three — and the standing convention in
// this schema is that fixed-shape data gets columns while variable-shape data
// gets JSONB. That is the same argument that made `messages.whisper_to` a native
// array rather than a blob, and the same one that keeps `scenes.grid` as JSONB:
// the grid descriptor genuinely varies by grid type, this does not.
//
// `tokens.conditions` was also considered and rejected: it is documented as a
// visual icon array, and overloading it would be the `tokens.hidden`-in-
// `conditions` mistake in a new place.
//
// ---------------------------------------------------------------------------
// WHY BOTH TABLES
// ---------------------------------------------------------------------------
// Framing belongs to an IMAGE, and an image can live in either place. A linked
// token draws its art from the character, so framing the portrait once should
// frame every token of that character — the columns on `actors` do that. An
// UNLINKED token carries its own `img_url` and has no character to inherit from,
// so it needs its own. Putting them only on `actors` would leave every prop and
// ad-hoc marker unframeable; only on `tokens` would mean re-framing the same
// portrait for each of five goblins.
//
// The resolution order is the client's: a token's own framing if it has been
// set, otherwise its character's, otherwise the default. Server-side both are
// simply stored.
//
// ---------------------------------------------------------------------------
// WHY FRACTIONS RATHER THAN PIXELS
// ---------------------------------------------------------------------------
// The offsets are a fraction of the frame, not a pixel count. A pixel offset is
// wrong the moment the same portrait is used at a different size — and it will
// be, because token footprint follows creature size, so a Large creature's
// square is twice a Medium one's. A fraction renders identically at any zoom and
// any footprint.
//
// Defaults are the identity transform (0, 0, scale 1), which is exactly
// `object-fit: cover` — the behaviour before this migration. Existing rows
// therefore render unchanged, and framing is opt-in per image.

exports.up = async function up(knex) {
  await knex.schema.alterTable('actors', (t) => {
    t.decimal('img_offset_x', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_offset_y', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_scale', 6, 3).notNullable().defaultTo(1);
  });

  await knex.schema.alterTable('tokens', (t) => {
    t.decimal('img_offset_x', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_offset_y', 6, 3).notNullable().defaultTo(0);
    t.decimal('img_scale', 6, 3).notNullable().defaultTo(1);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('tokens', (t) => {
    t.dropColumn('img_scale');
    t.dropColumn('img_offset_y');
    t.dropColumn('img_offset_x');
  });
  await knex.schema.alterTable('actors', (t) => {
    t.dropColumn('img_scale');
    t.dropColumn('img_offset_y');
    t.dropColumn('img_offset_x');
  });
};
