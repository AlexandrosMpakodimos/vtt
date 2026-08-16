// public/js/landing.js — the landing page's behaviour: theme toggle + live
// system-follow, URL-param handling (reset links land here), session check,
// the auth-card state machine (spec §4), and pointer parallax (spec §7).
//
// Constraints in force (CSP + house rules):
//   - No innerHTML / insertAdjacentHTML / document.write. Every dynamic string
//     reaches the DOM via textContent or an attribute setter.
//   - Classic script, no framework, no build step, no dependency.
//   - localStorage only through the try/catch wrapper (copied from the house
//     pattern at dice3d.js / combat.js).

(function () {
  'use strict';

  // ── Pure seams the suite drives directly ──────────────────────────────────
  // Exposed at the top so the ui suite can call them without touching the DOM.

  // Theme resolution contract: only the exact strings 'light'/'dark' count as a
  // stored value; anything else falls through to the system preference. theme.js
  // inlines this same logic (it cannot import) — IF YOU CHANGE ONE, CHANGE BOTH.
  function resolveTheme(stored, systemDark) {
    if (stored === 'light' || stored === 'dark') return stored;
    return systemDark ? 'dark' : 'light';
  }

  // Depth is read off a data-attribute (untrusted string). Clamp to [0,1];
  // anything non-finite → 0. The array-coercion trap is real for BOTH Number()
  // and parseFloat(): parseFloat([[2]]) stringifies to "2" and returns 2, so a
  // bare parseFloat would wrongly yield 1 here. Guard the type first — only a
  // real number or a numeric string is allowed through; arrays/objects → 0.
  function clampDepth(v) {
    if (typeof v !== 'number' && typeof v !== 'string') return 0;
    var n = parseFloat(v);
    if (!isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  // The only place this file navigates, so jsdom can stub it.
  function navigate(url) {
    window.location.href = url;
  }

  window.VTTLanding = { resolveTheme: resolveTheme, clampDepth: clampDepth, navigate: navigate };

  // ── House localStorage wrapper (dice3d.js:158 / combat.js:707 shape) ───────
  function localGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function localSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var THEME_KEY = 'vtt.theme';

  // ── House api() helper (combat.js:61 shape, minus the closed-notice hook, ──
  // which is a game-surface concern this page doesn't load). Same-origin, JSON,
  // {status, data}, parse guarded so a non-JSON/empty body can't throw.
  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, data: data };
  }

  var NETWORK_ERROR = 'Network error — check your connection and try again.';

  function $(id) { return document.getElementById(id); }

  // Run once the DOM is parsed. landing.js is loaded with `defer`, so the DOM is
  // ready; guard anyway for direct eval in the suite.
  function init() {
    initTheme();
    var resetState = readUrlParams();   // must run before the session check renders
    initAuthCard(resetState);
    initSessionCheck();
    initParallax();
  }

  // ── 1. Theme toggle + live system follow (spec §8.3) ───────────────────────
  function currentSystemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var toggle = $('themeToggle');
    if (toggle) {
      // Label states the ACTION, not the current state.
      toggle.setAttribute('aria-label',
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  function initTheme() {
    // theme.js already set data-theme before paint; re-resolve so the toggle's
    // label is correct and so we know whether a value is stored.
    var stored = localGet(THEME_KEY);
    applyTheme(resolveTheme(stored, currentSystemDark()));

    var toggle = $('themeToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        var next = now === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        localSet(THEME_KEY, next);   // first click stores; stored wins from now on
      });
    }

    // While nothing is stored, follow live OS changes. Once a value is stored,
    // the stored value wins and this listener does nothing.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (e) {
        if (localGet(THEME_KEY) === null) applyTheme(e.matches ? 'dark' : 'light');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);   // older engines
    }
  }

  // ── 2. URL params (spec §5) ────────────────────────────────────────────────
  // Returns {open:false} or {open:true, token, error} for initAuthCard to act on.
  function readUrlParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return { open: false }; }

    var out = { open: false };

    if (params.has('reset')) {
      out = { open: true, token: params.get('reset'), error: false };
    } else if (params.get('reset_error') === '1') {
      out = { open: true, token: null, error: true };
    }

    if (out.open) {
      // Strip the token (and the error flag) from the address bar and history.
      try { window.history.replaceState(null, '', '/'); } catch (e) { /* no-op */ }
    }
    return out;
  }

  // ── 4. Auth card ───────────────────────────────────────────────────────────
  var FACES = ['formSignup', 'formLogin', 'formForgot', 'formReset'];
  var HEADINGS = {
    formSignup: 'suHeading', formLogin: 'liHeading',
    formForgot: 'fpHeading', formReset: 'rpHeading',
  };
  var FIRST_FIELD = {
    formSignup: 'suEmail', formLogin: 'liEmail',
    formForgot: 'fpEmail', formReset: 'rpPassword',
  };

  var cardInvoker = null;     // element focus returns to on close
  var resetToken = null;      // stashed from ?reset=, never in the DOM

  function showFace(faceId) {
    for (var i = 0; i < FACES.length; i++) {
      var f = $(FACES[i]);
      if (!f) continue;
      if (FACES[i] === faceId) f.removeAttribute('hidden');
      else f.setAttribute('hidden', '');
    }
    var card = $('authCard');
    var headingId = HEADINGS[faceId];
    if (card && headingId) card.setAttribute('aria-labelledby', headingId);
  }

  function focusFirstField(faceId) {
    var el = $(FIRST_FIELD[faceId]);
    if (el && typeof el.focus === 'function') el.focus();
  }

  function openCard(faceId, invoker) {
    cardInvoker = invoker || null;
    showFace(faceId);
    var card = $('authCard');
    if (!card) return;
    // Guarded for jsdom, which has no showModal. The suite's stub must RECORD
    // the call; a no-op that records nothing is the setPointerCapture mistake.
    if (typeof card.showModal === 'function') card.showModal();
    else card.setAttribute('open', '');
    focusFirstField(faceId);
  }

  function closeCard() {
    var card = $('authCard');
    if (card) {
      if (typeof card.close === 'function' && card.open) card.close();
      else card.removeAttribute('open');
    }
    if (cardInvoker && typeof cardInvoker.focus === 'function') cardInvoker.focus();
    cardInvoker = null;
  }

  function switchFace(faceId) {
    showFace(faceId);
    focusFirstField(faceId);
  }

  function setStatus(id, msg) {
    var el = $(id);
    if (el) el.textContent = msg;   // server strings rendered verbatim, never as HTML
  }

  function reveal(id) { var el = $(id); if (el) el.removeAttribute('hidden'); }
  function hide(id) { var el = $(id); if (el) el.setAttribute('hidden', ''); }

  // Disable a submit while a request is in flight; restore its label after.
  function withPending(btn, run) {
    var label = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    return run().finally(function () {
      if (btn) { btn.disabled = false; if (label !== null) btn.textContent = label; }
    });
  }

  // A resend button disables itself for 30 s after use.
  function coolDown(btn) {
    if (!btn) return;
    btn.disabled = true;
    window.setTimeout(function () { btn.disabled = false; }, 30000);
  }

  function initAuthCard(resetState) {
    var card = $('authCard');

    // Openers.
    bindOpen('headerLogin', 'formLogin');
    bindOpen('ctaLogin', 'formLogin');
    bindOpen('ctaSignup', 'formSignup');

    // Close paths: the close button, a backdrop click, and the dialog's own
    // close/cancel events. Each funnels through closeCard so focus returns once.
    var closeBtn = $('authClose');
    if (closeBtn) closeBtn.addEventListener('click', function () { closeCard(); });
    if (card) {
      card.addEventListener('cancel', function (e) { e.preventDefault(); closeCard(); });
      card.addEventListener('close', function () {
        // Native close (Esc) fires this; return focus without re-calling close().
        if (cardInvoker && typeof cardInvoker.focus === 'function') cardInvoker.focus();
        cardInvoker = null;
      });
      card.addEventListener('click', function (e) {
        if (e.target === card) closeCard();   // backdrop is the dialog element itself
      });
    }

    // Footer face-switch links (class .switch-face, data-face target).
    var switches = document.querySelectorAll('.switch-face');
    for (var i = 0; i < switches.length; i++) {
      (function (el) {
        el.addEventListener('click', function () {
          var target = el.getAttribute('data-face');
          if (target) switchFace(target);
        });
      })(switches[i]);
    }

    // Password show/hide toggles (class .pw-toggle, aria-controls target).
    var toggles = document.querySelectorAll('.pw-toggle');
    for (var j = 0; j < toggles.length; j++) {
      (function (el) {
        el.addEventListener('click', function () {
          var targetId = el.getAttribute('aria-controls');
          var input = targetId ? $(targetId) : null;
          if (!input) return;
          var show = input.getAttribute('type') === 'password';
          input.setAttribute('type', show ? 'text' : 'password');
          el.setAttribute('aria-pressed', show ? 'true' : 'false');
        });
      })(toggles[j]);
    }

    bindForms();

    // Reset link landed us here (spec §5): open on the reset face last, after
    // wiring, so the form handlers are live.
    if (resetState && resetState.open) {
      resetToken = resetState.token;   // may be null on the error path
      openCard('formReset', null);
      if (resetState.error) {
        setStatus('rpStatus', 'That reset link is invalid or has expired.');
        reveal('rpForgotSwitch');
      }
    }
  }

  function bindOpen(btnId, faceId) {
    var btn = $(btnId);
    if (btn) btn.addEventListener('click', function () { openCard(faceId, btn); });
  }

  // ── 5. Face handlers (spec §4) ─────────────────────────────────────────────
  function bindForms() {
    bindSignup();
    bindLogin();
    bindForgot();
    bindReset();
    bindResend('suResend', 'suStatus');
    bindResend('liResend', 'liStatus');
  }

  function onSubmit(formId, handler) {
    var form = $(formId);
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      handler();
    });
  }

  function bindSignup() {
    onSubmit('formSignup', function () {
      var btn = $('suSubmit');
      withPending(btn, function () {
        return api('POST', '/api/auth/register', {
          email: valueOf('suEmail'),
          username: valueOf('suUsername'),
          password: valueOf('suPassword'),
        }).then(function (r) {
          if (r.status === 201) {
            setStatus('suStatus', r.data.message || 'Account created.');
            clearFields(['suEmail', 'suUsername', 'suPassword']);
            reveal('suResend');
          } else {
            setStatus('suStatus', serverError(r));
          }
        }).catch(function () { setStatus('suStatus', NETWORK_ERROR); });
      });
    });
  }

  function bindLogin() {
    onSubmit('formLogin', function () {
      var btn = $('liSubmit');
      hide('liResend');
      withPending(btn, function () {
        return api('POST', '/api/auth/login', {
          email: valueOf('liEmail'),
          password: valueOf('liPassword'),
        }).then(function (r) {
          if (r.status === 200) {
            window.VTTLanding.navigate('/dashboard.html');
          } else if (r.status === 403 && r.data && r.data.email_verified === false) {
            setStatus('liStatus', serverError(r));
            reveal('liResend');
          } else {
            setStatus('liStatus', serverError(r));
          }
        }).catch(function () { setStatus('liStatus', NETWORK_ERROR); });
      });
    });
  }

  function bindForgot() {
    onSubmit('formForgot', function () {
      var btn = $('fpSubmit');
      withPending(btn, function () {
        return api('POST', '/api/auth/forgot-password', {
          email: valueOf('fpEmail'),
        }).then(function (r) {
          // Uniform response by design — no enumeration, whatever the status.
          setStatus('fpStatus', (r.data && r.data.message) || serverError(r));
        }).catch(function () { setStatus('fpStatus', NETWORK_ERROR); });
      });
    });
  }

  function bindReset() {
    onSubmit('formReset', function () {
      var btn = $('rpSubmit');
      withPending(btn, function () {
        return api('POST', '/api/auth/reset-password', {
          token: resetToken,
          password: valueOf('rpPassword'),
        }).then(function (r) {
          if (r.status === 200) {
            setStatus('rpStatus', (r.data && r.data.message) || 'Password reset.');
            reveal('rpLoginSwitch');
          } else {
            setStatus('rpStatus', serverError(r));
            // Expired/invalid token → offer a fresh link.
            reveal('rpForgotSwitch');
          }
        }).catch(function () { setStatus('rpStatus', NETWORK_ERROR); });
      });
    });
  }

  function bindResend(btnId, statusId) {
    var btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      // Resend uses the email already typed on the relevant face.
      var email = btnId === 'suResend' ? valueOf('suEmail') : valueOf('liEmail');
      coolDown(btn);
      api('POST', '/api/auth/resend-verification', { email: email }).then(function (r) {
        setStatus(statusId, (r.data && r.data.message) || serverError(r));
      }).catch(function () { setStatus(statusId, NETWORK_ERROR); });
    });
  }

  function valueOf(id) { var el = $(id); return el ? el.value : ''; }
  function clearFields(ids) { for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el) el.value = ''; } }
  function serverError(r) {
    if (r && r.data && typeof r.data.error === 'string') return r.data.error;
    return NETWORK_ERROR;
  }

  // ── 3. Session check (spec §4) ─────────────────────────────────────────────
  function initSessionCheck() {
    api('GET', '/api/auth/me').then(function (r) {
      if (r.status === 200 && r.data && r.data.user) signedIn(r.data.user);
      else signedOut();
    }).catch(function () { signedOut(); });
  }

  function signedIn(user) {
    swap('headerLogin', 'headerDash');
    // CTA row: show Continue + Logout, hide signup/login.
    hide('ctaSignup'); hide('ctaLogin');
    reveal('ctaContinue'); reveal('ctaLogout');
    var cont = $('ctaContinue');
    if (cont) cont.textContent = 'Continue as ' + (user.username || 'you');
    var logout = $('ctaLogout');
    if (logout && !logout.dataset.bound) {
      logout.dataset.bound = '1';
      logout.addEventListener('click', function () {
        api('POST', '/api/auth/logout').then(function () { signedOut(); }).catch(function () { signedOut(); });
      });
    }
  }

  function signedOut() {
    swap('headerDash', 'headerLogin');
    reveal('ctaSignup'); reveal('ctaLogin');
    hide('ctaContinue'); hide('ctaLogout');
    var su = $('ctaSignup');
    if (su && typeof su.focus === 'function' && document.activeElement === $('ctaLogout')) su.focus();
  }

  // Show one element, hide the other (header auth control is exactly one).
  function swap(hideId, showId) { hide(hideId); reveal(showId); }

  // ── 6. Parallax (spec §7) ──────────────────────────────────────────────────
  var K = 28;   // px; front layer (depth 0.6) moves at most ±16.8 px

  function initParallax() {
    window.VTTLanding.parallaxActive = false;

    // Three gates, in order — if any hits, attach nothing (static hero).
    if (!window.matchMedia) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(hover: none)').matches) return;

    var hero = $('heroLayers');
    if (!hero) return;
    var layers = hero.querySelectorAll('.layer');
    if (!layers.length) return;

    var nx = 0, ny = 0, scheduled = false;

    function apply() {
      scheduled = false;
      for (var i = 0; i < layers.length; i++) {
        var d = clampDepth(layers[i].getAttribute('data-depth'));
        var tx = (-nx * d * K).toFixed(2);
        var ty = (-ny * d * K).toFixed(2);
        layers[i].style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
      }
    }

    hero.addEventListener('pointermove', function (e) {
      var rect = hero.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      nx = rect.width ? (e.clientX - cx) / (rect.width / 2) : 0;
      ny = rect.height ? (e.clientY - cy) / (rect.height / 2) : 0;
      if (nx < -1) nx = -1; else if (nx > 1) nx = 1;
      if (ny < -1) ny = -1; else if (ny > 1) ny = 1;
      if (!scheduled) { scheduled = true; window.requestAnimationFrame(apply); }
    });

    hero.addEventListener('pointerleave', function () {
      nx = 0; ny = 0;
      if (!scheduled) { scheduled = true; window.requestAnimationFrame(apply); }
    });

    window.VTTLanding.parallaxActive = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
