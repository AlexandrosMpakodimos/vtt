const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const { verifyPassword } = require('../services/password');
const knex = require('../db');
const SAFE_COLUMNS = ['id','email','username','avatar_url','email_verified_at','created_at'];
// Precomputed Argon2id hash used only to equalise login timing for a non-existent
// user (argon2 has no synchronous hashing API, so this constant is hard-coded).
// Its parameters (m=47104,t=3,p=1) match ARGON2_OPTS in services/password.js;
// regenerate it if those change, or the timing-equalisation will be uneven.
const DUMMY_HASH = '$argon2id$v=19$m=47104,t=3,p=1$zPAe2EVN9+w9oEt/AGsBeQ$gGI2ugO5QP0v4Pr/W1fVZ1msNztWZ8dkgyOxPUuj6Os';
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    // Reject non-string or over-length passwords before any DB lookup or hashing.
    // No legitimate password exceeds 128 characters (registration caps it), so this
    // never rejects a real login; it is defence-in-depth against hashing-exhaustion
    // (feeding a huge string to Argon2) and against non-string input. Running it
    // before the user lookup keeps it independent of whether the account exists, so
    // it does not leak account existence and preserves the timing equalisation below.
    if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
      return done(null, false, { message: 'Invalid email or password' });
    }
    const user = await knex('users').where({ email }).first();
    if (!user) { await verifyPassword(DUMMY_HASH, password); return done(null, false, { message: 'Invalid email or password' }); }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) return done(null, false, { message: 'Invalid email or password' });
    return done(null, user);
  } catch (err) { return done(err); }
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { const user = await knex('users').select(SAFE_COLUMNS).where({ id }).first(); done(null, user || false); }
  catch (err) { done(err); }
});
module.exports = passport;