// Pragmatic input validation + normalization. Format checks are hygiene, not
// security (parameterized queries are the injection defense); real email
// ownership is proven by the verification email.

// OWASP Validation Regex Repository's practical email pattern.
const EMAIL_RE = /^[a-zA-Z0-9_+&*-]+(?:\.[a-zA-Z0-9_+&*-]+)*@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
// Unicode-aware: letters (incl. Greek), digits, underscore — no spaces/emoji.
const USERNAME_RE = /^[\p{L}\p{N}_]{3,30}$/u;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

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
  if (!USERNAME_RE.test(u)) {
    return { error: 'username must be 3–30 characters: letters, numbers, or underscore' };
  }
  return { value: u };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { error: 'password is required' };
  }
  // NIST: length over complexity. 8 is the floor; no composition rules.
  if (password.length < 8) return { error: 'password must be at least 8 characters' };
  // bcrypt truncates at 72 BYTES — reject longer rather than silently truncate.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return { error: 'password is too long (max 72 bytes)' };
  }
  return { value: password };
}

module.exports = { normalizeEmail, validateEmail, validateUsername, validatePassword };