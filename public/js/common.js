// public/js/common.js — shared client helpers for the signed-in pages
// (landing + dashboard, page 3 later). Classic script, no framework, no build
// step, no dependency; exposes window.VTTCommon. Loaded with `defer` AFTER
// theme.js and BEFORE the page's own script.
//
// Constraints in force (CSP + house rules), identical to landing.js:
//   - No innerHTML / insertAdjacentHTML / document.write. Every dynamic string
//     reaches the DOM via textContent or an attribute setter.
//   - localStorage only through the try/catch wrapper.
//
// This file is the single home for the machinery the landing grew first and the
// dashboard reuses: theme resolution + toggle, the localStorage wrapper, the
// api() helper, the dialog open/close primitive (focus return + Esc stack), the
// navigation seam, and date formatting. landing.js now delegates here; if a
// helper's behaviour changes it changes for both pages at once, which is the
// point of extracting it.

(function () {
  'use strict';

  // ── Theme resolution ───────────────────────────────────────────────────────
  // Contract (asserted by the landing suite): only the exact strings
  // 'light'/'dark' count as a stored value; anything else falls through to the
  // system preference. theme.js inlines this SAME logic (it is the pre-paint
  // head script and cannot import). IF YOU CHANGE ONE, CHANGE BOTH — theme.js.
  function resolveTheme(stored, systemDark) {
    if (stored === 'light' || stored === 'dark') return stored;
    return systemDark ? 'dark' : 'light';
  }

  // ── House localStorage wrapper (dice3d.js:158 / combat.js:707 shape) ───────
  function localGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function localSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var THEME_KEY = 'vtt.theme';

  // ── House api() helper (combat.js:61 shape). Same-origin, JSON, {status,data},
  // parse guarded so a non-JSON/empty body can't throw. ───────────────────────
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

  // The only navigation seam, so jsdom can stub it.
  function navigate(url) {
    window.location.href = url;
  }

  // toLocaleDateString with a stable option set. undefined locale = the user's.
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ── Theme toggle + live system follow ──────────────────────────────────────
  // Moved verbatim from landing.js's initTheme. theme.js already set data-theme
  // before paint; we re-resolve so the toggle's label is correct and so we know
  // whether a value is stored. The toggle's aria-label states the ACTION.
  function currentSystemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyTheme(theme, toggleId) {
    document.documentElement.setAttribute('data-theme', theme);
    var toggle = $(toggleId);
    if (toggle) {
      toggle.setAttribute('aria-label',
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  function initTheme(toggleId) {
    toggleId = toggleId || 'themeToggle';
    var stored = localGet(THEME_KEY);
    applyTheme(resolveTheme(stored, currentSystemDark()), toggleId);

    var toggle = $(toggleId);
    if (toggle) {
      toggle.addEventListener('click', function () {
        var now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        var next = now === 'dark' ? 'light' : 'dark';
        applyTheme(next, toggleId);
        localSet(THEME_KEY, next);   // first click stores; stored wins from now on
      });
    }

    // While nothing is stored, follow live OS changes. Once a value is stored,
    // the stored value wins and this listener does nothing.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (e) {
        if (localGet(THEME_KEY) === null) applyTheme(e.matches ? 'dark' : 'light', toggleId);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);   // older engines
    }
  }

  // ── Dialog primitive ───────────────────────────────────────────────────────
  // openCard/closeCard from landing.js, generalised: the dialog is a PARAMETER
  // instead of the #authCard closure, so any page's dialogs reuse it. Records
  // the invoker per dialog (on the element itself, so nested dialogs each keep
  // their own), focuses a requested element/id or the first sensible field,
  // wires the close button ([data-close]), backdrop click, and `cancel` (Esc).
  //
  // The `cancel` handler defers to the image picker: if window.VTTImagePicker
  // exists and reports isOpen(), the Esc keypress is for the picker (a fixed
  // overlay mounted inside this dialog), so we swallow the cancel and let the
  // picker's own handler close it. This is the buckle described in the spec's
  // Escape-stack section; the picker also preventDefault()s on its side.
  function firstFocusable(dialog, focus) {
    if (focus) {
      var byEl = (focus && focus.nodeType === 1) ? focus : $(focus);
      if (byEl && typeof byEl.focus === 'function') return byEl;
    }
    var auto = dialog.querySelector('[autofocus]');
    if (auto) return auto;
    var field = dialog.querySelector('input, select, textarea, button');
    if (field) return field;
    var heading = dialog.querySelector('h1, h2, h3');
    return heading || null;
  }

  function openDialog(dialog, opts) {
    if (!dialog) return;
    opts = opts || {};
    dialog._vttInvoker = opts.invoker || null;

    // Guarded for jsdom, which has no showModal. A stub MUST record the call.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    // Wire close affordances exactly once per dialog.
    if (!dialog._vttWired) {
      dialog._vttWired = true;
      var closeBtn = dialog.querySelector('[data-close]');
      if (closeBtn) closeBtn.addEventListener('click', function () { closeDialog(dialog); });
      dialog.addEventListener('cancel', function (e) {
        // Esc: if the picker is up, this Esc is for it — swallow and stop.
        if (window.VTTImagePicker && typeof window.VTTImagePicker.isOpen === 'function'
            && window.VTTImagePicker.isOpen()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        closeDialog(dialog);
      });
      dialog.addEventListener('click', function (e) {
        if (e.target === dialog) closeDialog(dialog);   // backdrop is the dialog element itself
      });
    }

    var target = firstFocusable(dialog, opts.focus);
    if (target && typeof target.focus === 'function') target.focus();
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    var invoker = dialog._vttInvoker;
    dialog._vttInvoker = null;
    if (invoker && typeof invoker.focus === 'function') invoker.focus();
  }

  // ── Animate a container's height change (universal, all browsers) ──────────
  // height:auto can't be transitioned directly, so FLIP it: measure, mutate,
  // measure, then transition from the old pixel height to the new one and clear
  // back to auto on completion. Reduced-motion (or no layout, e.g. jsdom) applies
  // the change instantly. Reusable anywhere a reveal/collapse changes size:
  //   VTTCommon.animateResize(container, function () { field.hidden = false; });
  var REDUCE_MOTION = false;
  try { REDUCE_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function animateResize(el, mutate, opts) {
    opts = opts || {};
    var duration = typeof opts.duration === 'number' ? opts.duration : 260;
    var easing = opts.easing || 'cubic-bezier(0.22, 1, 0.36, 1)';

    if (!el || typeof mutate !== 'function') { if (mutate) mutate(); return; }

    // No animation path: reduced-motion, or an environment without real layout.
    var start = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
    if (REDUCE_MOTION || !start) { mutate(); return; }

    // If a previous resize is still running on this element, settle it first so
    // we measure from a stable base and don't stack transitions.
    if (el._vttResizeCleanup) el._vttResizeCleanup();

    mutate();                                   // apply the DOM change (jumps to new auto height)
    var end = el.getBoundingClientRect().height;
    if (end === start) return;                  // nothing actually changed size

    // Invert to the old height, then play to the new one.
    el.style.overflow = 'hidden';
    el.style.height = start + 'px';
    // force reflow so the browser registers the start height before transitioning
    void el.offsetHeight;
    el.style.transition = 'height ' + duration + 'ms ' + easing;
    el.style.height = end + 'px';

    var done = false;
    function cleanup() {
      if (done) return; done = true;
      el.removeEventListener('transitionend', onEnd);
      el.style.transition = '';
      el.style.height = '';
      el.style.overflow = '';
      el._vttResizeCleanup = null;
    }
    function onEnd(e) { if (e.target === el && e.propertyName === 'height') cleanup(); }
    el.addEventListener('transitionend', onEnd);
    el._vttResizeCleanup = cleanup;
    // Fallback in case transitionend doesn't fire (e.g. height ended up equal).
    window.setTimeout(cleanup, duration + 60);
  }

  window.VTTCommon = {
    resolveTheme: resolveTheme,
    localGet: localGet,
    localSet: localSet,
    api: api,
    NETWORK_ERROR: NETWORK_ERROR,
    $: $,
    navigate: navigate,
    fmtDate: fmtDate,
    initTheme: initTheme,
    openDialog: openDialog,
    closeDialog: closeDialog,
    animateResize: animateResize,
  };
}());
