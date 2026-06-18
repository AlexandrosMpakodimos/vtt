const express = require('express');
const crypto = require('crypto');
const bcrypt = require("bcrypt");
const passport = require('../config/passport');
const knex = require('../db');
const { validateEmail, validateUsername, validatePassword, normalizeEmail } = require('../services/validators');
const { isPasswordBreached } = require('../services/breachedPassword');
const { sendVerificationEmail } = require('../services/mailer');

const router = express.Router();

const SAFE_COLUMNS = ['id', 'email', 'username', 'avatar_url', 'email_verified_at', 'created_at'];

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, email: user.email, username: user.username,
    avatar_url: user.avatar_url, email_verified: !!user.email_verified_at,
    created_at: user.created_at,
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function issueVerificationEmail(user) {
  // Invalidate any earlier tokens for this user so only the newest link works.
  await knex('email_verification_tokens').where({ user_id: user.id }).del();

  const rawToken = crypto.randomBytes(32).toString('hex');
  await knex('email_verification_tokens').insert({
    user_id: user.id,
    token_hash: sha256(rawToken),
    expires_at: knex.raw("now() + interval '24 hours'"),
  });

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const link = `${base}/api/auth/verify-email?token=${rawToken}`;
  try {
    await sendVerificationEmail(user.email, link);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
  }
}

// POST /api/auth/register — creates an UNVERIFIED account; does NOT log in.
router.post('/register', async (req, res, next) => {
  try {
    const { email, username, password } = req.body || {};
    const e = validateEmail(email);
    const u = validateUsername(username);
    const p = validatePassword(password);
    const errors = [e, u, p].filter((r) => r.error).map((r) => r.error);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    if (await isPasswordBreached(p.value)) {
      return res.status(400).json({ error: 'password is too common or has appeared in a data breach' });
    }

    const existing = await knex('users').where({ email: e.value }).orWhere({ username: u.value }).first();
    if (existing) return res.status(409).json({ error: 'email or username already taken' });

    const password_hash = await bcrypt.hash(p.value, 12);
    const [user] = await knex('users')
      .insert({ email: e.value, username: u.value, password_hash })
      .returning(SAFE_COLUMNS);

    await issueVerificationEmail(user);

    // No req.login here — they must verify, then log in.
    return res.status(201).json({
      message: 'Account created. Check your email to verify it before logging in.',
      user: publicUser(user),
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email or username already taken' });
    return next(err);
  }
});

// POST /api/auth/login — blocked until the email is verified.
router.post('/login', (req, res, next) => {
  if (req.body) req.body.email = normalizeEmail(req.body.email);
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: (info && info.message) || 'Invalid email or password' });
    if (!user.email_verified_at) {
      return res.status(403).json({ error: 'Please verify your email before logging in', email_verified: false });
    }
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.json({ user: publicUser(user) });
    });
  })(req, res, next);
});

// POST /api/auth/resend-verification — generic response (no enumeration).
router.post('/resend-verification', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'email is required' });
    const generic = { ok: true, message: 'If that account exists and is unverified, a new verification email has been sent.' };

    const user = await knex('users').where({ email }).first();
    if (user && !user.email_verified_at) {
      await issueVerificationEmail(user);
    }
    return res.json(generic);
  } catch (err) {
    return next(err);
  }
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
  if (!req.isAuthenticated()) return res.status(401).json({ user: null });
  return res.json({ user: publicUser(req.user) });
});

// GET /api/auth/verify-email?token=...
router.get('/verify-email', async (req, res, next) => {
  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <body style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center">
     <h1>${title}</h1><p>${body}</p></body>`;
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send(page('Invalid link', 'No token provided.'));

    const row = await knex('email_verification_tokens').where({ token_hash: sha256(String(token)) }).first();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return res.status(400).send(page('Link invalid or expired', 'Please request a new verification email.'));
    }

    await knex.transaction(async (trx) => {
      await trx('users').where({ id: row.user_id }).update({ email_verified_at: trx.fn.now() });
      await trx('email_verification_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
    });

    return res.send(page('Email verified ✓', 'You can close this tab and return to VTT.'));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;