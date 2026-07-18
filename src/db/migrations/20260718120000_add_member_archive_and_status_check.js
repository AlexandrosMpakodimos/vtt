exports.up = async function (knex) {
  // Per-user, per-view archive. Lives on campaign_members (not campaigns)
  // because archiving is each member's own dashboard preference — the owner
  // archiving their view must not change what a player sees, and vice versa.
  // NULL = not archived; a timestamp = archived (and when). Reversible by
  // setting it back to NULL, exactly like campaigns.deleted_at.
  await knex.schema.alterTable('campaign_members', (t) => {
    t.timestamp('archived_at', { useTz: true });
  });

  // Enforce the status enum at the database, not only in application code.
  // This is a deliberate exception to the app-logic-not-DB-constraints
  // convention used elsewhere: status drives authorisation (banned/left/active
  // gate every join), so a typo'd value ('actve') silently mis-authorising is
  // worth a hard DB rejection. Knex has no portable CHECK builder for an
  // existing column, so it goes in as raw DDL; the down drops it by name.
  await knex.schema.raw(`
    ALTER TABLE campaign_members
    ADD CONSTRAINT campaign_members_status_check
    CHECK (status IN ('active', 'left', 'banned'))
  `);
};

exports.down = async function (knex) {
  await knex.schema.raw(`
    ALTER TABLE campaign_members
    DROP CONSTRAINT IF EXISTS campaign_members_status_check
  `);
  await knex.schema.alterTable('campaign_members', (t) => {
    t.dropColumn('archived_at');
  });
};
