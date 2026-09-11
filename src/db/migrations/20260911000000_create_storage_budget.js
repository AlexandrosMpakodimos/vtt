// Storage budget ledger, durable cleanup queue, and asset accounting repair.
//
// The assets table (20260809) counts IMAGES — "no more than 300 per campaign" —
// and that cap is real and stays. What it cannot do is count BYTES or R2
// OPERATIONS against the account-wide free allowance, and those are what a
// runaway bill is actually made of: 10 GB-month of storage, 1,000,000 Class A
// and 10,000,000 Class B operations per month, shared across every campaign and
// every personal avatar at once. Three hundred maps in each of six campaigns is
// eighteen hundred objects, every one of them inside its per-campaign cap and
// all of them together over the storage allowance.
//
// So this migration adds the three things a byte/operation budget needs and the
// image-count cap does not.
//
// ---------------------------------------------------------------------------
// 1. storage_budget — ONE ROW, the account-wide ledger
// ---------------------------------------------------------------------------
// A single row (enforced by a fixed primary key) holding the running totals for
// the current provider billing period. It is reserved against and committed to
// through the SAME serialisable-transaction discipline as every other "no more
// than N of X" rule in this project (services/atomicCap.js): count-or-read then
// write inside one SERIALIZABLE transaction with bounded retry on 40001, never
// an in-process mutex — because a mutex does not survive multiple processes,
// which is exactly the deployment the free allowance is shared across.
//
// WHY A SINGLE ROW AND NOT A SUM OVER assets:
//   - Reservations exist BEFORE an asset row is trustworthy (bytes reserved at
//     presign, before any object exists) and AFTER it is gone (cleanup debt for
//     an object we failed to delete). Neither is a ready asset, so neither is in
//     a SUM(assets.bytes).
//   - Operation counters (Class A/B) are not a property of any asset at all.
//     A repeated image read is billed and stores nothing.
//   - The period boundary must be explicit and provider-tied. A SUM has no
//     period; a ledger row carries the window it belongs to and refuses to mint
//     a fresh allowance on a restart or a clock change.
//
// committed_bytes    bytes we believe are actually stored right now
// reserved_bytes     bytes promised to in-flight uploads, not yet committed
// cleanup_debt_bytes bytes of objects we could not delete and are still charged
// class_a_used       PUT/LIST/COPY operations counted this period
// class_b_used       GET/HEAD operations counted this period
// The live liability is committed + reserved + cleanup_debt, and THAT is what is
// checked against the global ceiling — never committed alone.
//
// period_start / period_end / period_source describe the window these counters
// belong to. A reset is only legitimate when the provider's period has actually
// rolled over (see the service); an uncertain or missing period must not reset.
//
// ---------------------------------------------------------------------------
// 2. storage_cleanup — the durable deletion queue
// ---------------------------------------------------------------------------
// storage.remove() swallows failure and returns false: an object we asked R2 to
// delete and could not is a real object still costing real bytes, and today
// nothing records it — the caller removes the asset row anyway and the bytes
// become invisible. cleanupStaleAssets() has the same hole from the other side:
// it deletes pending/rejected ROWS without deleting their possibly-uploaded
// OBJECTS.
//
// This queue is where a delete that must happen goes to be retried until it
// does. A row is created the moment we decide an object should not exist, and
// it is removed only when absence is established. Until then its bytes stay
// charged as cleanup_debt. Lease columns let one worker own a row without a
// second worker racing it.
//
// ---------------------------------------------------------------------------
// 3. assets accounting repair — do not trust the sizes already stored
// ---------------------------------------------------------------------------
// Every `bytes` already in the assets table was written by the old confirm
// path, which recorded the length of a sixteen-byte range slice, not the
// object. Those numbers are wrong and must not seed the ledger. Rather than
// guess, each existing ready UPLOAD is marked bytes_verified = false, which
// EXCLUDES it from the byte ledger until a HEAD reconciles its real size. The
// ledger initialises from verified rows plus a bucket inventory, never from the
// unreliable column. External links have no bytes of ours and are verified
// vacuously (nothing to reconcile).
//
// reserved_bytes on the asset is the amount promised for an in-flight upload,
// carried on the row so a crash between reserve and commit is recoverable from
// the database alone: the reservation is not a number living only in a process.

exports.up = async function up(knex) {
  // ---- 1. the single-row ledger -------------------------------------------
  await knex.schema.createTable('storage_budget', (t) => {
    // A fixed PK makes the singleton a constraint, not a convention: there is
    // exactly one budget row and a second insert conflicts. `true` because a
    // boolean has precisely one non-null value we ever use.
    t.boolean('id').primary().defaultTo(true);

    t.bigInteger('committed_bytes').notNullable().defaultTo(0);
    t.bigInteger('reserved_bytes').notNullable().defaultTo(0);
    t.bigInteger('cleanup_debt_bytes').notNullable().defaultTo(0);

    t.bigInteger('class_a_used').notNullable().defaultTo(0);
    t.bigInteger('class_b_used').notNullable().defaultTo(0);

    // The provider billing window these counters describe. Nullable until the
    // service establishes it from the provider; a null period means "not yet
    // initialised", which the service treats as fail-closed, not as a fresh
    // month.
    t.timestamp('period_start', { useTz: true });
    t.timestamp('period_end', { useTz: true });
    // 'provider' once tied to a verified Cloudflare boundary; 'assumed' while
    // still using a conservative local window. The distinction is reported, not
    // hidden — an assumed period is not a guarantee.
    t.string('period_source', 20).notNullable().defaultTo('assumed');

    // When the ledger was last reconciled against a real bucket inventory /
    // provider metrics, and whether that reconciliation was complete. Stale or
    // partial reconciliation is surfaced to the operator, never silently
    // trusted.
    t.timestamp('reconciled_at', { useTz: true });
    t.boolean('reconcile_complete').notNullable().defaultTo(false);

    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // Guard rails at the storage layer, independent of application code: a
    // budget can never read as negative. If a release ever tried to drive one
    // below zero it is a bug, and failing the transaction is the correct
    // outcome rather than a silently-wrong ledger.
    t.check('committed_bytes >= 0');
    t.check('reserved_bytes >= 0');
    t.check('cleanup_debt_bytes >= 0');
    t.check('class_a_used >= 0');
    t.check('class_b_used >= 0');
  });

  // Insert the singleton now, uninitialised (null period). The service
  // initialises the period and totals; it must not be minted by a migration
  // that has no knowledge of the provider's window.
  await knex('storage_budget').insert({ id: true });

  // ---- 2. the durable cleanup queue ---------------------------------------
  await knex.schema.createTable('storage_cleanup', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // The object to delete. Not a foreign key to assets: the asset row may
    // already be gone (that is often WHY this exists), and the object outlives
    // the row. The key is the thing that must be deleted.
    t.text('storage_key').notNullable();

    // Bytes still charged as cleanup_debt on behalf of this object, released to
    // the ledger exactly once when deletion is finally confirmed. Nullable for
    // an object whose size was never established (an abandoned pending upload):
    // it still must be deleted, but it contributes no known debt to release.
    t.bigInteger('bytes');

    // Why this object is being cleaned up — for the operator's report, not for
    // logic. 'rejected' (failed verification), 'orphan_pending' (abandoned
    // upload), 'replaced' (a portrait changed), 'delete_failed' (remove()
    // returned false), 'reconcile_orphan' (found in the bucket with no row).
    t.string('reason', 30).notNullable();

    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.timestamp('next_attempt_at', { useTz: true }).defaultTo(knex.fn.now());

    // Lease: which worker owns this row and until when. A worker claims a batch
    // by stamping these under a serialisable transaction; a lease that has
    // expired is free to be reclaimed, so a crashed worker does not strand its
    // rows. No in-process lock — the lease is in the database for the same
    // multi-process reason the caps are.
    t.text('leased_by');
    t.timestamp('leased_until', { useTz: true });

    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // The worker pulls due rows in attempt order; the lease scan wants the same.
    t.index(['next_attempt_at']);
    t.index(['leased_until']);
    t.check('attempts >= 0');
  });

  // ---- 3. accounting repair on the existing assets -------------------------
  await knex.schema.alterTable('assets', (t) => {
    // Is `bytes` an authoritative HEAD size we may charge the ledger for? False
    // for every row written by the old confirm path; set true only by the new
    // path or by the reconciler. Excludes untrusted sizes from the ledger
    // rather than deleting or guessing them.
    t.boolean('bytes_verified').notNullable().defaultTo(false);

    // Bytes promised to this upload while it is in flight, before commit. Lets a
    // crash between reserve and commit be reconciled from the row itself.
    t.bigInteger('reserved_bytes');

    // The object's ETag as reported by R2 at verification: a cheap identity
    // check the reconciler can use to notice an object that was overwritten by
    // a replayed presigned PUT after we recorded it.
    t.text('etag');
  });

  // Every UPLOAD that predates this migration has an untrustworthy size, so it
  // is already bytes_verified = false by the column default — the reconciler
  // will HEAD each one and set the real size. External links carry no bytes of
  // ours; mark them verified so they are not queued for a pointless HEAD.
  await knex('assets').where({ source: 'external' }).update({ bytes_verified: true });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('assets', (t) => {
    t.dropColumn('bytes_verified');
    t.dropColumn('reserved_bytes');
    t.dropColumn('etag');
  });
  await knex.schema.dropTableIfExists('storage_cleanup');
  await knex.schema.dropTableIfExists('storage_budget');
};
