// Chat speaker attribution + unique per-campaign member colours.
//
// Two small features that share a migration because they land together and are
// both about the same thing: making it obvious at a glance who is speaking.
//
// ---------------------------------------------------------------------------
// 1. messages.speaker_role and messages.speaker_as
// ---------------------------------------------------------------------------
// A line in the log should read "AlexBako (DM)" or "Maria (Aria)". Two pieces of
// information are missing to render that, and both are added here rather than
// derived at render time.
//
// WHY NOT DERIVE THE ROLE. The Game Master is derivable — campaigns.owner_id is
// the single source of truth for it, and SCHEMA_REFERENCE is explicit that there
// is no `role` column on campaign_members precisely because storing it twice
// invites disagreement. That reasoning is about MEMBERSHIP, which is current
// state. A message is not current state: it is an immutable record of something
// that happened, and OWNERSHIP CAN BE TRANSFERRED. Deriving the role at render
// would silently relabel every historical message the moment the GM changes —
// a log that rewrites its own history is worse than a duplicated fact.
//
// This is the same argument that already justifies speaker_name being
// denormalized rather than joined from users: the log must keep saying what it
// said, even after the world moves on. speaker_role is that argument applied to
// a second field.
//
// WHY speaker_as IS SEPARATE FROM speaker_name. speaker_name stays the
// authenticated username and is still taken from the session, never the body —
// break-combat.js has a probe asserting it cannot be forged, and that probe must
// keep meaning what it means. speaker_as is the CHARACTER a player chose to
// speak as, which is a different fact and is nullable because speaking as
// yourself is normal.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT ADD: an "active character" column
// ---------------------------------------------------------------------------
// M4 considered and rejected an `actors.is_active` flag. Its reasoning was that
// "active" dissolves into three things that need no column: which sheet opens by
// default (client state), which character a token represents (already on the
// token), and whose turn it is (the initiative order).
//
// "Who am I speaking as" is a FOURTH thing that reasoning did not cover — but it
// still does not need a column, because it is a property of A MESSAGE rather
// than of a character. It is chosen per line and recorded on the line, which is
// how Roll20 and Foundry both do it: a speaker dropdown, not a mode. The client
// remembers the last choice locally, and that local memory IS the "active"
// default M4 predicted it would turn out to be.
//
// The invariant M4 was unwilling to enforce — exactly one active character per
// player, atomically, with a defined answer for tokens referencing a
// just-deactivated character — is therefore still not needed.
//
// ---------------------------------------------------------------------------
// 2. UNIQUE (campaign_id, color) on campaign_members
// ---------------------------------------------------------------------------
// Two players with the same colour makes the colour useless as identification,
// which is the entire point of having one.
//
// A PARTIAL UNIQUE INDEX, not an application check. This is the standing
// "no more than N of X" constraint in its strictest form (N = 1 per colour per
// campaign), and a database constraint satisfies it NATIVELY: two players
// clicking the same swatch simultaneously race at the index and one receives a
// conflict, with no read-then-write anywhere for a TOCTOU to live in. It needs
// no withAtomicCap wrapper because there is no count to read.
//
// SCOPED TO `color IS NOT NULL` so that the many members with no colour chosen
// do not collide with each other on NULL. (Postgres treats NULLs as distinct in
// a unique index anyway; the predicate makes the intent explicit and keeps the
// index small.)
//
// NOT scoped to status = 'active', deliberately. Freeing a departed member's
// colour is tempting, but it means rejoining or being unbanned can FAIL because
// somebody took your old colour in the meantime — a status change that errors is
// worse than a slightly smaller palette. The member cap is 8, so a curated
// palette is never close to exhausted.

exports.up = async function up(knex) {
  await knex.schema.alterTable('messages', (t) => {
    // 'gm' | 'player', stamped at send time. Nullable so rows written before
    // this migration read as "unknown" rather than being asserted to be wrong.
    t.string('speaker_role', 20);
    // The character the sender chose to speak as. NULL means "as myself".
    // Matches actors.name's length.
    t.string('speaker_as', 100);
  });

  // Existing rows may already hold duplicate colours: the join flow accepted a
  // colour with no uniqueness check, so the index cannot simply be created.
  // Keep the EARLIEST claimant of each colour and clear the rest — earliest
  // rather than arbitrary, so the outcome is deterministic and the person who
  // picked it first keeps it.
  await knex.raw(`
    UPDATE campaign_members m
       SET color = NULL
     WHERE m.color IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM campaign_members e
          WHERE e.campaign_id = m.campaign_id
            AND e.color       = m.color
            AND (e.joined_at < m.joined_at
                 OR (e.joined_at = m.joined_at AND e.user_id < m.user_id))
       )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX campaign_members_campaign_color_unique
        ON campaign_members (campaign_id, color)
     WHERE color IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS campaign_members_campaign_color_unique');
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('speaker_as');
    t.dropColumn('speaker_role');
  });
};
