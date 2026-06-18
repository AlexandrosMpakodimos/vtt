require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const knex = require('./db');
const passport = require('./config/passport');
const authRoutes = require('./routes/auth');
const { loginLimiter, registerLimiter, resendLimiter } = require('./middleware/rateLimit');

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

app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/resend-verification', resendLimiter);
app.use('/api/auth', authRoutes);

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

io.on('connection', (socket) => {
  const user = socket.request.user;
  console.log(`Socket connected: ${socket.id}  (${user ? 'user: ' + user.username : 'anonymous'})`);
  socket.on('ping', () => socket.emit('pong', { message: 'hello from server', timestamp: Date.now() }));
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Something went wrong' });
});

// Periodically delete expired or already-used verification tokens.
async function cleanupExpiredTokens() {
  try {
    const n = await knex('email_verification_tokens')
      .where('expires_at', '<', knex.fn.now())
      .orWhereNotNull('used_at')
      .del();
    if (n) console.log(`Cleaned up ${n} expired/used verification tokens`);
  } catch (err) {
    console.error('Token cleanup failed:', err.message);
  }
}
setInterval(cleanupExpiredTokens, 60 * 60 * 1000); // hourly
cleanupExpiredTokens(); // also at startup

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));