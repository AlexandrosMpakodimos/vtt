if (process.env.NODE_ENV !== 'test') require('dotenv').config();

const { createLifecycle } = require('./lifecycle');
const lifecycle = createLifecycle();
process.on('SIGTERM', () => lifecycle.shutdown());
process.on('SIGINT', () => lifecycle.shutdown());
const startupCheckDeadline = setTimeout(() => {
  console.error('STARTUP_CHECK_DEADLINE');
  lifecycle.shutdown(1);
}, 20000);
const startupDeadline = setTimeout(() => {
  console.error('STARTUP_DEADLINE');
  // Hard limit includes partial-setup cleanup begun at the check deadline.
  lifecycle.shutdown(1);
  process.exit(1);
}, 30000);

async function start() {
require('./config/startup').validate(process.env);
const coordinationConfig = require('./coordination/config').configuration(process.env);
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const helmet = require('helmet');

const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const knex = require('./db');
lifecycle.pools.push(() => knex.destroy());
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

const rateLimits = require('./middleware/rateLimit');
let rateLimitBackend;
lifecycle.stoppers.push(() => rateLimits.stop());
if (coordinationConfig) {
  rateLimitBackend = require('./rateLimit/backend').createBackend({ ...coordinationConfig,
    secret: process.env.SESSION_SECRET,
    onFailure() { console.error('RATE_LIMIT_BACKEND_FAILED'); lifecycle.shutdown(1); },
  });
  rateLimits.configureBackend(rateLimitBackend);
}

const app = express();
app.set('workLifecycle', lifecycle);
app.set('trust proxy', require('./config/proxy').proxyHops(process.env));
const server = http.createServer(app);
let io;
const connections = new Set();
server.on('connection', connection => {
  connections.add(connection);
  connection.once('close', () => connections.delete(connection));
});
// One owner closes HTTP: Socket.IO when attached, the raw server on partial setup.
lifecycle.transports.push(() => new Promise((resolve, reject) => {
  const complete = error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve();
  if (io) io.close(complete).catch(reject);
  else server.close(complete);
  server.closeIdleConnections?.();
}));
lifecycle.forceTransports.push(() => {
  io?.disconnectSockets(true);
  io?.engine.close();
  for (const connection of connections) connection.destroy();
});
io = new Server(server, coordinationConfig ? { transports: ['websocket'] } : {});

const pgPool = new Pool(
  process.env.NODE_ENV === 'test'
    ? { ...require('../knexfile').test.connection }
    : process.env.NODE_ENV === 'production'
      ? require('./config/database').sessionConfiguration(process.env)
      : { connectionString: process.env.DATABASE_URL }
);

pgPool.on('error', () => { console.error('SESSION_POOL_ERROR'); lifecycle.shutdown(1); });
lifecycle.pools.push(() => pgPool.end());
const sessionStore = new PgSession({ pool: pgPool,
    createTableIfMissing: process.env.NODE_ENV !== 'production',
    ...(process.env.NODE_ENV === 'production' ? { schemaName: 'public', tableName: 'session',
      errorLog: () => console.error('SESSION_STORE_ERROR: Session database operation failed.') } : {}),
  });
// Track the store's complete query promise, including lazy development setup.
const storeQuery = sessionStore._asyncQuery.bind(sessionStore);
sessionStore._asyncQuery = (...args) => lifecycle.track(storeQuery(...args));
lifecycle.stoppers.push(() => sessionStore.close());
const sessionMiddleware = session({
  store: sessionStore,
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
app.all('/healthz', lifecycle.health);
app.use(lifecycle.admit);

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
app.use(lifecycle.middleware(sessionMiddleware));
app.use(lifecycle.middleware(passport.initialize()));
app.use(lifecycle.middleware(passport.session()));

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

io.engine.use((req, res, next) => {
  if (lifecycle.state !== 'ready') return next(new Error('unavailable'));
  next();
});
// Callback-based handshake work must survive a transport disconnect.
for (const middleware of [sessionMiddleware, passport.initialize(), passport.session()]) {
  io.engine.use(lifecycle.middleware(middleware));
}
io.use((socket, next) => lifecycle.state === 'ready' ? next() : next(new Error('unavailable')));
io.on('connection', socket => lifecycle.instrumentSocket(socket));


// Campaign rooms + their authorisation. Exposed on the app so the kick/ban
// routes can evict a live socket, not merely update the database row.
let coordination;
if (coordinationConfig) {
  const { createBus } = require('./coordination/bus');
  const { createCoordinatedSockets } = require('./coordination/sockets');
  const bus = createBus({ ...coordinationConfig, onFailure(reason) {
    console.error('COORDINATION_FAILED', reason);
    // Transport closure permits the clients' normal reconnect + state reload.
    for (const socket of io.sockets.sockets.values()) socket.conn.close();
    lifecycle.shutdown(1);
  } });
  coordination = createCoordinatedSockets({ io, knex, bus, workLifecycle: lifecycle,
    rewritePayload: require('./services/mediaGateway').rewritePayload });
  lifecycle.stoppers.push(() => coordination.stop());
  lifecycle.forceTransports.push(() => coordination.stop());
}
const campaignSockets = initSockets(io, lifecycle, coordination);
// Some callers intentionally broadcast without awaiting. Keep those promises.
for (const [name, fn] of Object.entries(campaignSockets)) {
  if (typeof fn === 'function') campaignSockets[name] = (...args) => {
    const result = lifecycle.track(fn(...args));
    result?.catch?.(() => console.error('SOCKET_DELIVERY_FAILED'));
    return result;
  };
}
app.set('campaignSockets', campaignSockets);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('HTTP_REQUEST_FAILED');
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
    console.error('TOKEN_CLEANUP_FAILED');
  }
}


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
    console.error('CAMPAIGN_CLEANUP_FAILED');
  }
}


const { cleanupStaleAssets } = require('./services/staleAssetCleanup');


// The durable cleanup worker drains storage_cleanup: objects that must not
// exist but whose deletion has not yet been confirmed. It runs more often than
// the hourly sweeps because a queued delete is a byte still being billed, and
// the sooner it clears the sooner the ledger frees the capacity. Fail-soft, and
// a no-op when storage is unconfigured. Bounded per tick (see the worker).
const cleanupWorker = require('./services/storageCleanup');
// Instrument after all routes are mounted, excluding the SQL-free health route.
lifecycle.instrumentExpress(app._router.stack.filter(layer => layer.route?.path !== '/healthz'));
await lifecycle.track(require('./startupChecks').checkStartup(knex, pgPool, isProd));
if (coordination) await lifecycle.track(coordination.start());
if (rateLimitBackend) await lifecycle.track(rateLimitBackend.start());
if (lifecycle.state !== 'starting') return;
const PORT = process.env.PORT || 3000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, process.env.NODE_ENV === 'test' ? '127.0.0.1' : undefined, resolve);
});
if (lifecycle.state !== 'starting') return;
lifecycle.ready();
clearTimeout(startupDeadline);
clearTimeout(startupCheckDeadline);
lifecycle.schedule(cleanupExpiredTokens, 60 * 60 * 1000);
lifecycle.schedule(cleanupDeletedCampaigns, 60 * 60 * 1000);
lifecycle.schedule(cleanupStaleAssets, 60 * 60 * 1000);
lifecycle.schedule(() => cleanupWorker.tick(), 5 * 60 * 1000);
console.log('STARTUP_READY');
}
start().catch(error => {
  console.error(require('./config/startup').diagnostic(error));
  lifecycle.shutdown(1).then(() => { clearTimeout(startupDeadline); clearTimeout(startupCheckDeadline); });
});
