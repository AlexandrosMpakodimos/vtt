// Controlled-upload support: idempotency and attempt accounting on assets.
//
// The server-proxied upload path (POST /api/assets/upload) replaces the
// replayable presigned-PUT grant. Two columns support its guarantees:
//
// idempotency_key — a client-supplied key (per logical upload) that makes
//   completion idempotent. A network hiccup that makes a client retry the whole
//   upload must not create a second object, a second row, or a second set of
//   budget charges. The first request with a given key does the work; a repeat
//   with the same key returns the SAME asset. Unique per user so one user's key
//   cannot collide with or read another's upload.
//
// upload_attempts — how many actual R2 write attempts this asset's bytes cost.
//   The SDK is pinned to one attempt per call and the route charges one Class A
//   permit per attempt, so this column is the audit trail proving the number of
//   billed operations equals the number the budget counted. Retodes on retry.

exports.up = async function up(knex) {
  await knex.schema.alterTable('assets', (t) => {
    t.text('idempotency_key');
    t.integer('upload_attempts').notNullable().defaultTo(0);
    // One key per user: the same key from the same user is the same logical
    // upload; different users may coincidentally choose the same string. A
    // partial index would be ideal (only non-null), but a plain unique over
    // (user_id, idempotency_key) already permits many NULLs in Postgres (NULLs
    // are distinct), so external links and presigned rows with no key are
    // unaffected.
    t.unique(['user_id', 'idempotency_key']);
    t.check('upload_attempts >= 0', {}, 'assets_upload_attempts_nonneg');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('assets', (t) => {
    t.dropUnique(['user_id', 'idempotency_key']);
    t.dropColumn('idempotency_key');
    t.dropColumn('upload_attempts');
  });
};
