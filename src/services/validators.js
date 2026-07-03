const EMAIL_RE = /^[a-zA-Z0-9_+&*-]+(?:\.[a-zA-Z0-9_+&*-]+)*@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[\p{L}\p{N}_]{3,30}$/u;
function normalizeEmail(email) { return typeof email === 'string' ? email.trim().toLowerCase() : ''; }
function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return { error: 'email is required' };
  if (e.length > 254) return { error: 'email is too long' };
  if (!EMAIL_RE.test(e)) return { error: 'email format is invalid' };
  return { value: e };
}
function validateUsername(username) {
  const u = typeof username === 'string' ? username.trim() : '';
  if (!u) return { error: 'username is required' };
  if (!USERNAME_RE.test(u)) return { error: 'username must be 3-30 characters: letters, numbers, or underscore' };
  return { value: u };
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return { error: 'password is required' };
  if (password.length < 8) return { error: 'password must be at least 8 characters' };
  // Argon2id has no short input limit (unlike bcrypt's 72-byte truncation); this
  // generous cap only guards against pathologically long inputs (a DoS vector).
  if (password.length > 64) return { error: 'password is too long (max 64 characters)' }; //64 character limit per NIST's recommendation
  return { value: password };
}
module.exports = { normalizeEmail, validateEmail, validateUsername, validatePassword };