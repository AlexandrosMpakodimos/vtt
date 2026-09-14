// Reconciliation and ledger initialisation.
//
// The budget ledger is only trustworthy once it has been seeded from what is
// ACTUALLY in the bucket, not from the assets table's `bytes` column — which,
// for every row written before the size fix, holds the old 16-byte lie. This
// service pages the real bucket inventory, matches each object against the
// rows that are supposed to own it, and produces two things:
//
//   1. A committed-bytes total computed from the inventory (the truth), used to
//      INITIALISE the ledger and set its verified period. After this runs,
//      byte + operation enforcement is ON.
//   2. A dry-run ORPHAN REPORT: objects in the bucket that no row claims. These
//      still count against the global ceiling (an unknown object costs bytes
//      whether or not we understand it), but they are NEVER auto-deleted here —
//      deleting unknown or live artwork to make a dashboard look clean is the
//      exact mistake the brief forbids. The operator reviews the report and
//      decides.
//
// WHAT COUNTS AS "KNOWN"
//   - A ready upload asset with a storage_key: its object is expected to exist.
//   - A pending upload asset with a storage_key: the object MAY exist (the
//     client may have PUT but not confirmed). Counted as known-and-reserved so a
//     confirm-in-flight is not flagged as an orphan and deleted from under it.
//   - A storage_cleanup row: an object we KNOW about and intend to delete. Still
//     present, still costing bytes, so it counts — as cleanup debt, not
//     committed. Not an orphan.
// Anything in the bucket outside those three sets is an orphan.
//
// METERING
// Every LIST page and every HEAD is a real R2 operation and is charged through
// the budget's MAINTENANCE slice (so a reconciliation cannot be starved by user
// traffic, and cannot itself exhaust the user allowance). LIST carries Size, so
// no per-object HEAD is needed for sizing during a full inventory — the HEAD
// path exists for targeted re-checks.
//
// FAIL-CLOSED
// If the inventory cannot be completed (a LIST page errors, the operation budget
// for maintenance is exhausted mid-run), the run reports itself INCOMPLETE and
// does NOT initialise the ledger from a partial picture. A half-counted bucket
// that reads as "plenty of room" is worse than an uninitialised one.

const knex = require('../db');
const storage = require('./storage');
const budget = require('./storageBudget');

// The R2 billing period. The brief warns against ASSUMING a local calendar
// month; R2's storage billing is on the UTC calendar month, but until that is
// confirmed against the provider's own reported boundaries (GraphQL
// r2StorageAdaptiveGroups), the period is recorded with source 'assumed' so the
// distinction is visible and never mistaken for a guarantee. `providerVerified`
// lets a later GraphQL integration stamp 'provider'.
function currentPeriodUTC(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

// Build the set of keys the database expects to exist, with the bytes it
// believes each holds where it can be trusted. Returned as a Map key -> {
// class: 'committed'|'reserved'|'cleanup', dbBytes|null }.
async function knownKeys() {
  const known = new Map();

  // Ready and pending uploads with a storage_key.
  const assets = await knex('assets')
    .whereNotNull('storage_key')
    .whereIn('status', ['ready', 'pending'])
    .select('storage_key', 'status', 'bytes', 'bytes_verified');
  for (const a of assets) {
    known.set(a.storage_key, {
      class: a.status === 'ready' ? 'committed' : 'reserved',
      dbBytes: (a.bytes_verified && typeof a.bytes === 'number') ? a.bytes : null,
    });
  }

  // Objects queued for deletion: known, still present, cleanup debt.
  const cleanup = await knex('storage_cleanup').select('storage_key', 'bytes');
  for (const c of cleanup) {
    if (!known.has(c.storage_key)) {
      known.set(c.storage_key, {
        class: 'cleanup',
        dbBytes: typeof c.bytes === 'number' ? c.bytes : null,
      });
    }
  }

  return known;
}

// Page the whole bucket. Each LIST is a Class A operation. When the ledger is
// ALREADY initialised, the LIST is charged against the maintenance slice (a
// routine reconciliation must not be able to exhaust the user allowance, and
// must not be starved by it). When the ledger is NOT yet initialised, this is a
// FIRST-TIME bootstrap: there is no budget to protect or charge against yet, so
// the bootstrap LISTs are unmetered — they are the operation that establishes
// the budget, and charging them would require the very ledger they create.
// Either way, an incomplete inventory is reported as such and never applied.
async function inventory({ maxPages = 10_000, charged = true } = {}) {
  const objects = new Map();
  let token;
  let pages = 0;
  do {
    if (charged) {
      // eslint-disable-next-line no-await-in-loop
      try {
        await budget.charge('list', { maintenance: true });
      } catch (err) {
        return { objects, complete: false, pages, reason: err.message };
      }
    }
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop
      page = await storage.listPage({ continuationToken: token });
    } catch (err) {
      return { objects, complete: false, pages, reason: err.message };
    }
    for (const o of page.objects) objects.set(o.key, { bytes: o.bytes, etag: o.etag });
    token = page.nextToken;
    pages += 1;
  } while (token && pages < maxPages);

  return { objects, complete: !token, pages };
}

// The core: compare inventory against known keys. Pure once the two inputs are
// gathered, so it is unit-testable without a bucket.
function classify(inventoryMap, known) {
  let committedBytes = 0;
  let reservedBytes = 0;
  let cleanupBytes = 0;
  const orphans = [];
  let missing = 0; // known keys with no object (referenced but absent)

  for (const [key, obj] of inventoryMap) {
    const k = known.get(key);
    // Prefer the object's real size from the inventory over any db value.
    const bytes = typeof obj.bytes === 'number' ? obj.bytes : 0;
    if (!k) {
      orphans.push({ key, bytes });
      // An orphan still costs bytes and counts against the ceiling. It is added
      // to committed so the ledger reflects real occupancy; it is ALSO reported
      // so the operator can reconcile ownership or delete deliberately.
      committedBytes += bytes;
    } else if (k.class === 'committed') {
      committedBytes += bytes;
    } else if (k.class === 'reserved') {
      reservedBytes += bytes;
    } else if (k.class === 'cleanup') {
      cleanupBytes += bytes;
    }
  }

  // Known keys with no matching object: referenced but absent (a broken row).
  for (const key of known.keys()) {
    if (!inventoryMap.has(key)) missing += 1;
  }

  return {
    committedBytes, reservedBytes, cleanupBytes, orphans, missing,
    orphanBytes: orphans.reduce((s, o) => s + o.bytes, 0),
  };
}

// Run a full reconciliation. `apply:false` (default) is a DRY RUN: it computes
// and reports, writes nothing. `apply:true` initialises/updates the ledger from
// the computed truth and sets the verified period, but STILL never deletes an
// orphan — that is always a separate, operator-approved step.
async function reconcile({ apply = false, providerVerified = false } = {}) {
  if (!storage.isConfigured()) {
    return { ok: false, reason: 'storage not configured' };
  }

  // Whether the ledger is already live decides two things: whether the
  // reconciliation LISTs are metered (they are, once there is a budget to
  // protect), and it is recorded in the report either way. A first-time run
  // (uninitialised) does NOT seed a provisional period — doing so would flip the
  // ledger "initialised" as a side effect and let a dry run or a failed run
  // leave enforcement switched on against a half-counted bucket.
  const snap = await budget.snapshot();
  const alreadyLive = snap.initialised;

  const known = await knownKeys();
  const inv = await inventory({ charged: alreadyLive });
  if (!inv.complete) {
    // Do not initialise from a partial inventory.
    return {
      ok: false, complete: false, reason: inv.reason || 'inventory incomplete',
      pages: inv.pages,
    };
  }

  const result = classify(inv.objects, known);
  const { start, end } = currentPeriodUTC();

  const report = {
    ok: true,
    complete: true,
    pages: inv.pages,
    objects: inv.objects.size,
    knownKeys: known.size,
    committedBytes: result.committedBytes,
    reservedBytes: result.reservedBytes,
    cleanupBytes: result.cleanupBytes,
    orphanCount: result.orphans.length,
    orphanBytes: result.orphanBytes,
    missingKnownKeys: result.missing,
    orphans: result.orphans.slice(0, 100), // cap the inline list; full set is derivable
    period: { start, end, source: providerVerified ? 'provider' : 'assumed' },
    applied: false,
  };

  if (apply) {
    await budget.inSerializable(async (trx) => {
      await trx('storage_budget').where({ id: true }).update({
        committed_bytes: result.committedBytes,
        reserved_bytes: result.reservedBytes,
        cleanup_debt_bytes: result.cleanupBytes,
        period_start: start,
        period_end: end,
        period_source: providerVerified ? 'provider' : 'assumed',
        reconciled_at: trx.fn.now(),
        reconcile_complete: true,
        updated_at: trx.fn.now(),
      });
    });
    report.applied = true;
  }

  return report;
}

module.exports = {
  reconcile, classify, knownKeys, inventory, currentPeriodUTC,
};
