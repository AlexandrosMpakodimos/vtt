const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const bcrypt = require('bcrypt');
const knex = require('../db');

// Columns safe to attach to req.user (never the password hash).
const SAFE_COLUMNS = ['id', 'email', 'username', 'avatar_url', 'created_at'];

// How to verify a login attempt. We log in with email + password.
passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await knex('users').where({ email }).first();
      // Same generic message whether the email is unknown or the password is
      // wrong, so we don't leak which emails are registered.
      if (!user) return done(null, false, { message: 'Invalid email or password' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return done(null, false, { message: 'Invalid email or password' });

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

// On login, store only the user id in the session.
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// On every authenticated request, turn that id back into req.user.
passport.deserializeUser(async (id, done) => {
  try {
    const user = await knex('users').select(SAFE_COLUMNS).where({ id }).first();
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

module.exports = passport;