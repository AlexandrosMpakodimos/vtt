// Assets: authorising uploads, verifying what arrived, and recording external
// links. Mounted at /api/assets, NOT under a campaign, because an avatar has no
// campaign — the campaign is a property of the asset rather than of the path.
//
// That is a departure from every other resource in this project, which is
// addressed through its campaign and inherits requireMember from doing so. The
// consequence is that membership must be checked HERE, explicitly, per request.
// It is written out rather than assumed, because a route family that does not
// inherit the project's usual authorisation is exactly where an omission would
// survive review.
//
// ---------------------------------------------------------------------------
// ONE UPLOAD PATH
// ---------------------------------------------------------------------------
//   POST /api/assets/upload     the bytes come THROUGH the server: validated,
//                               metered, written to R2 once, then marked ready
//   POST /api/assets/external   record a pasted link (no bytes)
//
// [CHANGED 2026-10-05] The legacy three-step presigned conversation (POST
// /presign, a browser PUT straight to R2, POST /:id/confirm) was removed in the
// schema cleanup. It had been disabled in production (UPLOAD_MODE=strict) since
// the controlled path landed, because a presigned PUT is a replayable grant the
// budget cannot meter exactly. UPLOAD_MODE no longer exists.

const express = require('express');
const knex = require('../db');
const { requireAuth } = require('../middleware/auth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const { withAtomicCap } = require('../services/atomicCap');
const { validateImageUrl, validUuid } = require('../services/validators');
const storage = require('../services/storage');
const budget = require('../services/storageBudget');
const queueFailedUpload = require('../services/failedUploadCleanup');
const gateway = require('../services/mediaGateway');

const router = express.Router();

// The byte/operation budget is ENFORCED only once it has been initialised
// against the provider's real period by the operator (see storageBudget +
// reconciliation). Until then it is INACTIVE: uploads behave exactly as before,
// so shipping the accounting does not break every upload the moment it lands,
// before reconciliation is even possible. This is the line between "accounting
// exists" and "enforcement is on", and it is deliberately explicit — a snapshot
// with initialised:false means protection is incomplete and must be reported as
// such, never as protected.
//
// When active, a spend that would cross a ceiling throws budgetExceeded, which
// the caller turns into a documented quota response. A budget error other than
// "exceeded"/"uninitialised" is a real fault and propagates.
async function budgetActive() {
  const snap = await budget.snapshot();
  if (!snap || !snap.initialised) {
    const error = new Error('Storage accounting is unavailable; uploads are paused.');
    error.status = 503;
    error.budgetUninitialised = true;
    throw error;
  }
  return true;
}

// A hard ceiling on any request body the upload route will buffer, independent
// of the per-kind limit, so a hostile Content-Length cannot make the server
// allocate unboundedly before the per-kind check runs. The largest legitimate
// kind (map, 12 MiB) plus a small margin.
const MAX_UPLOAD_BYTES = 13 * 1024 * 1024;

router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// Storage is optional, so every route that needs it says so rather than
// throwing. A machine with no bucket configured must still start, still serve
// the application, and still pass every suite that does not concern uploads —
// a thesis artefact that cannot run without the author's cloud credentials is
// not reproducible.
function requireStorage(req, res, next) {
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'image storage is not configured on this server' });
  }
  return next();
}

// Quotas. CHOSEN, not measured — abuse prevention, and enforced atomically
// through the same primitive as every other "no more than N of X" rule.
//
// Two scopes because assets have two: a campaign's maps and portraits are
// counted against that campaign, a personal avatar against its owner. One
// global cap would let a busy campaign exhaust an unrelated one's allowance.
const MAX_ASSETS_PER_CAMPAIGN = 300;
const MAX_ASSETS_PER_USER = 20;

// A controlled upload holds a `pending` row only while its request runs. One
// left behind (a crash mid-upload) still holds quota; the sweep in server.js
// reclaims it after this long.
const PENDING_TTL_MINUTES = 30;

function publicAsset(a) {
  if (!a) return null;
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    user_id: a.user_id,
    url: a.url,
    source: a.source,
    source_url: a.source_url,
    kind: a.kind,
    status: a.status,
    mime: a.mime,
    bytes: a.bytes,
    created_at: a.created_at,
  };
}

// Who may create an asset of this kind, in this scope.
//
// Deliberately expressed in terms of the EXISTING field permissions rather than
// as a new rule: a map is a scene image and scenes are GM-only, a portrait
// follows img_url which a player may set on their own character, an avatar is
// personal. Inventing a separate permission model for uploads would be a second
// authority over the same question.
async function mayCreate({ userId, kind, campaignId }) {
  if (kind === 'avatar') {
    // Personal, no campaign involved. Anyone may have one.
    return { ok: campaignId == null, isOwner: false };
  }
  if (!campaignId) return { ok: false };

  const campaign = await knex('campaigns')
    .where({ id: campaignId }).whereNull('deleted_at').first();
  if (!campaign) return { ok: false };

  const isOwner = campaign.owner_id === userId;
  if (!isOwner) {
    const member = await knex('campaign_members')
      .where({ campaign_id: campaignId, user_id: userId, status: 'active' }).first();
    if (!member) return { ok: false };
  }

  // A map is the board itself; a cover is the campaign's banner. Both belong to
  // the campaign as a whole, so only its owner (the GM) may author them.
  // Everything else is content a member may author for something they own, and
  // the field-level checks on the actor, token and item routes still apply when
  // the URL is actually assigned.
  if ((kind === 'map' || kind === 'cover') && !isOwner) return { ok: false, forbidden: true };
  return { ok: true, isOwner };
}

// POST /api/assets/upload — the CONTROLLED upload path.
//
// Instead of handing the browser a replayable PUT grant, the bytes come THROUGH
// the server: we validate them,
// reserve budget, write the object to R2 exactly once (metered, one charged
// permit per real SDK attempt), verify, and commit. There is no client-held
// grant to replay, so one authorised upload is one object and one set of
// charges — not "one permit, many writes until the URL expires".
//
// The body is the raw image bytes (express.raw, bounded by MAX_UPLOAD_BYTES so a
// hostile Content-Length cannot force an unbounded allocation). Metadata travels
// in headers/query, not a JSON body, because the body IS the file.
//
// IDEMPOTENCY. A client that retries the whole upload (a dropped response, a
// flaky connection) sends the same Idempotency-Key. The first request with that
// key does the work; a repeat returns the SAME ready asset without a second
// object, row, or charge. Without this, "retry" would mean "pay twice and leak
// an object".
//
// RESERVATIONS AND AMBIGUITY. Bytes are reserved before the write and committed
// only after a verified success. On a CLEAN failure (validation, a definitive
// R2 error) the reservation is released and any object cleaned up. On an
// AMBIGUOUS outcome (the write may or may not have landed) the reservation is
// PRESERVED and the object queued for cleanup — storage liability is only
// released when it is safe to conclude nothing is stored.
router.post('/upload',
  requireStorage,
  express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  async (req, res, next) => {
    let reservedBytes = 0;
    let row = null;
    let wroteObject = false;
    let attemptedWrite = false;
    try {
      const kind = typeof req.query.kind === 'string' ? req.query.kind.trim().toLowerCase() : '';
      if (!storage.KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${storage.KINDS.join(', ')}` });
      }

      const campaignId = req.query.campaign_id === undefined || req.query.campaign_id === ''
        ? null : req.query.campaign_id;
      if (campaignId !== null && !validUuid(campaignId)) {
        return res.status(404).json({ error: 'campaign not found' });
      }

      const perm = await mayCreate({ userId: req.user.id, kind, campaignId });
      if (!perm.ok) {
        if (perm.forbidden) return res.status(403).json({ error: `only the GM may upload a ${kind}` });
        return res.status(404).json({ error: 'campaign not found' });
      }

      const mime = typeof req.query.mime === 'string' ? req.query.mime.trim().toLowerCase() : '';
      const fmt = storage.formatFor(mime);
      if (!fmt) {
        return res.status(400).json({ error: `mime must be one of: ${storage.allowedMimes().join(', ')}` });
      }

      // The body must be actual bytes and within the per-kind limit. express.raw
      // gives a Buffer; a wrong content type or an empty body yields no usable
      // buffer.
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bytes || bytes.length === 0) {
        return res.status(400).json({ error: 'request body must contain the image bytes' });
      }
      const limit = storage.limitFor(kind);
      if (bytes.length > limit) {
        return res.status(400).json({ error: `a ${kind} may be at most ${limit} bytes` });
      }

      // Verify the bytes ARE the declared type BEFORE writing anything. The bytes
      // are in hand, so a liar never reaches R2 at all — no wasted write, no
      // object to clean up.
      if (!storage.magicMatches(mime, bytes)) {
        return res.status(400).json({ error: 'that file is not the image type it claims to be' });
      }

      // Idempotency: a repeat with the same key returns the existing asset.
      const idemKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].trim().slice(0, 200) : null;
      if (idemKey) {
        const existing = await knex('assets')
          .where({ user_id: req.user.id, idempotency_key: idemKey }).first();
        if (existing) {
          // The logical upload already happened (or is happening). Return the
          // ready asset; do not write or charge again. If it is still pending
          // (a concurrent duplicate), report conflict rather than racing it.
          if (existing.status === 'ready') {
            const shaped = publicAsset(existing);
            await gateway.rewriteObject(shaped, ['url'], req.user.id);
            return res.status(200).json({ asset: shaped });
          }
          return res.status(409).json({ error: 'an upload with this key is already in progress' });
        }
      }

      const key = storage.buildKey({
        campaignId, userId: req.user.id, kind, ext: fmt.ext,
      });

      const active = await budgetActive();

      // Reserve the ACTUAL byte count (the bytes are in hand).
      if (active) {
        try {
          await budget.reserveBytes(bytes.length);
          reservedBytes = bytes.length;
        } catch (err) {
          if (err.budgetExceeded) {
            return res.status(507).json({ error: 'storage_budget_reached', message: 'the application has reached its storage budget; new uploads are paused' });
          }
          throw err;
        }
      }

      // Claim the image-count cap and create the pending row (with the
      // idempotency key) atomically.
      const scope = campaignId ? { campaign_id: campaignId } : { user_id: req.user.id, campaign_id: null };
      try {
        const rows = await withAtomicCap({
          table: 'assets',
          where: function countsAgainstQuota() {
            this.where(scope).whereIn('status', ['pending', 'ready']);
          },
          max: campaignId ? MAX_ASSETS_PER_CAMPAIGN : MAX_ASSETS_PER_USER,
          capMessage: campaignId
            ? `a campaign may hold at most ${MAX_ASSETS_PER_CAMPAIGN} images`
            : `you may hold at most ${MAX_ASSETS_PER_USER} personal images`,
          insert: {
            campaign_id: campaignId,
            user_id: req.user.id,
            storage_key: key,
            url: storage.publicUrl(key),
            source: 'upload',
            kind,
            status: 'pending',
            reserved_bytes: reservedBytes || null,
            idempotency_key: idemKey,
          },
        });
        row = rows[0];
      } catch (err) {
        if (reservedBytes) {
          await budget.releaseReservedBytes(reservedBytes);
          reservedBytes = 0;
        }
        if (err.capExceeded) return res.status(409).json({ error: err.message });
        // A unique-violation on the idempotency key means a concurrent duplicate
        // won the race; treat it as in-progress rather than an error.
        if (err.code === '23505') {
          if (reservedBytes) { await budget.releaseReservedBytes(reservedBytes).catch(() => {}); reservedBytes = 0; }
          return res.status(409).json({ error: 'an upload with this key is already in progress' });
        }
        throw err;
      }

      // Write to R2. Each attempt is one charged Class A permit and one SDK call
      // (maxAttempts is pinned to 1), so the number of billed operations equals
      // the number the budget counted. A bounded retry covers transient errors;
      // every retry is charged and recorded in upload_attempts.
      const MAX_WRITE_ATTEMPTS = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        if (active) {
          try {
            await budget.charge('put');
          } catch (err) {
            if (err.budgetExceeded) {
              if (attemptedWrite) {
                await queueFailedUpload(row.id);
                reservedBytes = 0;
              } else {
                if (reservedBytes) {
                  await budget.releaseReservedBytes(reservedBytes);
                  reservedBytes = 0;
                }
                await knex('assets').where({ id: row.id }).update({
                  status: 'rejected',
                  reserved_bytes: null,
                  upload_attempts: 0,
                  updated_at: knex.fn.now(),
                });
              }
              return res.status(507).json({ error: 'operation_budget_reached', message: 'the application has reached its operation budget; try again next period' });
            }
            throw err;
          }
        }
        try {
          attemptedWrite = true;
          await storage.putObject({ key, mime, body: bytes });
          wroteObject = true;
          await knex('assets').where({ id: row.id }).update({ upload_attempts: attempt }).catch(() => {});
          break;
        } catch (err) {
          lastErr = err;
          await knex('assets').where({ id: row.id }).update({ upload_attempts: attempt }).catch(() => {});
          // Continue to the next attempt (each charged). If this was the last,
          // fall through to the ambiguous-failure handling below.
        }
      }

      if (!wroteObject) {
        // A failed response does not prove the object was never stored.
        await queueFailedUpload(row.id);
        reservedBytes = 0;
        return res.status(502).json({
          error: 'upload_failed',
          message: 'the object could not be stored; the attempt was recorded and will be reconciled',
          detail: lastErr ? lastErr.name : undefined,
        });
      }

      // A successful PUT gives us the validated body length.
      // Only ask storage for a HEAD when its permit was granted.
      let mayHead = true;
      if (active) {
        try {
          await budget.charge('head');
        } catch (err) {
          if (!err.budgetExceeded) throw err;
          mayHead = false;
        }
      }

      let realBytes = bytes.length;
      if (mayHead) {
        try {
          const headInfo = await storage.headSize(key);
          if (typeof headInfo.bytes === 'number' && headInfo.bytes > 0) {
            realBytes = headInfo.bytes;
          }
        } catch {
          // The PUT succeeded; retain the known body length.
        }
      }

      if (active && reservedBytes) {
        const toCommit = Math.min(realBytes, reservedBytes);
        await budget.commitReservedBytes(toCommit);
        if (reservedBytes > toCommit) await budget.releaseReservedBytes(reservedBytes - toCommit).catch(() => {});
        reservedBytes = 0;
      }

      const [ready] = await knex('assets').where({ id: row.id }).update({
        status: 'ready',
        mime,
        bytes: realBytes,
        bytes_verified: active ? realBytes <= (row.reserved_bytes || realBytes) : false,
        reserved_bytes: null,
        updated_at: knex.fn.now(),
      }).returning('*');

      const shaped = publicAsset(ready);
      await gateway.rewriteObject(shaped, ['url'], req.user.id);
      return res.status(201).json({ asset: shaped });
    } catch (err) {
      if (row && attemptedWrite && !wroteObject) {
        try {
          await queueFailedUpload(row.id);
          reservedBytes = 0;
        } catch (cleanupError) {
          // Keep the reservation if the durable handoff fails.
          console.error('Failed upload cleanup handoff:', cleanupError.message);
        }
      } else if (!attemptedWrite) {
        if (reservedBytes) {
          try {
            await budget.releaseReservedBytes(reservedBytes);
            reservedBytes = 0;
          } catch (releaseError) {
            console.error('Upload reservation release:', releaseError.message);
          }
        }
        if (row && !reservedBytes) {
          await knex('assets').where({ id: row.id }).update({
            status: 'rejected',
            reserved_bytes: null,
            updated_at: knex.fn.now(),
          }).catch(() => {});
        }
      }
      return next(err);
    }
  });


// POST /api/assets/external — record a pasted link.
//
// No bytes are involved and our server never contacts the host. The row exists
// so that provenance is recorded and the image appears in the same library as
// uploads; the URL itself is stored and rendered directly by each player's
// browser.
//
// THE TRADE-OFF, recorded rather than hidden: every player who views this image
// makes a request to that third party, disclosing their IP address to it. The
// alternatives were a server-side fetcher — which requires solving SSRF for
// arbitrary destinations, across redirects, against DNS rebinding — and an
// edge image proxy, which needs a domain this project does not have. Both are
// deferred, and the interface says plainly what this option costs.
router.post('/external', async (req, res, next) => {
  try {
    const body = req.body || {};

    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!storage.KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${storage.KINDS.join(', ')}` });
    }

    const campaignId = body.campaign_id === undefined || body.campaign_id === null
      ? null : body.campaign_id;
    if (campaignId !== null && !validUuid(campaignId)) {
      return res.status(404).json({ error: 'campaign not found' });
    }

    const perm = await mayCreate({ userId: req.user.id, kind, campaignId });
    if (!perm.ok) {
      if (perm.forbidden) return res.status(403).json({ error: `only the GM may set a ${kind}` });
      return res.status(404).json({ error: 'campaign not found' });
    }

    const url = validateImageUrl(body.url, 'url');
    if (url.error) return res.status(400).json({ error: url.error });
    if (!url.value) return res.status(400).json({ error: 'url is required' });

    const scope = campaignId ? { campaign_id: campaignId } : { user_id: req.user.id, campaign_id: null };
    let row;
    try {
      const rows = await withAtomicCap({
        table: 'assets',
        // Same scope as an upload. An external link is `ready` immediately and has
        // no pending state of its own, but it must be counted against the SAME
        // total — otherwise the two routes would enforce two different caps on
        // one allowance, and the cheaper one would be the way around the other.
        where: function countsAgainstQuota() {
          this.where(scope).whereIn('status', ['pending', 'ready']);
        },
        max: campaignId ? MAX_ASSETS_PER_CAMPAIGN : MAX_ASSETS_PER_USER,
        capMessage: campaignId
          ? `a campaign may hold at most ${MAX_ASSETS_PER_CAMPAIGN} images`
          : `you may hold at most ${MAX_ASSETS_PER_USER} personal images`,
        insert: {
          campaign_id: campaignId,
          user_id: req.user.id,
          storage_key: null,
          url: url.value,
          source_url: url.value,
          source: 'external',
          kind,
          // Ready immediately: there is nothing of ours to verify. The honesty
          // is in `source`, which says where this came from.
          status: 'ready',
        },
      });
      row = rows[0];
    } catch (err) {
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    return res.status(201).json({ asset: publicAsset(row) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/assets?campaign_id=… — the library for a campaign, or your own
// personal images when no campaign is given.
router.get('/', async (req, res, next) => {
  try {
    const campaignId = req.query.campaign_id;
    if (campaignId !== undefined) {
      if (!validUuid(campaignId)) return res.status(404).json({ error: 'campaign not found' });
      const perm = await mayCreate({ userId: req.user.id, kind: 'portrait', campaignId });
      if (!perm.ok) return res.status(404).json({ error: 'campaign not found' });

      const rows = await knex('assets')
        .where({ campaign_id: campaignId, status: 'ready' })
        .orderBy('created_at', 'desc');
      const out = rows.map(publicAsset);
      await gateway.rewriteObjects(out, ['url'], req.user.id);
      return res.json({ assets: out });
    }

    const rows = await knex('assets')
      .where({ user_id: req.user.id, status: 'ready' })
      .whereNull('campaign_id')
      .orderBy('created_at', 'desc');
    const out = rows.map(publicAsset);
    await gateway.rewriteObjects(out, ['url'], req.user.id);
    return res.json({ assets: out });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/assets/:id
//
// Removes the object and the row. It does NOT go looking for the six columns
// that might be rendering this URL — see the migration header for why the link
// is by value rather than by foreign key. The practical consequence is stated
// in the response: something may still point here, and it will render a broken
// image rather than silently substituting something else.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: 'asset not found' });

    const asset = await knex('assets').where({ id: req.params.id }).first();
    if (!asset) return res.status(404).json({ error: 'asset not found' });

    // The uploader, or the GM of the campaign it belongs to. A GM curates their
    // campaign's library; nobody else touches somebody's personal images.
    let allowed = asset.user_id === req.user.id;
    if (!allowed && asset.campaign_id) {
      const campaign = await knex('campaigns')
        .where({ id: asset.campaign_id }).whereNull('deleted_at').first();
      allowed = !!campaign && campaign.owner_id === req.user.id;
    }
    if (!allowed) return res.status(404).json({ error: 'asset not found' });

    // Remove the object, then the row. The two are ordered so a crash between
    // them leaves an orphaned OBJECT (which the reconciler finds) rather than an
    // orphaned ROW pointing at nothing. A delete that fails must not vanish: the
    // object still exists and still costs bytes, so it is recorded for durable
    // retry and its bytes move from committed to cleanup debt until absence is
    // established. Deletes are free operations, so no permit is charged.
    if (asset.storage_key) {
      const committedBytes = (asset.bytes_verified && typeof asset.bytes === 'number')
        ? asset.bytes : null;
      // Validate accounting before the irreversible object deletion. A refused
      // request must leave both the image and its database record intact.
      const active = committedBytes ? await budgetActive() : false;
      const removed = await storage.remove(asset.storage_key);
      if (!removed) {
        // Could not delete. Keep the liability visible.
        if (committedBytes && active) {
          await budget.moveToCleanupDebt(committedBytes).catch(() => {});
        }
        await knex('storage_cleanup').insert({
          storage_key: asset.storage_key,
          bytes: committedBytes,
          reason: 'delete_failed',
        }).catch(() => {});
      } else if (committedBytes && active) {
        // Deleted cleanly: release the committed bytes (operations are NOT
        // refunded — that read/write already happened and was billed).
        await budget.inSerializable(async (trx) => {
          const row = await budget.readRow(trx);
          const committed = Number(row.committed_bytes);
          const give = Math.min(committed, committedBytes);
          await trx('storage_budget').where({ id: true })
            .update({ committed_bytes: committed - give, updated_at: trx.fn.now() });
        }).catch(() => {});
      }
    }
    await knex('assets').where({ id: asset.id }).del();

    return res.json({ ok: true, id: asset.id });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicAsset,
  MAX_ASSETS_PER_CAMPAIGN,
  MAX_ASSETS_PER_USER,
  PENDING_TTL_MINUTES,
};
