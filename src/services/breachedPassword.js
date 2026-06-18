const crypto = require('crypto');

// Instant local check for the most abused passwords (works offline).
const COMMON = new Set([
  'password', 'password1', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1',
  'letmein1', 'abc12345', 'football1', 'monkey12', 'password123',
]);

// NIST 800-63B requires screening passwords against breached/common lists.
// Primary source: Have I Been Pwned "Pwned Passwords" via k-anonymity —
// only the first 5 chars of the SHA-1 hash are sent, never the password.
// Set SKIP_HIBP=1 to use the local list only (offline/dev/tests).
async function isPasswordBreached(password) {
  if (COMMON.has(password.toLowerCase())) return true;
  if (process.env.SKIP_HIBP === '1') return false;

  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false; // fail open if HIBP is down

    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0].trim() === suffix);
  } catch {
    return false; // network/timeout -> fail open (local list already applied)
  }
}

module.exports = { isPasswordBreached };