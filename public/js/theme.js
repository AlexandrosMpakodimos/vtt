// public/js/theme.js — synchronous, dependency-free, blocks parsing BY DESIGN.
//
// Loaded from <head> with a plain <script src>, NO defer and NO async: it must
// set data-theme before the first paint, or a stored/system dark preference
// flashes light for one frame. Under this app's CSP (script-src 'self') the
// usual inline-script trick is unavailable, so the mechanism is one tiny
// same-origin request, cached after first load. Cost stated honestly in the
// spec; the alternative is a visible flash or a weakened policy.
//
// Resolution order — stored (valid) -> system preference -> light — is a
// contract the landing suite asserts. landing.js exports resolveTheme() as the
// testable statement of the same logic; theme.js cannot import, so this copy is
// inlined. IF YOU CHANGE ONE, CHANGE BOTH.
(function () {
  var stored = null;
  try { stored = window.localStorage.getItem('vtt.theme'); } catch (err) { /* private mode */ }
  var theme = (stored === 'light' || stored === 'dark') ? stored
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
}());
