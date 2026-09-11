// Remove objects from the bucket that no asset row accounts for.
//
//   node scripts/clean-bucket.js          list what would go, change nothing
//   node scripts/clean-bucket.js --delete actually remove them
//
// DRY RUN BY DEFAULT, and that is not politeness. This script talks to the only
// part of the system with no undo: a deleted row can be re-inserted, a deleted
// object cannot. Every other destructive operation in this project names what
// it will destroy before doing it — DELETE /:sceneId reports its token and fog
// counts, DELETE /spells reports the spellbooks it empties — and a maintenance
// script should not be the exception.
//
// ---------------------------------------------------------------------------
// WHY ORPHANS EXIST AT ALL
// ---------------------------------------------------------------------------
// The bucket and the database are two systems, and nothing makes them atomic.
// Four ways they drift:
//
//   - a presigned URL is issued, the bytes are uploaded, and confirm never
//     runs. The row is swept after thirty minutes; the object stays.
//   - a campaign is deleted. Its asset rows cascade away with it; the objects
//     they described do not.
//   - a test run uploads, as test-assets.js does.
//   - a delete succeeded in the database and failed in the bucket. The route
//     swallows that failure deliberately: an object we could not remove is a
//     storage leak, and throwing would turn "this was deleted" into "the
//     request failed".
//
// So orphans are a designed-for consequence rather than a defect, and this is
// the reconciliation.
//
// IT RUNS IN BOTH DIRECTIONS, and the second one was added after the first
// version shipped. That version asked only "does this object have a row?",
// which finds an object nothing accounts for and is blind to the opposite:
//
//   a ROW whose object is missing — a `ready` asset pointing at nothing, which
//   renders a broken image everywhere it is used, with nothing reporting it.
//
// The blind spot was noticed by accident, from three rows carrying a storage
// key against two objects in the bucket. That difference was entirely benign —
// the third row was `rejected`, and a rejected object is deleted at the moment
// of rejection — but a tool that cannot distinguish "benign" from "a dangling
// reference" is not much of a reconciliation.
//
// Only the second direction can DELETE. A dangling row is reported and left
// alone: something may still be rendering that URL, and quietly removing the
// record would destroy the only evidence of why the image disappeared.

require('dotenv').config();
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const knex = require('../src/db');
const budget = require('../src/services/storageBudget');

const BUCKET = process.env.R2_BUCKET;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!BUCKET || !ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !PUBLIC_BASE) {
  console.error('R2 is not fully configured in .env (including R2_PUBLIC_BASE_URL) — nothing to clean.');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// An object younger than this is left alone even with no row, because an upload
// in flight has no row yet: presign inserts before the PUT, but a client that
// uploads and has not yet confirmed is a normal state. Deleting those would
// break a live upload for the sake of tidiness.
const MIN_AGE_MINUTES = 60;


// Legacy image columns still store hosted R2 URLs by value. During migrations
// an object can be referenced here even if its `assets` row is missing. Such an
// object is NOT an orphan and must never be deleted by this script. Protect all
// six image-bearing tables explicitly; once every legacy reference has a proper
// asset row this guard becomes a no-op, but it remains a cheap safety net.
const LEGACY_IMAGE_SOURCES = [
  ['users', 'id', 'avatar_url'],
  ['campaigns', 'id', 'img_url'],
  ['scenes', 'id', 'img_url'],
  ['tokens', 'id', 'img_url'],
  ['actors', 'id', 'img_url'],
  ['items', 'id', 'img_url'],
];

function storageKeyFromLegacyUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(`${PUBLIC_BASE}/`)) return null;
  const key = raw.slice(PUBLIC_BASE.length + 1);
  if (!key || key.includes('..') || key.includes('?') || key.includes('#')) return null;
  return key;
}

async function legacyReferencedKeys() {
  const out = new Map(); // key -> [{ table, id, column }]
  for (const [table, idColumn, urlColumn] of LEGACY_IMAGE_SOURCES) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(table))) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasColumn(table, urlColumn))) continue;
    // eslint-disable-next-line no-await-in-loop
    const rows = await knex(table).whereNotNull(urlColumn).select(idColumn, urlColumn);
    for (const row of rows) {
      const key = storageKeyFromLegacyUrl(row[urlColumn]);
      if (!key) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ table, id: row[idColumn], column: urlColumn });
    }
  }
  return out;
}

async function listAll() {
  const keys = [];
  let token;
  do {
    // LIST is a Class A R2 operation. Maintenance may use the reserved slice,
    // but it is still metered before the provider is touched.
    // eslint-disable-next-line no-await-in-loop
    await budget.charge('list', { maintenance: true });
    // eslint-disable-next-line no-await-in-loop
    const page = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, ContinuationToken: token,
    }));
    for (const obj of page.Contents || []) {
      keys.push({ key: obj.Key, size: obj.Size, modified: obj.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

(async () => {
  const doDelete = process.argv.includes('--delete');

  const objects = await listAll();
  if (!objects.length) {
    console.log('Bucket is empty.');
    await knex.destroy();
    return;
  }

  // One query rather than one per object: a bucket with a few thousand keys
  // would otherwise be a few thousand round trips.
  const known = new Set(
    (await knex('assets').whereNotNull('storage_key').select('storage_key'))
      .map((r) => r.storage_key),
  );

  // Direction two: rows that expect an object. `rejected` is excluded because
  // its object is SUPPOSED to be gone — deleted at the moment of rejection —
  // and `pending` because the upload may not have happened yet.
  const stored = new Set(objects.map((o) => o.key));
  const dangling = (await knex('assets')
    .whereNotNull('storage_key')
    .where({ status: 'ready' })
    .select('id', 'storage_key', 'url', 'kind'))
    .filter((r) => !stored.has(r.storage_key));

  // A key referenced by a legacy image column is live even if its asset row is
  // missing. The old implementation would classify it as an orphan and --delete
  // could destroy an image still used by the game. Build this set before any
  // deletion decision and keep those objects out of `orphans`.
  const legacyRefs = await legacyReferencedKeys();

  const cutoff = Date.now() - MIN_AGE_MINUTES * 60 * 1000;
  const orphans = [];
  const referencedWithoutAsset = [];
  let recent = 0;
  let accounted = 0;

  for (const obj of objects) {
    if (known.has(obj.key)) { accounted += 1; continue; }
    if (legacyRefs.has(obj.key)) { referencedWithoutAsset.push(obj); continue; }
    if (obj.modified && obj.modified.getTime() > cutoff) { recent += 1; continue; }
    orphans.push(obj);
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  const orphanBytes = orphans.reduce((a, o) => a + (o.size || 0), 0);

  console.log(`\n${objects.length} object(s) in ${BUCKET}`);
  console.log(`  ${accounted} accounted for by an asset row`);
  console.log(`  ${recent} too recent to judge (< ${MIN_AGE_MINUTES}m — may be mid-upload)`);
  console.log(`  ${referencedWithoutAsset.length} referenced by legacy game data but missing an asset row (PROTECTED)`);
  console.log(`  ${orphans.length} orphaned, ${mb(orphanBytes)} MB`);
  console.log(`  ${dangling.length} row(s) pointing at an object that is NOT there\n`);

  if (referencedWithoutAsset.length) {
    console.log('  PROTECTED LEGACY REFERENCES — not deleted even with --delete:');
    for (const o of referencedWithoutAsset.slice(0, 40)) {
      console.log(`    ${o.key}`);
      for (const ref of legacyRefs.get(o.key) || []) {
        console.log(`      <- ${ref.table}.${ref.column} id=${ref.id}`);
      }
    }
    if (referencedWithoutAsset.length > 40) {
      console.log(`    … and ${referencedWithoutAsset.length - 40} more`);
    }
    console.log('  Repair these into assets rows before considering them orphaned.\n');
  }

  if (dangling.length) {
    // Reported, never deleted. See the header: a dangling row is the only
    // record of why an image went missing, and something may still render it.
    console.log('  DANGLING — a ready asset with no object behind it:');
    for (const d of dangling.slice(0, 20)) console.log(`    ${d.kind}  ${d.storage_key}`);
    if (dangling.length > 20) console.log(`    … and ${dangling.length - 20} more`);
    console.log('  These are NOT removed automatically. Anything using them shows a broken image.\n');
  }

  if (!orphans.length) { await knex.destroy(); return; }

  for (const o of orphans.slice(0, 40)) {
    console.log(`  ${o.key}  ${mb(o.size || 0)} MB  ${o.modified && o.modified.toISOString()}`);
  }
  if (orphans.length > 40) console.log(`  … and ${orphans.length - 40} more`);

  if (!doDelete) {
    console.log('\nDry run. Re-run with --delete to remove these.\n');
    await knex.destroy();
    return;
  }

  // DeleteObjects takes at most a thousand keys per call.
  let removed = 0;
  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000);
    // eslint-disable-next-line no-await-in-loop
    const res = await client.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: batch.map((o) => ({ Key: o.key })) },
    }));
    removed += (res.Deleted || []).length;
    for (const err of res.Errors || []) console.error(`  FAILED ${err.Key}: ${err.Message}`);
  }

  console.log(`\nRemoved ${removed} object(s), reclaiming ${mb(orphanBytes)} MB.\n`);
  await knex.destroy();
})().catch(async (err) => {
  console.error('Cleanup failed:', err.message);
  await knex.destroy();
  process.exit(1);
});
