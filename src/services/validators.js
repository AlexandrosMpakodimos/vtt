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
function validateCampaignName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return { error: 'campaign name is required' };
  if (n.length > 100) return { error: 'campaign name is too long (max 100 characters)' };
  return { value: n };
}
function validateCampaignDescription(description) {
  if (description === undefined || description === null || description === '') return { value: null };
  if (typeof description !== 'string') return { error: 'description must be text' };
  const d = description.trim();
  // TEXT is unbounded in Postgres; this only rejects absurd payloads.
  if (d.length > 2000) return { error: 'description is too long (max 2000 characters)' };
  return { value: d || null };
}
// Same treatment as avatar_url in routes/auth.js: parse, restrict the scheme to
// http(s) (which excludes javascript: and data:), and store the NORMALISED href
// so HTML-significant characters are percent-encoded before they are ever stored.
function validateImageUrl(url, field = 'img_url') {
  if (url === undefined || url === null || url === '') return { value: null };
  let u = String(url).trim();
  if (!u) return { value: null };
  if (u.length > 2000) return { error: `${field} is too long (max 2000 characters)` };
  let parsed;
  try { parsed = new URL(u); } catch { return { error: `${field} must be a valid URL` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `${field} must use http:// or https://` };
  }
  return { value: parsed.href };
}
// A campaign password is a shared room secret, not a personal credential: it is
// told to a table of friends, so NIST's account-password guidance (breach
// screening, 8-char floor) does not transfer. The 128 cap bounds Argon2id work
// from a pathologically long input, matching the reasoning behind the 64-char
// account cap rather than its exact value.
function validateCampaignPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { error: 'a private campaign requires a password' };
  }
  if (password.length < 4) return { error: 'campaign password must be at least 4 characters' };
  if (password.length > 128) return { error: 'campaign password is too long (max 128 characters)' };
  return { value: password };
}
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function validateColor(color) {
  if (color === undefined || color === null || color === '') return { value: null };
  const c = String(color).trim();
  if (!HEX_COLOR_RE.test(c)) return { error: 'color must be a hex value like #A1B2C3' };
  return { value: c.toLowerCase() };
}
module.exports = {
  normalizeEmail, validateEmail, validateUsername, validatePassword,
  validateCampaignName, validateCampaignDescription, validateImageUrl,
  validateCampaignPassword, validateColor,
};