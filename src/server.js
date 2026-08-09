require('dotenv').config();

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

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'https:', 'data:'],   // allow externally-hosted https avatars
      'style-src': ["'self'", "'unsafe-inline'"], // the dev harness uses an inline <style> block
      // upgrade-insecure-requests only makes sense over HTTPS; dropping it in
      // local http development avoids breaking same-origin sub-resource loading.
      ...(isProd ? {} : { 'upgrade-insecure-requests': null }),
    },
  },
}));
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
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
    const n = await knex('assets')
      .whereIn('status', ['pending', 'rejected'])
      .whereRaw(`created_at < now() - interval '${PENDING_ASSET_TTL_MINUTES} minutes'`)
      .del();
    if (n) console.log(`Cleared ${n} stale asset row(s)`);
  } catch (err) {
    console.error('Asset cleanup failed:', err.message);
  }
}
setInterval(cleanupStaleAssets, 60 * 60 * 1000);
cleanupStaleAssets();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));