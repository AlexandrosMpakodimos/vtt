// Read-only dry run of the Fix 3 migration's pre-check
// (src/db/migrations/20261007000000_redundancy_cleanup.js) against the production
// database, BEFORE the release is installed. It reports the campaigns whose
// is_public disagrees with (password_hash IS NULL) and the combat rows whose
// campaign_id is not their scene's, and exits non-zero if either would make the
// migration refuse (so the release can be postponed while the live site still
// runs the old code). It also reports, without refusing, how many assets.source /
// source_url and messages.type values differ from what the code would compute.
//
// It changes nothing: the pre-check only SELECTs, and it runs inside a READ ONLY
// transaction, so PostgreSQL refuses any write. Connection rules are migrate-production.js's
// (DIRECT_DATABASE_URL, NODE_ENV=production, verified TLS); prints counts only,
// never row contents or connection details.
//
// Exit codes: 0 = the migration can run, 2 = it would refuse, 1 = could not check.
const { knexConfiguration, diagnostic } = require('../src/config/database');
const { _internals } = require('../src/db/migrations/20261007000000_redundancy_cleanup');

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
