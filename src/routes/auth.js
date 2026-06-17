const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('../config/passport');
const knex = require('../db');

const router = express.Router();

const SAFE_COLUMNS = ['id', 'email', 'username', 'avatar_url', 'created_at'];

// Strip a full DB row down to what the client is allowed to see.
function publicUser(user) {
  if (!user) return null;
  const { id, email, username, avatar_url, created_at } = user;
  return { id, email, username, avatar_url, created_at };
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, username, password } = req.body || {};

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    // Friendly pre-check (the UNIQUE constraints below are the real guarantee).
    const existing = await knex('users')
      .where({ email })
      .orWhere({ username })
      .first();
    if (existing) {
      return res.status(409).json({ error: 'email or username already taken' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const [user] = await knex('users')
      .insert({ email, username, password_hash })
      .returning(SAFE_COLUMNS);

    // Log them in immediately so they don't have to re-enter credentials.
    req.login(user, (err) => {
      if (err) return next(err);
      return res.status(201).json({ user: publicUser(user) });
    });
  } catch (err) {
    // 23505 = Postgres unique_violation, in case two requests race past the pre-check.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email or username already taken' });
    }
    return next(err);
  }
});

// POST /api/auth/login
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: (info && info.message) || 'Invalid email or password' });
    }
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.json({ user: publicUser(user) });
    });
  })(req, res, next);
});

// POST /api/auth/logout
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ user: null });
  }
  return res.json({ user: publicUser(req.user) });
});

module.exports = router;