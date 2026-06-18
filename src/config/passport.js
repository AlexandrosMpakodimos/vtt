const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const bcrypt = require('bcrypt');
const knex = require('../db');

const SAFE_COLUMNS = ['id', 'email', 'username', 'avatar_url', 'email_verified_at', 'created_at'];

// A real hash to compare against when no user is found, so the "unknown email"
// path costs the same time as the "wrong password" path (defeats timing-based
// user enumeration).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', 12);

passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await knex('users').where({ email }).first();
      if (!user) {
        await bcrypt.compare(password, DUMMY_HASH); // burn equivalent time
        return done(null, false, { message: 'Invalid email or password' });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return done(null, false, { message: 'Invalid email or password' });

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await knex('users').select(SAFE_COLUMNS).where({ id }).first();
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

module.exports = passport;