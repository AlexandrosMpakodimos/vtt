// public/js/shared/authgate.js — the early session check for signed-in pages.
//
// Loaded from <head> with a plain <script src>, NO defer, on the dashboard and
// game pages, which start hidden (html.auth-pending, see tokens.css). It asks
// for the session straight away instead of waiting for the page scripts:
// those are deferred, and DOMContentLoaded also waits for the 3D dice module,
// so on a slow connection the page's own check could come seconds late. Until
// then the hidden page would reveal itself through the fallback, which is the
// layout flash a signed-out visitor saw.
//
//   401        -> straight to the log-in page, before anything is shown
//   200        -> show the page (the page scripts still do their own checks)
//   otherwise  -> leave it to the page scripts and the fallback
//
// The page scripts keep their own /api/auth/me call and remain the authority;
// this only decides what is shown first. Same-origin, no inline script, so the
// CSP (script-src 'self') is unchanged.
(function () {
  var root = document.documentElement;
  try {
    window.fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { window.location.replace('/'); return; }
        if (r.ok) root.classList.remove('auth-pending');
      })
      .catch(function () { /* network error: the page scripts and fallback decide */ });
  } catch (e) { /* no fetch: the page scripts and fallback decide */ }
}());
