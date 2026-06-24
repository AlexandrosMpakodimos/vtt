// Defense-in-depth CSRF protection via Origin/Referer verification.
//
// The PRIMARY CSRF defense is the session cookie's sameSite='lax' attribute,
// which stops the browser from attaching the cookie to cross-site POST/PATCH/etc.
// This middleware adds an independent second layer: on any state-changing request,
// if the browser sent an Origin (or Referer) header, it must match one of our own
// origins. A forged cross-site request carries the attacker's origin and is rejected.
//
// A missing Origin/Referer (e.g. a non-browser client like curl or a server-to-server
// call) is allowed through — browsers always send Origin on cross-origin writes, so
// the browser-based CSRF vector is covered, while legitimate API clients still work.

function allowedOrigins() {
  const set = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
  if (process.env.BASE_URL) {
    try {
      set.add(new URL(process.env.BASE_URL).origin);
    } catch {
      /* ignore a malformed BASE_URL */
    }
  }
  if (process.env.EXTRA_ALLOWED_ORIGINS) {
    for (const o of process.env.EXTRA_ALLOWED_ORIGINS.split(',')) {
      const trimmed = o.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function verifyOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next(); // reads are not state-changing
  const origin = requestOrigin(req);
  if (!origin) return next(); // non-browser client; sameSite still protects browsers
  if (allowedOrigins().has(origin)) return next();
  return res.status(403).json({ error: 'cross-origin request blocked' });
}

module.exports = { verifyOrigin };