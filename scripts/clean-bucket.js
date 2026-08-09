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

const BUCKET = process.env.R2_BUCKET;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;

if (!BUCKET || !ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
  console.error('R2 is not configured in .env — nothing to clean.');
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

async function listAll() {
  const keys = [];
  let token;
  do {
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

  const cutoff = Date.now() - MIN_AGE_MINUTES * 60 * 1000;
  const orphans = [];
  let recent = 0;
  let accounted = 0;

  for (const obj of objects) {
    if (known.has(obj.key)) { accounted += 1; continue; }
    if (obj.modified && obj.modified.getTime() > cutoff) { recent += 1; continue; }
    orphans.push(obj);
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  const orphanBytes = orphans.reduce((a, o) => a + (o.size || 0), 0);

  console.log(`\n${objects.length} object(s) in ${BUCKET}`);
  console.log(`  ${accounted} accounted for by an asset row`);
  console.log(`  ${recent} too recent to judge (< ${MIN_AGE_MINUTES}m — may be mid-upload)`);
  console.log(`  ${orphans.length} orphaned, ${mb(orphanBytes)} MB`);
  console.log(`  ${dangling.length} row(s) pointing at an object that is NOT there\n`);

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
