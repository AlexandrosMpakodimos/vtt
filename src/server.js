if (process.env.NODE_ENV !== 'test') require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const helmet = require('helmet');

const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const knex = require('./db');
const { router: assetRoutes, PENDING_TTL_MINUTES: PENDING_ASSET_TTL_MINUTES } = require('./routes/assets');
const { router: mediaRoutes } = require('./routes/media');
const budget = require('./services/storageBudget');
const passport = require('./config/passport');
const authRoutes = require('./routes/auth');
const { router: campaignRoutes, SOFT_DELETE_DAYS } = require('./routes/campaigns');
const { initSockets } = require('./socket');
const { verifyOrigin } = require('./middleware/csrf');
const {
  loginLimiter, registerLimiter, resendLimiter,
  forgotPasswordLimiter, resetPasswordLimiter, changeEmailLimiter,
  campaignJoinLimiter, campaignSearchLimiter, campaignCreateLimiter,
} = require('./middleware/rateLimit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pgPool = new Pool(
  process.env.NODE_ENV === 'test'
    ? { ...require('../knexfile').test.connection }
    : { connectionString: process.env.DATABASE_URL }
);

const sessionMiddleware = session({
  store: new PgSession({ pool: pgPool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

// Security headers (nosniff, frame protection, HSTS, CSP, ...). Placed first so
// every response -- API, static files, and errors -- carries them.
const isProd = process.env.NODE_ENV === 'production';

// Browser-facing media origin. In production the existing `https:` img-src
// allowance already covers a normal HTTPS media hostname. Local development can
// explicitly use an HTTP origin such as http://media.test:3000; add only that
// exact configured origin to img-src rather than allowing arbitrary http:.
const cspMediaOrigin = (() => {
  const value = String(process.env.MEDIA_ORIGIN || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.origin : null;
  } catch {
    return null;
  }
})();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'https:', 'data:', ...(cspMediaOrigin ? [cspMediaOrigin] : [])],
      // connect-src must be stated EXPLICITLY once the browser uploads directly
      // to object storage. Without it the fallback is default-src 'self', which
      // refuses the connection before any CORS preflight is even attempted —
      // producing a bare "Failed to fetch" that looks exactly like a bucket
      // misconfiguration and is not one.
      //
      // Everything the page connects to must be listed, because naming this
      // directive overrides the default-src fallback for connections entirely:
      //
      //   'self'  the API, and the Socket.IO transport, which is same-origin
      //   ws/wss  the WebSocket upgrade — some browsers do not treat these as
      //           covered by 'self', and omitting them silently breaks the
      //           real-time layer while leaving HTTP working
      //   R2      the S3 endpoint the presigned PUT is addressed to — in BOTH
      //           addressing styles, because which one appears depends on the
      //           SDK rather than on us. The AWS client defaults to
      //           VIRTUAL-HOSTED style, putting the bucket in the hostname
      //           (`bucket.account.r2...`), while the account-only host is the
      //           path style. Listing only the latter produced a CSP refusal
      //           that read exactly like the first one and had a different
      //           cause, which cost a round trip to discover.
      //
      // The bucket host is read from configuration rather than hardcoded, so a
      // deployment pointing at a different provider needs no code change — and
      // an unconfigured install simply does not widen the policy at all.
      'connect-src': [
        "'self'", 'ws:', 'wss:',
        ...(process.env.R2_ACCOUNT_ID
          ? [
            `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            ...(process.env.R2_BUCKET
              ? [`https://${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`]
              : []),
          ]
          : []),
      ],
      'style-src': ["'self'", "'unsafe-inline'"], // the dev harness uses an inline <style> block
      // upgrade-insecure-requests only makes sense over HTTPS; dropping it in
      // local http development avoids breaking same-origin sub-resource loading.
      ...(isProd ? {} : { 'upgrade-insecure-requests': null }),
    },
  },
}));
if (process.env.NODE_ENV === 'test') {
  // Test-only control: invoke the real worker against memory storage.
  if (require('./services/storage').testBackend === 'memory') {
    app.post('/__test/cleanup/:id', async (req, res) => {
      try {
        const row = await knex('storage_cleanup').where({ id: req.params.id }).first();
        if (!row) return res.status(404).json({ error: 'queue_row_missing' });
        const worker = require('./services/storageCleanup');
        const first = await worker.processRow(row);
        let repeated = null;
        if (req.query.repeat === '1') {
          repeated = await worker.processRow(row);
        }
        return res.json({ first, repeated });
      } catch (error) {
        console.error('Test cleanup failed:', error.message);
        return res.status(500).json({ error: 'test_cleanup_failed' });
      }
    });
  }

  app.get('/__test/identity', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await knex.raw(
        'SELECT current_database() AS database, current_user AS role'
      );
      res.json({
        environment: 'test',
        ...result.rows[0],
        storageConfigured: require('./services/storage').isConfigured(),
        storageBackend: require('./services/storage').testBackend || 'disabled',
        storageStats: require('./services/storage').testStats || null,
        storageInventory: require('./services/storage').testInventory?.() || null,
        uploadMode: process.env.UPLOAD_MODE,
      });
    } catch {
      res.status(503).json({ error: 'test_database_unavailable' });
    }
  });
}

app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Media routes must be mounted on the real app. Put them after session/passport
// (the token endpoint requires auth) but before static files so /media/:id can
// never be shadowed by a public/media path. The media-byte endpoint itself
// enforces MEDIA_HOST and does not rely on the session.
app.use(mediaRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/resend-verification', resendLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth/reset-password', resetPasswordLimiter);
app.use('/api/auth/change-email', changeEmailLimiter);
// Defense-in-depth CSRF check on state-changing requests (no-op on GET/HEAD).
app.use('/api/auth', verifyOrigin);
app.use('/api/auth', authRoutes);

// Join verifies a room password, so it is limited like the login endpoint is.
app.use('/api/campaigns/:id/join', campaignJoinLimiter);
app.use('/api/campaigns/search', campaignSearchLimiter);
app.post('/api/campaigns', campaignCreateLimiter);
app.use('/api/campaigns', verifyOrigin);
// Assets are mounted OUTSIDE /api/campaigns because an avatar has no campaign.
// The consequence is that membership is checked inside the router rather than
// inherited from the path — see that file's header.
app.use('/api/assets', assetRoutes);
app.use('/api/campaigns', campaignRoutes);

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

// Campaign rooms + their authorisation. Exposed on the app so the kick/ban
// routes can evict a live socket, not merely update the database row.
app.set('campaignSockets', initSockets(io));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Something went wrong' });
});

// Periodically delete expired or already-used verification + password-reset tokens.
async function cleanupExpiredTokens() {
  try {
    const sweep = (table) =>
      knex(table).where('expires_at', '<', knex.fn.now()).orWhereNotNull('used_at').del();
    const v = await sweep('email_verification_tokens');
    const r = await sweep('password_reset_tokens');
    if (v || r) console.log(`Cleaned up ${v} verification + ${r} password-reset expired/used tokens`);
  } catch (err) {
    console.error('Token cleanup failed:', err.message);
  }
}
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);
cleanupExpiredTokens();

// Hard-delete campaigns whose 30-day soft-delete window has fully elapsed.
// Nothing reads these rows past the window (every listing filters deleted_at
// IS NULL, and /restore returns 410 after it), so this only reclaims storage.
// The FK cascade takes their campaign_members with them. Same hourly cadence
// and fail-soft shape as the token sweep above.
async function cleanupDeletedCampaigns() {
  try {
    const n = await knex('campaigns')
      .whereNotNull('deleted_at')
      .whereRaw(`deleted_at < now() - interval '${SOFT_DELETE_DAYS} days'`)
      .del();
    if (n) console.log(`Hard-deleted ${n} campaign(s) past the ${SOFT_DELETE_DAYS}-day recovery window`);
  } catch (err) {
    console.error('Campaign cleanup failed:', err.message);
  }
}
setInterval(cleanupDeletedCampaigns, 60 * 60 * 1000);
cleanupDeletedCampaigns();

// Reclaim upload authorisations that were issued and never used.
//
// A presigned URL creates a `pending` asset row before the bytes exist, because
// the quota has to be claimed before the authorisation is handed out. A client
// that asks for a URL and never uploads therefore holds quota indefinitely, and
// asking repeatedly would exhaust it without storing a single image.
//
// Same hourly cadence and fail-soft shape as the token and campaign sweeps
// above. Rejected rows go too: the object was already deleted at the moment of
// rejection, so the row is a record of something that no longer exists.
async function cleanupStaleAssets() {
  try {
    // A stale pending row may have an OBJECT behind it: the client got a
    // presigned URL and PUT the bytes but never confirmed, or confirmed and was
    // rejected. Deleting the ROW without deleting the OBJECT turns a tracked
    // upload into invisible storage — the exact leak the durable cleanup queue
    // exists to close. So each stale row that has a storage_key is enqueued for
    // deletion first, and its byte reservation (if the budget is active) is
    // released, before the row itself is removed. Rows with no storage_key
    // (external links never reach 'pending', but be defensive) just go.
    const stale = await knex('assets')
      .whereIn('status', ['pending', 'rejected'])
      .whereRaw(`created_at < now() - interval '${PENDING_ASSET_TTL_MINUTES} minutes'`)
      .select('id', 'storage_key', 'reserved_bytes');

    if (stale.length === 0) return;

    for (const row of stale) {
      if (row.storage_key) {
        // eslint-disable-next-line no-await-in-loop
        await knex('storage_cleanup').insert({
          storage_key: row.storage_key,
          bytes: null, // an unconfirmed object's size was never established
          reason: 'orphan_pending',
        }).catch(() => {});
      }
      if (typeof row.reserved_bytes === 'number' && row.reserved_bytes > 0) {
        // eslint-disable-next-line no-await-in-loop
        await budget.releaseReservedBytes(row.reserved_bytes).catch(() => {});
      }
    }

    const ids = stale.map((r) => r.id);
    const n = await knex('assets').whereIn('id', ids).del();
    if (n) console.log(`Cleared ${n} stale asset row(s); queued objects for deletion`);
  } catch (err) {
    console.error('Asset cleanup failed:', err.message);
  }
}
setInterval(cleanupStaleAssets, 60 * 60 * 1000);
cleanupStaleAssets();

// The durable cleanup worker drains storage_cleanup: objects that must not
// exist but whose deletion has not yet been confirmed. It runs more often than
// the hourly sweeps because a queued delete is a byte still being billed, and
// the sooner it clears the sooner the ledger frees the capacity. Fail-soft, and
// a no-op when storage is unconfigured. Bounded per tick (see the worker).
const cleanupWorker = require('./services/storageCleanup');
setInterval(() => { cleanupWorker.tick().catch((e) => console.error('cleanup tick:', e.message)); }, 5 * 60 * 1000);
cleanupWorker.tick().catch(() => {});

const PORT = process.env.PORT || 3000;
server.listen(
  PORT,
  process.env.NODE_ENV === 'test' ? '127.0.0.1' : undefined,
  () => console.log(`Server running at http://localhost:${PORT}`)
);