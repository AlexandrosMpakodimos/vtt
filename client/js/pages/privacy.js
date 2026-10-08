// client/js/pages/privacy.js — the privacy page's header: the shared theme
// toggle and the account buttons. Same session check as the landing
// (GET /api/auth/me): signed in shows "Your games", signed out (and any error)
// shows Sign up and Log in, which are plain links to /#signup and /#login.
//
// Classic script, no innerHTML, no inline script (CSP). Loaded with `defer`
// after common.js.

(function () {
  'use strict';

  var C = window.VTTCommon;

  function setHidden(id, hidden) {
    var el = C.$(id);
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function showAccount(signedIn) {
    setHidden('headerSignup', signedIn);
    setHidden('headerLogin', signedIn);
    setHidden('headerDash', !signedIn);
  }

  function init() {
    C.initTheme('themeToggle');
    C.api('GET', '/api/auth/me').then(function (r) {
      showAccount(!!(r.status === 200 && r.data && r.data.user));
    }).catch(function () { showAccount(false); });
  }

  window.VTTPrivacy = { showAccount: showAccount };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
