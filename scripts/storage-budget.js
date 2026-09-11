// Storage budget operator CLI.
//
//   node scripts/storage-budget.js status      show the ledger + cleanup debt
//   node scripts/storage-budget.js report      DRY RUN reconciliation (writes nothing)
//   node scripts/storage-budget.js init        APPLY: initialise/refresh the ledger
//                                               from a full bucket inventory
//
// This is the operator surface the brief asks for, deliberately a CLI and NOT an
// HTTP route: turning byte/operation enforcement on is a deployment action, not
// something any signed-in user — GM included — may do. The project has no admin
// role and adding one to gate a route would be scope creep; a script run by
// whoever holds the database and R2 credentials is the right authority.
//
// `report` before `init`, always. `report` shows exactly what `init` will write
// and, critically, the ORPHAN COUNT — objects in the bucket that no row claims.
// Those are counted into the ledger (they cost real bytes) but NEVER deleted by
// this tool. Deleting unknown or live artwork to make a number look better is
// the mistake the brief forbids; `scripts/clean-bucket.js --delete` is the
// separate, deliberate path for removing reviewed orphans.
//
// After `init`, byte and operation enforcement is ACTIVE. Before it, the ledger
// is uninitialised and those limits are inactive (image-count and file-size
// limits are always active regardless).

require('dotenv').config();
const knex = require('../src/db');
const storage = require('../src/services/storage');
const budget = require('../src/services/storageBudget');
const recon = require('../src/services/storageReconcile');
const cleanup = require('../src/services/storageCleanup');

function fmtBytes(n) {
  if (n == null) return 'n/a';
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(3)} GB (${n} bytes)`;
  const mb = n / 1e6;
  if (mb >= 1) return `${mb.toFixed(2)} MB (${n} bytes)`;
  return `${n} bytes`;
}

function pct(used, limit) {
  if (!limit) return 'n/a';
  return `${((used / limit) * 100).toFixed(1)}%`;
}

async function showStatus() {
  const snap = await budget.snapshot();
  if (!snap) { console.log('No storage_budget row — run migrations.'); return; }
  const debt = await cleanup.debtReport();

  console.log('\n=== storage budget ===');
  console.log(`  initialised:        ${snap.initialised}  ${snap.initialised ? '(enforcement ACTIVE)' : '(enforcement INACTIVE — byte/op limits off)'}`);
  console.log(`  period:             ${snap.period_start} → ${snap.period_end}  [${snap.period_source}]`);
  console.log(`  reconciled_at:      ${snap.reconciled_at || 'never'}  complete=${snap.reconcile_complete}`);
  console.log('\n  bytes');
  console.log(`    committed:        ${fmtBytes(snap.bytes.committed)}`);
  console.log(`    reserved:         ${fmtBytes(snap.bytes.reserved)}`);
  console.log(`    cleanup debt:     ${fmtBytes(snap.bytes.cleanup_debt)}`);
  console.log(`    LIVE (sum):       ${fmtBytes(snap.bytes.live)}  of ${fmtBytes(snap.bytes.limit)}  = ${pct(snap.bytes.live, snap.bytes.limit)}`);
  console.log('\n  operations (this period)');
  console.log(`    Class A (PUT/LIST/COPY): ${snap.class_a.used} of ${snap.class_a.limit}  = ${pct(snap.class_a.used, snap.class_a.limit)}  (maint reserve ${snap.class_a.maintenance})`);
  console.log(`    Class B (GET/HEAD):      ${snap.class_b.used} of ${snap.class_b.limit}  = ${pct(snap.class_b.used, snap.class_b.limit)}  (maint reserve ${snap.class_b.maintenance})`);
  console.log('\n  cleanup queue');
  console.log(`    rows:             ${debt.count}  (stuck ≥5 attempts: ${debt.stuck})`);
  console.log(`    known debt bytes: ${fmtBytes(debt.knownBytes)}  unknown-size rows: ${debt.unknownSize}`);
  console.log('');
}

async function showReport(rep) {
  if (!rep.ok) {
    console.log(`\nReconciliation could NOT complete: ${rep.reason}`);
    console.log('The ledger was NOT changed. A partial inventory must not initialise a budget.');
    return;
  }
  console.log('\n=== reconciliation (DRY RUN) ===');
  console.log(`  bucket objects:     ${rep.objects}  (${rep.pages} list page(s))`);
  console.log(`  known keys (db):    ${rep.knownKeys}`);
  console.log(`  committed bytes:    ${fmtBytes(rep.committedBytes)}   (includes orphan bytes)`);
  console.log(`  reserved bytes:     ${fmtBytes(rep.reservedBytes)}`);
  console.log(`  cleanup debt bytes: ${fmtBytes(rep.cleanupBytes)}`);
  console.log(`  period would be:    ${rep.period.start} → ${rep.period.end}  [${rep.period.source}]`);
  console.log('\n  ORPHANS (in bucket, no row) — counted into the budget, NOT deleted:');
  console.log(`    count:            ${rep.orphanCount}`);
  console.log(`    bytes:            ${fmtBytes(rep.orphanBytes)}`);
  if (rep.orphans.length) {
    for (const o of rep.orphans.slice(0, 20)) {
      console.log(`      ${o.key}  ${fmtBytes(o.bytes)}`);
    }
    if (rep.orphanCount > 20) console.log(`      … and ${rep.orphanCount - 20} more`);
    console.log('    Review these. To remove reviewed orphans: scripts/clean-bucket.js --delete');
  }
  console.log(`\n  MISSING (row expects an object that is absent): ${rep.missingKnownKeys}`);
  console.log('');
}

(async () => {
  const cmd = process.argv[2] || 'status';

  if (!storage.isConfigured() && cmd !== 'status') {
    console.error('R2 is not configured in .env — reconciliation needs the bucket.');
    await knex.destroy();
    process.exit(1);
  }

  try {
    if (cmd === 'status') {
      await showStatus();
    } else if (cmd === 'report') {
      const rep = await recon.reconcile({ apply: false });
      await showReport(rep);
    } else if (cmd === 'init') {
      console.log('Running a full inventory and initialising the ledger…');
      const rep = await recon.reconcile({ apply: true });
      await showReport(rep);
      if (rep.applied) {
        console.log('APPLIED. Byte and operation enforcement is now ACTIVE.');
        console.log('Reads still bypass metering until the read gateway + public-access cutover are done —');
        console.log('the system is NOT free-tier-protected yet.');
        await showStatus();
      }
    } else {
      console.log('usage: node scripts/storage-budget.js [status|report|init]');
    }
  } catch (err) {
    console.error('storage-budget CLI failed:', err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
