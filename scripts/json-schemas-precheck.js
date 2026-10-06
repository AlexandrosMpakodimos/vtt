// Read-only dry run of the Fix 2 migration's pre-check
// (src/db/migrations/20261006000000_json_schemas.js) against the production
// database, BEFORE the release is installed. It reports, per table, how many rows
// the migration will rewrite and how many unknown keys it will remove, and exits
// non-zero if any row would make the migration refuse (so the release can be
// postponed while the live site still runs the old code).
//
// It changes nothing: the pre-check only SELECTs, and it runs inside a READ ONLY
// transaction, so PostgreSQL refuses any write. Connection rules are migrate-production.js's
// (DIRECT_DATABASE_URL, NODE_ENV=production, verified TLS); prints counts and key
// names only, never row contents or connection details.
const { knexConfiguration, diagnostic } = require('../src/config/database');
const { _internals } = require('../src/db/migrations/20261006000000_json_schemas');

async function run({ env = process.env, makeKnex = require('knex'), log = console.log, error = console.error } = {}) {
  let db;
  let code = 0;
  try {
    db = makeKnex(knexConfiguration(env, true));
    const result = await db.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      return _internals.precheck(trx);
    });
    for (const line of result.report) log(`PRECHECK ${line}`);
    if (result.problems.length) {
      error(`PRECHECK_REFUSED: the migration would stop with no changes: ${result.problems.join('; ')}`);
      code = 2;
    } else {
      log('PRECHECK_OK: the migration can run.');
    }
  } catch (cause) {
    code = 1; error(diagnostic(cause));
  } finally {
    if (db) {
      try { await db.destroy(); } catch { code = code || 1; error('DB_CLOSE_FAILED: Connection cleanup failed.'); }
    }
  }
  return code;
}

if (require.main === module) {
  run().then((c) => { process.exitCode = c; }, () => {
    console.error('PRECHECK_FAILED: Pre-check runner failed.'); process.exitCode = 1;
  });
}
module.exports = { run };
