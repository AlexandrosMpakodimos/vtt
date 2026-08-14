// A token's picture is INHERITED from its character, not copied from it.
//
// Before this, placing a token for a character copied that character's image
// and framing into the token row. The copy made inheritance a one-time EVENT
// rather than a relationship: editing a character's portrait left every token
// already on the board showing the old picture, because each carried its own
// copy. Reported as a bug, and it was one — the copy silently collapsed the
// distinction between a linked token and an unlinked one the moment either was
// created.
//
// NULL now means "ask the character". A value means "this token has its own
// picture", which is a real case — a wounded variant, a disguised NPC, a token
// deliberately given different art — and it still overrides permanently.
//
// ---------------------------------------------------------------------------
// WHY THE FRAMING COLUMNS HAVE TO CHANGE SHAPE
// ---------------------------------------------------------------------------
// They were created NOT NULL DEFAULT 0 / DEFAULT 1, which is exactly right for
// a value that is always the token's own and cannot express "inherit". A
// nullable column with no default can: omitting it stores NULL, and NULL is the
// question rather than an answer.
//
// The DEFAULTS are dropped as well as the NOT NULL. Keeping them would mean an
// insert that omits the column silently stores 0 and 1 — the identity
// transform — which looks identical to "no framing" and is not: it would pin a
// token to an un-transformed picture and never inherit again.
//
// `actors` is untouched. A character's framing IS always its own; it is the
// thing being inherited FROM.
//
// ---------------------------------------------------------------------------
// THE BACKFILL IS A HEURISTIC, AND IS LABELLED AS ONE
// ---------------------------------------------------------------------------
// Existing tokens already carry copies. Left alone, every token placed before
// today would keep its copied picture and never follow its character again —
// which is the reported symptom, unfixed for exactly the rows that produced the
// report.
//
// So a token's image and framing are cleared where they EQUAL the linked
// character's current values, on the assumption that equality means the value
// arrived by inheritance.
//
// That assumption can be wrong. A GM who deliberately set a token's picture to
// the same URL as its character's gets that intent erased, and the token starts
// following the character instead. The alternative — leaving every historical
// token pinned forever — is worse and affects far more rows, and the failure
// mode here is benign: the token displays the same image it displayed before,
// and only diverges if somebody later edits the character, which is the
// behaviour they would then be asking for.
//
// It is recorded as a heuristic rather than presented as a migration of known
// facts, because the information needed to do it exactly — whether a value was
// typed or inherited — was never stored. That is the actual lesson: the copy
// destroyed the provenance at the moment it was made.
//
// Unlinked tokens are untouched: with no character to ask, NULL would mean no
// picture at all rather than an inherited one.

exports.up = async function up(knex) {
  await knex.schema.alterTable('tokens', (t) => {
    t.decimal('img_offset_x', 6, 3).nullable().defaultTo(null).alter();
    t.decimal('img_offset_y', 6, 3).nullable().defaultTo(null).alter();
    t.decimal('img_scale', 6, 3).nullable().defaultTo(null).alter();
  });

  // Clear values that match the linked character's. See the header: this is a
  // heuristic, and `actor_id IS NOT NULL` keeps it away from tokens that have
  // nothing to inherit from.
  await knex.raw(`
    UPDATE tokens t
       SET img_url      = NULL,
           img_offset_x = NULL,
           img_offset_y = NULL,
           img_scale    = NULL
      FROM actors a
     WHERE t.actor_id = a.id
       AND t.img_url IS NOT DISTINCT FROM a.img_url
  `);

  // Framing is cleared independently of the picture: a token can legitimately
  // have inherited the picture and then been re-framed on its own, and that
  // re-framing is the token's, not the character's.
  await knex.raw(`
    UPDATE tokens t
       SET img_offset_x = NULL,
           img_offset_y = NULL,
           img_scale    = NULL
      FROM actors a
     WHERE t.actor_id = a.id
       AND t.img_offset_x = a.img_offset_x
       AND t.img_offset_y = a.img_offset_y
       AND t.img_scale    = a.img_scale
  `);
};

exports.down = async function down(knex) {
  // Going back requires the columns to be NOT NULL again, so every NULL has to
  // become something. The identity transform is the only defensible answer —
  // the original value is not recoverable, because "inherited" was never
  // recorded as distinct from "copied". Rolling back therefore loses the
  // inheritance and pins each token to what it happens to show.
  await knex.raw(`
    UPDATE tokens SET
      img_offset_x = COALESCE(img_offset_x, 0),
      img_offset_y = COALESCE(img_offset_y, 0),
      img_scale    = COALESCE(img_scale, 1)
  `);
  await knex.raw(`
    UPDATE tokens t SET img_url = a.img_url
      FROM actors a
     WHERE t.actor_id = a.id AND t.img_url IS NULL
  `);
  await knex.schema.alterTable('tokens', (t) => {
    t.decimal('img_offset_x', 6, 3).notNullable().defaultTo(0).alter();
    t.decimal('img_offset_y', 6, 3).notNullable().defaultTo(0).alter();
    t.decimal('img_scale', 6, 3).notNullable().defaultTo(1).alter();
  });
};
