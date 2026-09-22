// Production release entrypoint: never imported by application startup.
const { knexConfiguration, diagnostic } = require('../src/config/database');
async function run({ env = process.env, makeKnex = require('knex'), log = console.log, error = console.error } = {}) {
  let db;
  let failed = false;
  try {
    db = makeKnex(knexConfiguration(env, true));
    // afterCreate asserts public before even this first query can execute.
    // Explicit history schema plus rejection of shadow relations avoids adopting
    // another role's search-path history by accident.
    const result = await db.raw(`SELECT
      to_regclass('session') IS DISTINCT FROM to_regclass('public.session') OR
      to_regclass('knex_migrations') IS DISTINCT FROM to_regclass('public.knex_migrations') OR
      to_regclass('knex_migrations_lock') IS DISTINCT FROM to_regclass('public.knex_migrations_lock') AS shadowed`);
    if (result.rows[0].shadowed) {
      const e = new Error(); e.code = 'DB_SCHEMA_INVALID'; throw e;
    }
    const [, migrations] = await db.migrate.latest();
    log(`MIGRATION_OK: ${migrations.length} migration(s) applied.`);
  } catch (cause) {
    failed = true; error(diagnostic(cause));
  } finally {
    if (db) {
      try { await db.destroy(); } catch { failed = true; error('DB_CLOSE_FAILED: Migration connection cleanup failed.'); }
    }
  }
  return failed ? 1 : 0;
}
if (require.main === module) {
  run().then(code => { process.exitCode = code; }, () => {
    console.error('MIGRATION_FAILED: Migration runner failed.'); process.exitCode = 1;
  });
}
module.exports = { run };
