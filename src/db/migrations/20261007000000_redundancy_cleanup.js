// Fix 3 of the schema review (claude/SCHEMA_RULES.md, rule D, decided
// 2026-10-05): remove stored values that can be derived, and declare the one
// redundancy that stays. One migration, one transaction (Knex wraps each
// migration in a transaction and PostgreSQL DDL is transactional), so a failed
// pre-check or constraint leaves the schema exactly as it was.
//
//   D1  campaigns.is_public   = (password_hash IS NULL). The code already kept
//                               the two in step on every write; password_hash is
//                               now the single fact and the API computes is_public.
//   D1  assets.source         = 'upload' when storage_key is set, else 'external'
//                               ('imported' was never written). The API computes it.
//   D1  assets.source_url     only ever a copy of url, for external links.
//   A1  messages.type         nothing read it (rendering uses roll_data and
//                               whisper_to), and the API let a caller store a value
//                               that contradicted the row ('whisper' with no
//                               recipients, 'system' from a player).
//   D2  combat.campaign_id    kept for scoped lookups and socket rooms, now with a
//                               declared constraint: UNIQUE (id, campaign_id) on
//                               scenes and a composite FK combat (scene_id,
//                               campaign_id) -> scenes (id, campaign_id), ON DELETE
//                               CASCADE like the scene_id FK it replaces. The
//                               single-column FK is dropped: the composite one
//                               already guarantees the scene exists.
//
// PRE-CHECK. Before anything changes, the migration counts
//   - campaigns whose is_public disagrees with (password_hash IS NULL): dropping
//     the column would silently change their visibility;
//   - combat rows whose campaign_id is not their scene's campaign: the new FK
//     would refuse them.
// If either count is non-zero it stops, printing names and counts (never row
// contents). It also REPORTS, without stopping, the rows where assets.source /
// source_url or messages.type differ from what the code would compute: those
// values are dropped as unreliable (rule D1/A1), and `down` restores the
// computed value, not the stored one. scripts/redundancy-precheck.js runs the
// same pre-check read-only against production before a release.
//
// DOWN re-creates the three dropped columns with their original types and
// defaults and backfills them from the computed values (messages.type the way
// the old POST route chose it: 'roll' for a roll, otherwise 'whisper' for a
// whisper, otherwise 'chat'), then puts the single-column combat FK back.

const SCENES_UNIQUE = 'scenes_id_campaign_id_unique';
const COMBAT_SCENE_FK = 'combat_scene_campaign_fkey';
const OLD_COMBAT_SCENE_FK = 'combat_scene_id_foreign';

// Each pre-check query counts rows; `stop` decides whether a non-zero count
// refuses the migration or is only reported.
const CHECKS = [
  {
    name: 'campaigns.is_public <> (password_hash IS NULL)',
    stop: true,
    sql: 'SELECT count(*)::int AS n FROM campaigns WHERE is_public <> (password_hash IS NULL)',
  },
  {
    name: 'combat.campaign_id <> its scene\'s campaign_id',
    stop: true,
    sql: `SELECT count(*)::int AS n FROM combat c
          WHERE NOT EXISTS (SELECT 1 FROM scenes s WHERE s.id = c.scene_id AND s.campaign_id = c.campaign_id)`,
  },
  {
    name: 'assets.source differs from the computed value',
    stop: false,
    sql: `SELECT count(*)::int AS n FROM assets
          WHERE source IS DISTINCT FROM (CASE WHEN storage_key IS NULL THEN 'external' ELSE 'upload' END)`,
  },
  {
    name: 'assets.source_url differs from the computed value',
    stop: false,
    sql: `SELECT count(*)::int AS n FROM assets
          WHERE source_url IS DISTINCT FROM (CASE WHEN storage_key IS NULL THEN url END)`,
  },
  {
    name: 'messages.type differs from the computed value',
    stop: false,
    sql: `SELECT count(*)::int AS n FROM messages
          WHERE type IS DISTINCT FROM (CASE WHEN roll_data IS NOT NULL THEN 'roll'
                                            WHEN whisper_to IS NOT NULL THEN 'whisper'
                                            ELSE 'chat' END)`,
  },
];

// Reads only; changes nothing. Returns the per-check report and the problems
// that would stop the migration.
async function precheck(knex) {
  const report = [];
  const problems = [];
  for (const check of CHECKS) {
    const { rows } = await knex.raw(check.sql);
    const n = rows[0].n;
    report.push(`${check.name}: ${n}${check.stop ? '' : ' (reported only)'}`);
    if (check.stop && n) problems.push(`${check.name}: ${n}`);
  }
  return { report, problems };
}

exports.up = async function up(knex) {
  const { report, problems } = await precheck(knex);
  console.log(`REDUNDANCY_PRECHECK: ${report.join('; ')}`);
  if (problems.length) {
    // The production runner prints only a generic code for a failure, so the
    // summary goes to stderr here (names and counts only).
    console.error(`REDUNDANCY_PRECHECK_FAILED (no changes made): ${problems.join('; ')}`);
    const error = new Error(`redundancy cleanup pre-check failed: ${problems.join('; ')}`);
    error.code = 'REDUNDANCY_PRECHECK';
    throw error;
  }

  await knex.schema.alterTable('campaigns', (t) => { t.dropColumn('is_public'); });
  await knex.schema.alterTable('assets', (t) => { t.dropColumns('source', 'source_url'); });
  await knex.schema.alterTable('messages', (t) => { t.dropColumn('type'); });

  await knex.raw('ALTER TABLE scenes ADD CONSTRAINT ?? UNIQUE (id, campaign_id)', [SCENES_UNIQUE]);
  await knex.raw(`ALTER TABLE combat ADD CONSTRAINT ?? FOREIGN KEY (scene_id, campaign_id)
    REFERENCES scenes (id, campaign_id) ON DELETE CASCADE`, [COMBAT_SCENE_FK]);
  await knex.raw('ALTER TABLE combat DROP CONSTRAINT ??', [OLD_COMBAT_SCENE_FK]);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE combat ADD CONSTRAINT ?? FOREIGN KEY (scene_id)
    REFERENCES scenes (id) ON DELETE CASCADE`, [OLD_COMBAT_SCENE_FK]);
  await knex.raw('ALTER TABLE combat DROP CONSTRAINT IF EXISTS ??', [COMBAT_SCENE_FK]);
  await knex.raw('ALTER TABLE scenes DROP CONSTRAINT IF EXISTS ??', [SCENES_UNIQUE]);

  // Original definitions: 20260718000000_create_campaigns.js,
  // 20260809000000_create_assets.js, 20260803010000_create_messages.js.
  await knex.schema.alterTable('campaigns', (t) => { t.boolean('is_public').notNullable().defaultTo(false); });
  await knex.raw('UPDATE campaigns SET is_public = (password_hash IS NULL)');

  await knex.schema.alterTable('assets', (t) => {
    t.text('source_url');
    t.string('source', 20).notNullable().defaultTo('upload');
  });
  await knex.raw(`UPDATE assets SET
    source = CASE WHEN storage_key IS NULL THEN 'external' ELSE 'upload' END,
    source_url = CASE WHEN storage_key IS NULL THEN url END`);

  await knex.schema.alterTable('messages', (t) => { t.string('type', 20).notNullable().defaultTo('chat'); });
  await knex.raw(`UPDATE messages SET type = CASE WHEN roll_data IS NOT NULL THEN 'roll'
                                                  WHEN whisper_to IS NOT NULL THEN 'whisper'
                                                  ELSE 'chat' END`);
};

// Exported for the migration test and scripts/redundancy-precheck.js.
exports._internals = { CHECKS, precheck, SCENES_UNIQUE, COMBAT_SCENE_FK, OLD_COMBAT_SCENE_FK };
