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
// THE UPLOAD IS A THREE-STEP CONVERSATION
// ---------------------------------------------------------------------------
//   POST /api/assets/presign    we authorise ONE upload and record it pending
//   (client PUTs the bytes straight to R2 — never through this server)
//   POST /api/assets/:id/confirm  we read the bytes back and verify them
//
// The middle step deliberately does not involve us. Proxying the file would
// double the bandwidth, put an arbitrary-size body through a process that
// currently caps JSON at 100 kB, and buy nothing: we verify afterwards either
// way, and the presigned URL already pins the type and the length.
//
// The third step is the one that matters. Everything before it is the client's
// word, and R2 — unlike an image CDN — stores exactly what it is given.

const express = require('express');
const knex = require('../db');
const { requireAuth } = require('../middleware/auth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const { withAtomicCap } = require('../services/atomicCap');
const { validateImageUrl, validateInt, validUuid } = require('../services/validators');
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

// UPLOAD_MODE controls which write paths exist.
//   'proxy'  (default): the controlled, server-proxied upload is available AND
//            the legacy presigned-PUT path remains, for compatibility during
//            cutover. Both are metered; presign's replay weakness persists while
//            it is enabled, which is why strict mode exists.
//   'strict': ONLY the controlled path. Legacy presign issuance is DISABLED
//            (returns 410 Gone). This is the state in which the upload path has
//            no replayable, under-metered grant. Cutover moves here once every
//            client is on the controlled path and outstanding presigned grants
//            (max UPLOAD_URL_TTL_SECONDS old) have expired.
const UPLOAD_MODE = (process.env.UPLOAD_MODE || 'proxy').toLowerCase();
const STRICT_UPLOADS = UPLOAD_MODE === 'strict';

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

// A presigned URL that is never used leaves a pending row holding quota. It is
// reclaimed by the sweep in server.js after this long.
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

// POST /api/assets/presign — authorise exactly one upload.
//
// Refusals are 404 rather than 403 for a campaign the caller cannot reach, so
// this route cannot be used to discover which campaigns exist. A member who may
// not upload a MAP gets 403, because by then their membership is established
// and the refusal discloses nothing new.
router.post('/presign', (req, res, next) => {
  // Strict mode disables the legacy presigned-PUT path entirely — before the
  // storage-configured check, because the endpoint is GONE in strict mode
  // whether or not a bucket is present. A grant already issued before the switch
  // remains valid only until it expires (UPLOAD_URL_TTL_SECONDS); no NEW grant
  // is issued here.
  if (STRICT_UPLOADS) {
    return res.status(410).json({
      error: 'presign_disabled',
      message: 'direct presigned uploads are disabled; use POST /api/assets/upload',
    });
  }
  return next();
}, requireStorage, async (req, res, next) => {
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
      if (perm.forbidden) return res.status(403).json({ error: `only the GM may upload a ${kind}` });
      return res.status(404).json({ error: 'campaign not found' });
    }

    const mime = typeof body.mime === 'string' ? body.mime.trim().toLowerCase() : '';
    const fmt = storage.formatFor(mime);
    if (!fmt) {
      // SVG lands here, and that is the point: it is not in the allow-list, so
      // there is no path by which a scriptable image reaches the bucket.
      return res.status(400).json({ error: `mime must be one of: ${storage.allowedMimes().join(', ')}` });
    }

    const limit = storage.limitFor(kind);
    const size = validateInt(body.bytes, { min: 1, max: limit, field: 'bytes' });
    if (size.error) return res.status(400).json({ error: size.error });

    const key = storage.buildKey({
      campaignId, userId: req.user.id, kind, ext: fmt.ext,
    });

    // The quota is claimed BEFORE the URL is issued, not after the upload
    // succeeds. Issuing an authorisation that would exceed the cap and then
    // refusing the result would waste the user's upload and leave an object in
    // the bucket to clean up.
    //
    // [FIXED 2026-08-09] The count MUST include `pending`, and originally did
    // not — it counted only `ready`, which meant a pending row claimed nothing
    // and the cap did not hold at all:
    //
    //   with zero ready rows, request five hundred presigned URLs — every one
    //   passes a check against zero — then upload and confirm them all. Confirm
    //   performs no cap check; it only flips a status. Five hundred assets
    //   against a limit of three hundred.
    //
    // The comment directly above described the intent correctly and the code
    // did something else. An authorisation that has been issued is an allowance
    // that has been spent, whether or not the bytes ever arrive; the stale-row
    // sweep is what returns it if they do not.
    //
    // Expressed as a callback because the primitive takes a `where` object and
    // this needs a set membership. Knex groups the callback's conditions, so
    // the scope and the status test are ANDed as one clause.
    // The BYTE budget is reserved before the presigned URL is issued, for the
    // same reason the IMAGE cap is claimed here rather than at confirm: an
    // authorisation to write is an allowance spent whether or not the bytes
    // arrive. The maximum accepted size is reserved (the request's declared
    // bytes, already bounded by the kind limit); the stale-row sweep releases it
    // if the upload never completes, and confirm converts it to committed if it
    // does. Only when the budget is ACTIVE — see budgetActive() — otherwise this
    // is a no-op and uploads behave exactly as before.
    const active = await budgetActive();
    let reservedBytes = 0;
    if (active) {
      try {
        await budget.reserveBytes(size.value);
        reservedBytes = size.value;
      } catch (err) {
        if (err.budgetExceeded) {
          return res.status(507).json({
            error: 'storage_budget_reached',
            message: 'the application has reached its storage budget; new uploads are paused',
          });
        }
        throw err;
      }
    }

    const scope = campaignId ? { campaign_id: campaignId } : { user_id: req.user.id, campaign_id: null };
    let row;
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
        },
      });
      row = rows[0];
    } catch (err) {
      // The image cap refused AFTER we reserved bytes: give the reservation back
      // so a refused upload does not leak budget.
      if (reservedBytes) await budget.releaseReservedBytes(reservedBytes).catch(() => {});
      if (err.capExceeded) return res.status(409).json({ error: err.message });
      throw err;
    }

    // The presigned PUT is a Class A operation the account will be billed for
    // when the client uses it. Charge the permit now, while active; a failure to
    // charge releases the byte reservation too.
    if (active) {
      try {
        await budget.charge('put');
      } catch (err) {
        if (reservedBytes) await budget.releaseReservedBytes(reservedBytes).catch(() => {});
        await knex('assets').where({ id: row.id }).del().catch(() => {});
        if (err.budgetExceeded) {
          return res.status(507).json({
            error: 'operation_budget_reached',
            message: 'the application has reached its operation budget; new uploads are paused',
          });
        }
        throw err;
      }
    }

    const uploadUrl = await storage.presignUpload({ key, mime, bytes: size.value });

    return res.status(201).json({
      asset: publicAsset(row),
      upload: {
        url: uploadUrl,
        method: 'PUT',
        // Content-Type only. `Content-Length` is a FORBIDDEN HEADER NAME in
        // fetch — the browser drops it from a Headers object and sets it
        // itself from the body — so sending it here is inert at best and
        // misleading at worst. It is still signed, and the browser still
        // transmits it, so the size limit is still enforced by the storage
        // service; it simply is not something the client sets.
        headers: { 'Content-Type': mime },
        expires_in: storage.UPLOAD_URL_TTL_SECONDS,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/assets/upload — the CONTROLLED upload path.
//
// This is the path the safety brief requires and the answer to "presigned
// uploads bypass exact operation enforcement". Instead of handing the browser a
// replayable PUT grant, the bytes come THROUGH the server: we validate them,
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

      // Verify the bytes ARE the declared type BEFORE writing anything. The
      // presign path could only check this after the object existed (a read-back
      // at confirm); here the bytes are in hand, so a liar never reaches R2 at
      // all — no wasted write, no object to clean up.
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

      // Reserve the ACTUAL byte count (we have the bytes, so no need to reserve a
      // declared maximum as presign does).
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
      let etag = null;
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
          const put = await storage.putObject({ key, mime, body: bytes });
          etag = put.etag;
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
        etag: etag || null,
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


// bytes back out of the bucket and checks them against the magic numbers for
// the format that was claimed.
//
// A file whose bytes disagree with its declared type is DELETED and the row
// marked rejected — not stored and flagged, because an object that is not what
// it says it is has no reason to remain in the bucket.
router.post('/:id/confirm', requireStorage, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: 'asset not found' });

    // Scoped to the uploader. Confirming somebody else's pending upload would
    // let one user complete another's authorisation.
    const asset = await knex('assets')
      .where({ id: req.params.id, user_id: req.user.id }).first();
    if (!asset) return res.status(404).json({ error: 'asset not found' });
    if (asset.status !== 'pending') {
      return res.status(409).json({ error: `asset is already ${asset.status}` });
    }

    const active = await budgetActive();

    // The readback is a Class B GET. Charge the permit before touching R2, while
    // active; if the operation budget is exhausted we do not read.
    if (active) {
      try {
        await budget.charge('get');
      } catch (err) {
        if (err.budgetExceeded) {
          return res.status(507).json({
            error: 'operation_budget_reached',
            message: 'the application has reached its operation budget; try again next period',
          });
        }
        throw err;
      }
    }

    let head;
    try {
      head = await storage.readHead(asset.storage_key);
    } catch {
      // Nothing is there. The presigned URL was issued and never used, or the
      // upload failed. Not an error on the client's part; the row simply never
      // becomes usable. The reservation is left for the sweep to reclaim.
      return res.status(409).json({ error: 'no upload found for that asset' });
    }

    const declared = head.reportedMime;
    const ok = storage.magicMatches(declared, head.head);

    if (!ok) {
      // The bytes are not the image they claimed to be. The object must not
      // remain. Deletion can fail, and a swallowed failure is exactly the leak
      // the durable cleanup queue exists to catch: try once, and if it does not
      // succeed, record the object so a worker retries until absence is
      // established. The size was never HEADed (we do not HEAD a liar), so no
      // committed bytes are involved — only the presign reservation, which is
      // released here rather than waiting on the 30-minute sweep.
      const removed = await storage.remove(asset.storage_key);
      if (!removed) {
        await knex('storage_cleanup').insert({
          storage_key: asset.storage_key,
          bytes: null, // size unknown for a rejected upload
          reason: 'rejected',
        }).catch(() => {});
      }
      if (active && typeof asset.reserved_bytes === 'number' && asset.reserved_bytes > 0) {
        await budget.releaseReservedBytes(asset.reserved_bytes).catch(() => {});
      }
      await knex('assets').where({ id: asset.id })
        .update({ status: 'rejected', reserved_bytes: null, updated_at: knex.fn.now() });
      return res.status(400).json({
        error: 'that file is not the image type it claims to be',
      });
    }

    // The SIZE is established authoritatively by a HEAD, never by the ranged
    // read above. `readHead` fetches sixteen bytes to check the magic numbers,
    // and the length of that slice is sixteen — recording it as the object's
    // size stored 16 for every upload regardless of the real file (the bug this
    // replaces). A HEAD returns the whole object's Content-Length. It costs one
    // Class B operation, which is the correct price for learning what we are
    // about to be billed to store.
    // The HEAD that establishes the authoritative size is itself a Class B
    // operation. Charge it too.
    if (active) {
      try {
        await budget.charge('head');
      } catch (err) {
        if (err.budgetExceeded) {
          return res.status(507).json({
            error: 'operation_budget_reached',
            message: 'the application has reached its operation budget; try again next period',
          });
        }
        throw err;
      }
    }

    let authoritative;
    try {
      authoritative = await storage.headSize(asset.storage_key);
    } catch {
      // The object was there for the ranged read a moment ago; if the HEAD
      // fails now, do not guess a size. Leave the row pending for the sweep to
      // reconcile rather than committing a byte count we cannot stand behind.
      return res.status(409).json({ error: 'could not verify the stored object size' });
    }
    if (typeof authoritative.bytes !== 'number' || authoritative.bytes <= 0) {
      return res.status(409).json({ error: 'stored object reported no size' });
    }

    // Reconcile the reservation against the real stored size. We reserved the
    // declared maximum at presign; the object may be smaller. Commit the ACTUAL
    // bytes, and release the difference so the ledger reflects what is truly
    // stored rather than what was promised. The signed content-length means the
    // real size cannot EXCEED the reservation, so this only ever releases; a
    // larger-than-reserved size would be a provider anomaly and is clamped by
    // committing the reservation and flagging the row for reconciliation.
    if (active) {
      const reserved = typeof asset.reserved_bytes === 'number' ? asset.reserved_bytes : 0;
      const realBytes = authoritative.bytes;
      if (reserved > 0) {
        const toCommit = Math.min(realBytes, reserved);
        await budget.commitReservedBytes(toCommit);
        if (reserved > toCommit) {
          await budget.releaseReservedBytes(reserved - toCommit).catch(() => {});
        }
        // realBytes should never exceed reserved (length is signed); if a
        // provider ever reported otherwise, the extra is NOT silently committed
        // — bytes_verified is left false below so the reconciler revisits it.
      }
    }

    const trustworthy = !active
      ? false // when inactive we still record the real size, but it is not yet
      // ledger-charged; the reconciler will fold it in at initialisation.
      : (typeof asset.reserved_bytes === 'number'
        ? authoritative.bytes <= asset.reserved_bytes
        : false);

    const [row] = await knex('assets').where({ id: asset.id }).update({
      status: 'ready',
      mime: declared,
      bytes: authoritative.bytes,
      bytes_verified: trustworthy,
      etag: authoritative.etag || null,
      reserved_bytes: null,
      updated_at: knex.fn.now(),
    }).returning('*');

    return res.json({ asset: publicAsset(row) });
  } catch (err) {
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
        // Same scope as presign. An external link is `ready` immediately and has
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
      const removed = await storage.remove(asset.storage_key);
      const committedBytes = (asset.bytes_verified && typeof asset.bytes === 'number')
        ? asset.bytes : null;
      if (!removed) {
        // Could not delete. Keep the liability visible.
        if (committedBytes && await budgetActive()) {
          await budget.moveToCleanupDebt(committedBytes).catch(() => {});
        }
        await knex('storage_cleanup').insert({
          storage_key: asset.storage_key,
          bytes: committedBytes,
          reason: 'delete_failed',
        }).catch(() => {});
      } else if (committedBytes && await budgetActive()) {
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
