require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const passport = require('./config/passport'); // registers strategy + serialize/deserialize
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Session store (its own small pg pool, separate from Knex) ---
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const sessionMiddleware = session({
  store: new PgSession({
    pool: pgPool,
    createTableIfMissing: true, // auto-creates the "session" table on first run
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // requires HTTPS only in prod
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

// --- Express middleware. ORDER MATTERS: json -> session -> passport ---
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Routes ---
app.use('/api/auth', authRoutes);

// --- Share the SAME session + passport with Socket.io handshakes ---
// After this, socket.request.user is the logged-in user (or undefined).
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

io.on('connection', (socket) => {
  const user = socket.request.user;
  if (user) {
    console.log(`Socket connected: ${socket.id}  (user: ${user.username})`);
  } else {
    console.log(`Socket connected: ${socket.id}  (anonymous)`);
  }

  socket.on('ping', () => {
    socket.emit('pong', { message: 'hello from server', timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});