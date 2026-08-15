const express = require('express');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('../services/password');
const passport = require('../config/passport');
const knex = require('../db');
const { validateEmail, validateUsername, validatePassword, normalizeEmail } = require('../services/validators');
const { isPasswordBreached } = require('../services/breachedPassword');
const { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeEmail } = require('../services/mailer');
const { requireAuth } = require('../middleware/auth');

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
  // Invalidate earlier signup tokens for this user so only the newest link works.
  await knex('email_verification_tokens').where({ user_id: user.id, purpose: 'signup' }).del();

  const rawToken = crypto.randomBytes(32).toString('hex');
  await knex('email_verification_tokens').insert({
    user_id: user.id,
    token_hash: sha256(rawToken),
    purpose: 'signup',
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

async function issuePasswordResetEmail(user) {
  // Invalidate any earlier reset tokens so only the newest link works.
  await knex('password_reset_tokens').where({ user_id: user.id }).del();

  const rawToken = crypto.randomBytes(32).toString('hex');
  await knex('password_reset_tokens').insert({
    user_id: user.id,
    token_hash: sha256(rawToken),
    expires_at: knex.raw("now() + interval '1 hour'"),
  });

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const link = `${base}/api/auth/reset-password?token=${rawToken}`;
  try {
    await sendPasswordResetEmail(user.email, link);
  } catch (err) {
    console.error('Failed to send password reset email:', err.message);
  }
}

// Delete sessions belonging to a user (Passport stores the id in the session JSON).
// Pass exceptSid to keep one alive — e.g. the user's current session on a password change.
async function destroyUserSessions(trx, userId, exceptSid) {
  const q = trx('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [userId]);
  if (exceptSid) q.andWhereNot('sid', exceptSid);
  await q.del();
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

    const password_hash = await hashPassword(p.value);
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

// POST /api/auth/forgot-password — generic response (no enumeration).
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'email is required' });
    const generic = { ok: true, message: 'If an account with that email exists, a password reset link has been sent.' };

    const user = await knex('users').where({ email }).first();
    if (user) {
      await issuePasswordResetEmail(user);
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

    const row = await knex('email_verification_tokens').where({ token_hash: sha256(String(token)), purpose: 'signup' }).first();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return res.status(400).send(page('Link invalid or expired', 'Please request a new verification email.'));
    }

    await knex.transaction(async (trx) => {
      await trx('users').where({ id: row.user_id }).update({ email_verified_at: trx.fn.now() });
      await trx('email_verification_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
    });

    return res.send(page('Email verified \u2713', 'You can close this tab and return to VTT.'));
  } catch (err) {
    return next(err);
  }
});

// GET /api/auth/reset-password?token=... — validate, then hand off to the landing page.
// The inline-scripted form this route used to serve was blocked by the app's own
// CSP (script-src 'self'), so the button fell through to a native submit that
// dropped the token. The working reset form now lives on the landing page; this
// route keeps its token pre-check (UX the design already had) and swaps its two
// send(html) outcomes for redirects. POST /reset-password and the mailer link are
// unchanged; authority stays server-side (the POST re-validates regardless).
router.get('/reset-password', async (req, res, next) => {
  try {
    const { token } = req.query;
    const row = token
      ? await knex('password_reset_tokens').where({ token_hash: sha256(String(token)) }).first()
      : null;
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return res.redirect('/?reset_error=1');
    }
    return res.redirect(`/?reset=${encodeURIComponent(String(token))}`);
  } catch (err) { return next(err); }
});

// POST /api/auth/reset-password — validate token + new password, update it, log out everywhere.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });

    const p = validatePassword(password);
    if (p.error) return res.status(400).json({ error: p.error });
    if (await isPasswordBreached(p.value)) {
      return res.status(400).json({ error: 'password is too common or has appeared in a data breach' });
    }

    const row = await knex('password_reset_tokens').where({ token_hash: sha256(String(token)) }).first();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Reset link is invalid or expired' });
    }

    const password_hash = await hashPassword(p.value);
    await knex.transaction(async (trx) => {
      await trx('users').where({ id: row.user_id }).update({ password_hash });
      await trx('password_reset_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
      await trx('password_reset_tokens').where({ user_id: row.user_id }).whereNull('used_at').del();
      await destroyUserSessions(trx, row.user_id);
    });

    return res.json({ ok: true, message: 'Password reset. You can now log in with your new password.' });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/auth/me — update profile fields (username, avatar_url). Logged-in only.
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.username !== undefined) {
      const u = validateUsername(body.username);
      if (u.error) return res.status(400).json({ error: u.error });
      updates.username = u.value;
    }

    if (body.avatar_url !== undefined) {
      let a = String(body.avatar_url).trim();
      if (a.length > 2000) return res.status(400).json({ error: 'avatar_url is too long' });
      if (a) {
        let parsed;
        try {
          parsed = new URL(a);
        } catch {
          return res.status(400).json({ error: 'avatar_url must be a valid URL' });
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ error: 'avatar_url must use http:// or https://' });
        }
        // Store the normalized form: new URL() percent-encodes any HTML-significant
        // characters (" < >), so a stored value can't break out of an attribute later.
        a = parsed.href;
      }
      updates.avatar_url = a || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update (send username and/or avatar_url)' });
    }

    const [user] = await knex('users').where({ id: req.user.id }).update(updates).returning(SAFE_COLUMNS);
    return res.json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username already taken' });
    return next(err);
  }
});

// POST /api/auth/change-password — verify current password, set a new one, drop other sessions.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'currentPassword is required' });

    // Re-authenticate: req.user has no hash (SAFE_COLUMNS), so fetch it.
    const row = await knex('users').where({ id: req.user.id }).first();
    const ok = row && (await verifyPassword(row.password_hash, currentPassword));
    if (!ok) return res.status(400).json({ error: 'current password is incorrect' });

    const p = validatePassword(newPassword);
    if (p.error) return res.status(400).json({ error: p.error });
    if (await verifyPassword(row.password_hash, p.value)) {
      return res.status(400).json({ error: 'new password must be different from the current one' });
    }
    if (await isPasswordBreached(p.value)) {
      return res.status(400).json({ error: 'password is too common or has appeared in a data breach' });
    }

    const password_hash = await hashPassword(p.value);
    await knex.transaction(async (trx) => {
      await trx('users').where({ id: req.user.id }).update({ password_hash });
      // Keep this session; log out the user's other devices.
      await destroyUserSessions(trx, req.user.id, req.sessionID);
    });

    return res.json({ ok: true, message: 'Password changed. Other sessions have been logged out.' });
  } catch (err) {
    return next(err);
  }
});

async function issueEmailChangeEmail(user, newEmail) {
  // Invalidate prior email-change tokens so only the newest change link works.
  await knex('email_verification_tokens').where({ user_id: user.id, purpose: 'email_change' }).del();
  const rawToken = crypto.randomBytes(32).toString('hex');
  await knex('email_verification_tokens').insert({
    user_id: user.id,
    token_hash: sha256(rawToken),
    purpose: 'email_change',
    expires_at: knex.raw("now() + interval '1 hour'"),
  });
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const link = `${base}/api/auth/verify-email-change?token=${rawToken}`;
  try {
    await sendEmailChangeEmail(newEmail, link);
  } catch (err) {
    console.error('Failed to send email-change email:', err.message);
  }
}

// POST /api/auth/change-email — request an email change; confirm link goes to the NEW address.
router.post('/change-email', requireAuth, async (req, res, next) => {
  try {
    const { newEmail, currentPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'currentPassword is required' });

    // Re-authenticate: sensitive action, and req.user has no hash.
    const row = await knex('users').where({ id: req.user.id }).first();
    const ok = row && (await verifyPassword(row.password_hash, currentPassword));
    if (!ok) return res.status(400).json({ error: 'current password is incorrect' });

    const e = validateEmail(newEmail);
    if (e.error) return res.status(400).json({ error: e.error });
    if (e.value === row.email) return res.status(400).json({ error: 'that is already your email address' });

    const taken = await knex('users').where({ email: e.value }).first();
    if (taken) return res.status(409).json({ error: 'email is already in use' });

    await knex('users').where({ id: row.id }).update({ pending_email: e.value });
    await issueEmailChangeEmail(row, e.value);

    return res.json({ ok: true, message: 'Check your new email address to confirm the change.' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email is already in use' });
    return next(err);
  }
});

// GET /api/auth/verify-email-change?token=... — confirm and swap the email.
router.get('/verify-email-change', async (req, res, next) => {
  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <body style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center">
     <h1>${title}</h1><p>${body}</p></body>`;
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send(page('Invalid link', 'No token provided.'));

    const tok = await knex('email_verification_tokens').where({ token_hash: sha256(String(token)), purpose: 'email_change' }).first();
    if (!tok || tok.used_at || new Date(tok.expires_at) < new Date()) {
      return res.status(400).send(page('Link invalid or expired', 'Please request the email change again.'));
    }

    const user = await knex('users').where({ id: tok.user_id }).first();
    if (!user || !user.pending_email) {
      return res.status(400).send(page('Nothing to confirm', 'There is no pending email change for this account.'));
    }

    // The address may have been taken in the gap between request and confirmation.
    const taken = await knex('users').where({ email: user.pending_email }).whereNot({ id: user.id }).first();
    if (taken) {
      return res.status(409).send(page('Email no longer available', 'That address was taken in the meantime — please try a different one.'));
    }

    await knex.transaction(async (trx) => {
      await trx('users').where({ id: user.id }).update({
        email: user.pending_email,
        pending_email: null,
        email_verified_at: trx.fn.now(),
      });
      await trx('email_verification_tokens').where({ id: tok.id }).update({ used_at: trx.fn.now() });
    });

    return res.send(page('Email updated \u2713', 'Your email address has been changed. You can close this tab.'));
  } catch (err) {
    if (err.code === '23505') return res.status(409).send(page('Email no longer available', 'That address is already in use.'));
    return next(err);
  }
});

module.exports = router;