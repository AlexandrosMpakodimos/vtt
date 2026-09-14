// Reconciliation + ledger initialisation — against real Postgres, NO server.
//
//   SKIP_HIBP=1 node test-storage-reconcile.js
//
// storage.listPage / isConfigured are stubbed so a deterministic "bucket" can be
// presented without R2. The DB side is real: known-key gathering reads real
// assets / storage_cleanup rows, and apply writes the real ledger. Proves:
// classification (committed/reserved/cleanup/orphan), dry-run writes nothing,
// apply initialises truthfully, orphans are counted but never deleted, and an
// incomplete inventory refuses to initialise.

const knex = require('./src/db');
const storage = require('./src/services/storage');
const budget = require('./src/services/storageBudget');

// Stub storage BEFORE requiring the reconciler.
storage.isConfigured = () => true;
let PAGES = [];       // array of { objects:[{key,bytes,etag}], nextToken }
let listShouldThrow = false;
storage.listPage = async ({ continuationToken } = {}) => {
  if (listShouldThrow) throw new Error('simulated list failure');
  const idx = continuationToken ? Number(continuationToken) : 0;
  const page = PAGES[idx] || { objects: [], nextToken: null };
  return page;
};

const recon = require('./src/services/storageReconcile.js');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Helpers to shape a paged inventory from a flat object list.
function singlePage(objects) { return [{ objects, nextToken: null }]; }

async function resetLedger({ init = false } = {}) {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0,
    class_a_used: 0, class_b_used: 0,
    period_start: init ? knex.raw("now()") : null,
    period_end: init ? knex.raw("now() + interval '30 days'") : null,
    period_source: 'assumed', reconciled_at: null, reconcile_complete: false,
  });
}

async function clearRows() {
  await knex('storage_cleanup').del();
  await knex('assets').del();
}

async function main() {
  if (!(await knex('storage_budget').where({ id: true }).first())) {
    console.log('  FAIL  run migrations'); console.log('\n0 passed, 1 failed'); process.exit(1);
  }

  console.log('\n--- classify is pure: committed / reserved / cleanup / orphan ---');
  {
    const inv = new Map([
      ['c/1/map/a.png', { bytes: 1000, etag: 'x' }],   // ready -> committed
      ['c/1/map/b.png', { bytes: 500, etag: 'y' }],    // pending -> reserved
      ['c/1/map/c.png', { bytes: 200, etag: 'z' }],    // cleanup -> cleanup
      ['c/1/map/orphan.png', { bytes: 9999, etag: 'o' }], // no row -> orphan
    ]);
    const known = new Map([
      ['c/1/map/a.png', { class: 'committed', dbBytes: 1000 }],
      ['c/1/map/b.png', { class: 'reserved', dbBytes: null }],
      ['c/1/map/c.png', { class: 'cleanup', dbBytes: 200 }],
      ['c/1/map/missing.png', { class: 'committed', dbBytes: 50 }], // no object
    ]);
    const r = recon.classify(inv, known);
    t('committed sums ready objects', r.committedBytes === 1000 + 9999, `got ${r.committedBytes}`);
    t('reserved sums pending objects', r.reservedBytes === 500);
    t('cleanup sums queued objects', r.cleanupBytes === 200);
    t('the unowned object is an orphan', r.orphans.length === 1 && r.orphans[0].key === 'c/1/map/orphan.png');
    t('orphan bytes are counted against committed', r.committedBytes >= 9999);
    t('a known key with no object is reported missing', r.missing === 1);
    t('sizes come from the INVENTORY, not the db value', r.committedBytes === 10999,
      'db said a.png was 1000; inventory agreed; orphan added 9999');
  }

  console.log('\n--- knownKeys reads real rows ---');
  await clearRows();
  // insert a ready asset, a pending asset, a cleanup row
  const camp = await knex('campaigns').insert({
    name: 'recon-test', owner_id: null,
  }).returning('id').catch(async () => {
    // campaigns may require owner_id; make a user first
    const [u] = await knex('users').insert({
      email: `recon-${Date.now()}@x.com`, username: `recon${Date.now()}`, password_hash: 'x',
    }).returning('id');
    return knex('campaigns').insert({ name: 'recon-test', owner_id: u.id }).returning('id');
  });
  const campaignId = Array.isArray(camp) ? camp[0].id || camp[0] : camp;
  await knex('assets').insert([
    { campaign_id: campaignId, storage_key: 'c/x/map/ready.png', url: 'u1', kind: 'map', status: 'ready', bytes: 1234, bytes_verified: true },
    { campaign_id: campaignId, storage_key: 'c/x/map/pending.png', url: 'u2', kind: 'map', status: 'pending' },
  ]);
  await knex('storage_cleanup').insert({ storage_key: 'c/x/map/trash.png', bytes: 77, reason: 'delete_failed' });
  const known = await recon.knownKeys();
  t('ready asset is known as committed', known.get('c/x/map/ready.png').class === 'committed');
  t('pending asset is known as reserved', known.get('c/x/map/pending.png').class === 'reserved');
  t('cleanup row is known as cleanup', known.get('c/x/map/trash.png').class === 'cleanup');
  t('a verified ready row carries its db bytes', known.get('c/x/map/ready.png').dbBytes === 1234);
  t('a pending row carries no trusted bytes', known.get('c/x/map/pending.png').dbBytes === null);

  console.log('\n--- DRY RUN reports but writes nothing ---');
  await resetLedger({ init: false });
  PAGES = singlePage([
    { key: 'c/x/map/ready.png', bytes: 1234, etag: 'a' },
    { key: 'c/x/map/pending.png', bytes: 600, etag: 'b' },
    { key: 'c/x/map/trash.png', bytes: 77, etag: 'c' },
    { key: 'c/x/map/UNKNOWN.png', bytes: 5000, etag: 'd' }, // orphan
  ]);
  listShouldThrow = false;
  let rep = await recon.reconcile({ apply: false });
  t('dry run completes', rep.ok && rep.complete, JSON.stringify(rep).slice(0, 200));
  t('dry run did NOT apply', rep.applied === false);
  t('dry run counts committed (ready + orphan)', rep.committedBytes === 1234 + 5000, `got ${rep.committedBytes}`);
  t('dry run counts reserved (pending)', rep.reservedBytes === 600);
  t('dry run counts cleanup', rep.cleanupBytes === 77);
  t('dry run reports the orphan', rep.orphanCount === 1 && rep.orphanBytes === 5000);
  let snap = await budget.snapshot();
  t('the ledger is STILL uninitialised after a dry run', snap.initialised === false);
  t('...and committed is still zero (nothing written)', snap.bytes.committed === 0);

  console.log('\n--- APPLY initialises the ledger from the truth ---');
  rep = await recon.reconcile({ apply: true });
  t('apply completes and applied is true', rep.ok && rep.applied);
  snap = await budget.snapshot();
  t('the ledger is now initialised', snap.initialised === true);
  t('committed seeded from inventory truth', snap.bytes.committed === 1234 + 5000, `got ${snap.bytes.committed}`);
  t('reserved seeded', snap.bytes.reserved === 600);
  t('cleanup debt seeded', snap.bytes.cleanup_debt === 77);
  t('reconcile_complete flag set', snap.reconcile_complete === true);
  t('period source is assumed (not falsely provider-verified)', snap.period_source === 'assumed');

  console.log('\n--- orphans are NEVER auto-deleted ---');
  // the orphan object must still be in our stub bucket / not scheduled for deletion
  const cleanupRows = await knex('storage_cleanup').where({ storage_key: 'c/x/map/UNKNOWN.png' });
  t('the orphan was not queued for deletion', cleanupRows.length === 0);

  console.log('\n--- an incomplete inventory REFUSES to initialise ---');
  await resetLedger({ init: false });
  listShouldThrow = true;
  rep = await recon.reconcile({ apply: true });
  t('an errored inventory reports not ok', rep.ok === false && rep.complete === false);
  snap = await budget.snapshot();
  t('the ledger was NOT initialised from a partial picture', snap.initialised === false,
    'a half-counted bucket must not read as "plenty of room"');

  // cleanup
  listShouldThrow = false;
  await clearRows();
  await resetLedger({ init: false });
  await knex('storage_budget').where({ id: true }).update({ reconcile_complete: false, reconciled_at: null });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
