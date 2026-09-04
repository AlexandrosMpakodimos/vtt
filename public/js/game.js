// public/js/game.js — the game table shell (page 3 of 3).
//
// The four harness scripts (scene.js / combat.js / actors.js / align.js) are
// SEAMED, not rewritten: each exposes boot() (+ scene's pingAt) and its render
// paths run untouched. game.js is only the shell — layout wiring, boot order,
// tabs, the rail, modals, the Escape stack, connection state and the debug
// drawer. It owns no game logic and adds no gameplay endpoint or socket event.
//
// Constraints (CSP + house rules), identical to landing.js/dashboard.js:
//   - No innerHTML / insertAdjacentHTML / document.write. Text reaches the DOM
//     via textContent only; there is no dynamic markup here to build.
//   - Classic script, no framework, no build step. Shared helpers come from
//     window.VTTCommon; dialogs open through VTTCommon.openDialog.

(function () {
  'use strict';

  var C = window.VTTCommon;
  var $ = C.$;
  var api = C.api;

  // ── Small helpers (no innerHTML) ───────────────────────────────────────────
  function on(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
  function show(el) { if (el) el.removeAttribute('hidden'); }
  function hide(el) { if (el) el.setAttribute('hidden', ''); }
  function setText(id, s) { var el = $(id); if (el) el.textContent = s == null ? '' : String(s); }
  function isDialogOpen(d) { return !!(d && d.open); }

  // ── State ──────────────────────────────────────────────────────────────────
  var campaignId = null;
  var me = null;
  var isGm = false;
  var activeSceneObj = null;   // the scene align injects; kept current by scene events
  var actorsBooted = false;    // VTTActors.boot is deferred to first Chars/Library open
  var wasConnected = false;    // so we only "catch up" after a real drop, not first connect

  // ── Boot (spec §3) ─────────────────────────────────────────────────────────
  // URL campaign → /me → campaign (gate or proceed) → scene.boot → combat.boot →
  // defer actors.boot to first Chars/Library open → align on demand.
  function boot() {
    campaignId = readCampaignParam();
    if (!campaignId) { C.navigate('/dashboard.html'); return; }

    api('GET', '/api/auth/me').then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.user) { C.navigate('/'); return; }
      me = r.data.user;
      return api('GET', '/api/campaigns/' + campaignId).then(function (cr) {
        if (cr.status === 404 || cr.status === 403) { openGate(cr); return; }
        if (cr.status !== 200 || !cr.data || !cr.data.campaign) { openGate(cr); return; }
        var camp = cr.data.campaign;
        isGm = camp.is_gm === true;
        document.body.classList.toggle('is-gm', isGm);
        setText('campName', camp.name || 'Campaign');
        setText('whoami', me.username ? ('as ' + me.username) : '');

        initChrome();

        // Canvas first: scenes list → active scene, tokens, fog, room join.
        if (window.VTTScene && window.VTTScene.boot) window.VTTScene.boot(campaignId);
        // The strip and chat are ambient: encounter state + chat backlog + dice.
        if (window.VTTCombat && window.VTTCombat.boot) window.VTTCombat.boot(campaignId);
        // Characters/Library (the heavy half) waits for the first open.

        markThemeReady();
      });
    }).catch(function () { C.navigate('/'); });
  }

  function readCampaignParam() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return null; }
    var id = params.get('campaign');
    // A syntactically plausible id is all the shell checks; the server decides
    // membership. An empty/absent value sends the person back to the dashboard.
    return id && id.trim() ? id.trim() : null;
  }

  function markThemeReady() {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        document.documentElement.classList.add('theme-ready');
      });
    });
  }

  // ── The gate screen (spec §3): 403/404 → a plain full-screen state ─────────
  function openGate(res) {
    var gate = $('gameGate');
    var msg = $('gameGateMsg');
    if (msg) {
      var closed = res && res.status === 403;
      msg.textContent = closed
        ? 'This table is closed right now. The GM can reopen it.'
        : "This campaign isn't open to you, or it doesn't exist.";
    }
    if (gate) gate.classList.add('show');
  }

  // ── Chrome wiring (only after we know we're allowed in) ────────────────────
  function initChrome() {
    C.initTheme('themeToggle');
    initTabs();
    initSidebar();
    initRail();
    initModals();
    initDrawer();
    initEscapeStack();
    initConnectionState();
  }

  // ── Tabs (spec §2): the dashboard's APG tablist, now in common.js ──────────
  function initTabs() {
    C.initTabs('sideTabs', onTab);
  }
  function onTab(tabId) {
    // Characters and Library share the deferred heavy boot (spec §3).
    if (tabId === 'tabChars' || tabId === 'tabLibrary') ensureActors();
  }
  function ensureActors() {
    if (actorsBooted) return;
    actorsBooted = true;
    if (window.VTTActors && window.VTTActors.boot) window.VTTActors.boot(campaignId);
  }

  // ── Sidebar collapse (spec §2) ─────────────────────────────────────────────
  function initSidebar() {
    on('sidebarToggle', 'click', function () {
      var collapsed = document.body.classList.toggle('sidebar-collapsed');
      var btn = $('sidebarToggle');
      if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }

  // ── Left rail (spec §2) ────────────────────────────────────────────────────
  function initRail() {
    // Popover toggles (place-token, fog). A popover hides the irrelevant, never
    // the forbidden; the fog popover is GM-only in markup.
    railPopover('railToken', 'tokenPop');
    railPopover('railFog', 'fog-panel');
    enhanceTokenPop();
    enhanceFogPanel();

    // Modal openers.
    on('railAlign', 'click', openAlign);
    on('railScenes', 'click', openScenes);
    on('railEncounter', 'click', openEncounter);
  }

  // Small UX polish for the Place-a-token popover (no placement logic — scene.js
  // owns that): keep an inheritance note in sync with the character choice, and
  // reflect the count on the Place button so the action is unambiguous.
  function enhanceTokenPop() {
    var actor = $('tok-actor');
    var note = $('tok-inherit-note');
    var count = $('tok-count');
    var place = $('place-token');
    var hint = $('tokPlaceHint');

    function refresh() {
      var hasChar = actor && actor.value;
      if (note) {
        note.textContent = hasChar
          ? 'Inherits its picture and size from the character — fill a field below only to override.'
          : 'A plain token uses just the name and image you give below.';
      }
      if (hint) {
        hint.textContent = hasChar ? 'Placing for the selected character.' : 'Pick a character, or just name one.';
      }
      if (place) {
        var n = count ? parseInt(count.value, 10) : 1;
        if (!isFinite(n) || n < 1) n = 1;
        place.textContent = n > 1 ? ('Place ' + n) : 'Place';
      }
    }

    if (actor) actor.addEventListener('change', refresh);
    if (count) { count.addEventListener('input', refresh); count.addEventListener('change', refresh); }
    // Re-sync each time the popover is opened (the character list is populated
    // asynchronously by scene.js, and the selection may have changed).
    if (actor) {
      var railBtn = $('railToken');
      if (railBtn) railBtn.addEventListener('click', function () { window.setTimeout(refresh, 0); });
    }
    refresh();
  }

  // Fog-of-war popover: drive scene.js's hidden inputs from the icon UI, and
  // turn fog mode on/off in step with the panel being open. scene.js still owns
  // all the drawing/selection logic; this is only the control surface.
  function fireChange(el) {
    if (!el) return;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function enhanceFogPanel() {
    var panel = $('fog-panel');
    if (!panel) return;
    var modeInput = $('fog-mode');     // hidden checkbox scene.js reads
    var toolSel = $('fog-tool');       // hidden select: cover | reveal
    var shapeSel = $('fog-shape');     // hidden select: rect | circle | poly

    // Segmented buttons -> hidden <select> value + change event (scene.js listens).
    function wireSeg(attr, sel) {
      var btns = panel.querySelectorAll('[' + attr + ']');
      Array.prototype.forEach.call(btns, function (b) {
        b.addEventListener('click', function () {
          var val = b.getAttribute(attr);
          if (sel && sel.value !== val) { sel.value = val; fireChange(sel); }
          syncSeg(attr, sel);
        });
      });
    }
    // Reflect the hidden <select>'s current value onto the buttons' pressed state
    // (also called when scene.js changes it, e.g. the T key path).
    function syncSeg(attr, sel) {
      var btns = panel.querySelectorAll('[' + attr + ']');
      Array.prototype.forEach.call(btns, function (b) {
        b.setAttribute('aria-pressed', sel && b.getAttribute(attr) === sel.value ? 'true' : 'false');
      });
    }

    wireSeg('data-fog-tool', toolSel);
    wireSeg('data-fog-shape', shapeSel);
    if (toolSel) toolSel.addEventListener('change', function () { syncSeg('data-fog-tool', toolSel); });
    if (shapeSel) shapeSel.addEventListener('change', function () { syncSeg('data-fog-shape', shapeSel); });
    syncSeg('data-fog-tool', toolSel);
    syncSeg('data-fog-shape', shapeSel);

    // Fog mode follows the panel's visibility, AND the panel follows fog mode —
    // so the rail button and the F key (which scene.js handles by toggling the
    // hidden checkbox) stay in agreement. Both directions act only on a real
    // mismatch, so they settle without looping.
    function openPanel() {
      if (panel.hasAttribute('hidden')) {
        // Route through the rail button so the shell's single-open-popover
        // bookkeeping (aria, closing others) stays correct.
        var rb = $('railFog');
        if (rb) rb.click(); else show(panel);
      }
    }
    function closePanel() {
      if (!panel.hasAttribute('hidden')) {
        var rb = $('railFog');
        if (rb) rb.click(); else hide(panel);
      }
    }
    function applyMode() {
      var open = !panel.hasAttribute('hidden');
      if (modeInput && modeInput.checked !== open) {
        modeInput.checked = open;
        fireChange(modeInput);
      }
      if (open) { syncSeg('data-fog-tool', toolSel); syncSeg('data-fog-shape', shapeSel); }
    }
    function applyPanel() {
      // scene.js's F key toggled fog mode -> match the panel to it.
      if (!modeInput) return;
      if (modeInput.checked) openPanel(); else closePanel();
    }
    try {
      var mo = new window.MutationObserver(applyMode);
      mo.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    } catch (e) { /* MutationObserver unavailable — fall back to click below */ }
    if (modeInput) modeInput.addEventListener('change', applyPanel);
    var railBtn = $('railFog');
    if (railBtn) railBtn.addEventListener('click', function () { window.setTimeout(applyMode, 0); });
    applyMode();
  }

  // focus returning to the button on close. Only one such popover open at a time.
  var openPop = null;   // { btn, pop }
  function railPopover(btnId, popId) {
    on(btnId, 'click', function () {
      var pop = $(popId);
      if (!pop) return;
      if (openPop && openPop.pop === pop) { closePop(); return; }
      closePop();
      show(pop);
      var btn = $(btnId);
      if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-pressed', 'true'); }
      openPop = { btn: btn, pop: pop };
    });
  }
  function closePop() {
    if (!openPop) return;
    hide(openPop.pop);
    if (openPop.btn) {
      openPop.btn.setAttribute('aria-expanded', 'false');
      openPop.btn.setAttribute('aria-pressed', 'false');
      if (typeof openPop.btn.focus === 'function') openPop.btn.focus();
    }
    openPop = null;
  }

  // ── Modals (spec §2): native <dialog> via VTTCommon.openDialog ─────────────
  function initModals() {
    // The Sheet and Item dialogs are opened by actors.js/sheet.js when a row is
    // clicked; game.js owns the GM-only Scenes, Align and Encounter modals.
    // (openDialog wires close/backdrop/Esc once each.)
    on('btnEncounter', 'click', openEncounter);
    on('canvasEmptyCreate', 'click', function () {
      openScenes();
      // Focus the new-scene field so the GM can type a name straight away.
      window.setTimeout(function () { var f = $('new-scene-name'); if (f) f.focus(); }, 60);
    });
    initConfirm();
  }

  // Reusable confirm dialog — the same #confirmDialog component the dashboard
  // uses. VTTGame.confirm(title, body, danger, cb) shows it; cb runs only if the
  // person confirms. Wired once here; scene.js (delete a scene) calls it.
  var confirmCb = null;
  function initConfirm() {
    on('cfCancel', 'click', function () {
      C.closeDialog($('confirmDialog')); confirmCb = null;
    });
    on('cfOk', 'click', function () {
      var cb = confirmCb; confirmCb = null;
      C.closeDialog($('confirmDialog'));
      if (typeof cb === 'function') cb();
    });
  }
  function confirmThen(title, body, danger, cb) {
    var d = $('confirmDialog');
    if (!d) { if (window.confirm(title + '\n\n' + (body || '')) && cb) cb(); return; }
    setText('cfTitle', title);
    setText('cfBody', body || '');
    var ok = $('cfOk');
    if (ok) { ok.classList.remove('danger', 'primary'); ok.classList.add(danger ? 'danger' : 'primary'); ok.textContent = 'OK'; }
    confirmCb = cb;
    C.openDialog(d, { invoker: document.activeElement, focus: $('cfCancel') });
  }

  function openScenes() {
    var d = $('scenesDialog');
    if (d) C.openDialog(d, { invoker: $('railScenes') });
  }

  function openAlign() {
    var d = $('alignDialog');
    if (!d) return;
    // Align resolves the current scene itself from the campaign (its boot fetches
    // the campaign + scenes and selects the active one). We just open it.
    if (window.VTTAlign && window.VTTAlign.boot) window.VTTAlign.boot(campaignId, null);
    C.openDialog(d, { invoker: $('railAlign') });
  }

  // The Encounter button toggles the encounter on the active scene: start it
  // (strip appears) or end it (strip hides). combat.js does the work.
  function openEncounter() {
    if (window.VTTCombat && window.VTTCombat.toggleEncounter) window.VTTCombat.toggleEncounter();
  }

  // ── Debug drawer (spec §2): GM-only toggle; hidden by default ──────────────
  function initDrawer() {
    // Elements exist for everyone (bindings must not throw) but are hidden and
    // GM-only; only the GM has the rail toggle.
    on('clearLog', 'click', function () {
      // The four files also bind clearLog; this is a harmless extra clear so the
      // button works even before any of them wired it. (Shared sink semantics.)
      var log = $('log'); if (log) log.textContent = '';
    });
  }
  function toggleDrawer() {
    var d = $('drawer');
    var btn = $('railConsole');
    if (!d) return;
    var openNow = d.hasAttribute('hidden');
    if (openNow) { show(d); if (btn) btn.setAttribute('aria-pressed', 'true'); }
    else { hide(d); if (btn) btn.setAttribute('aria-pressed', 'false'); }
  }

  // ── Escape stack (spec §6; first match wins) ───────────────────────────────
  // image picker → open <dialog> → context menu → armed ping → (fog draft /
  // marquee / selection: scene.js's own tail) → nothing. The shell owns only the
  // top of the stack; it must NOT swallow a keydown it did not handle, so the
  // canvas keeps its existing Esc behaviour for everything below.
  function initEscapeStack() {
    // Dialog Esc is handled by each dialog's own `cancel` handler (common.js),
    // which already defers to the image picker. The shell handles only the two
    // rungs that are not a <dialog>: the rail popovers and armed ping — and only
    // when nothing above them consumed the key.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;

      // Image picker first: if it is up, this Esc is for it — leave it entirely.
      if (window.VTTImagePicker && typeof window.VTTImagePicker.isOpen === 'function'
          && window.VTTImagePicker.isOpen()) return;

      // Any open dialog handles its own Esc (cancel handler). Don't interfere.
      if (anyDialogOpen()) return;

      // A rail popover is above the canvas's own rungs.
      if (openPop) { e.preventDefault(); closePop(); return; }

      // Everything below (context menu, fog polygon draft, marquee, selection)
      // is scene.js's; we neither preventDefault nor stopPropagation, so its own
      // keydown handler runs exactly as before. Sidebar/rail/drawer never close.
    }, false);
  }

  function anyDialogOpen() {
    var ids = ['sheetDialog', 'itemDialog', 'scenesDialog', 'alignDialog', 'confirmDialog'];
    for (var i = 0; i < ids.length; i++) { if (isDialogOpen($(ids[i]))) return true; }
    // The framing modal is a plain overlay, not a <dialog>; actors.js owns its
    // own Esc, so treat it as "handled above" too.
    var fm = $('frameModal');
    if (fm && fm.classList.contains('open')) return true;
    return false;
  }

  // ── Connection state (spec §7; the load-bearing requirement) ───────────────
  // Blank while live; on disconnect → "Reconnecting…"; on connect after a drop →
  // re-join the room and refetch scene tokens + fog + encounter + chat backlog,
  // because deltas were missed while down. The refetch reuses the boot loaders,
  // which are idempotent (they re-render from server truth) and re-join the room.
  // This ends the silent-stale-board failure that cost two debugging sessions.
  //
  // scene.js and combat.js each hold their own module-scoped socket and neither
  // re-joins on reconnect (scene's connect handler only logs). Rather than add a
  // seam to expose those sockets, the shell opens its OWN io() connection purely
  // to OBSERVE the transport: socket.io-client multiplexes over one Manager per
  // URL, so this rides the same WebSocket the harness scripts already opened and
  // sees the same connect/disconnect lifecycle. It never emits campaign:join —
  // re-joining is the boot loaders' job — so it adds no new server interaction.
  function initConnectionState() {
    if (typeof window.io !== 'function') return;   // jsdom without a fake io()
    var sock;
    try { sock = window.io({ withCredentials: true }); } catch (e) { return; }
    if (!sock || typeof sock.on !== 'function') return;
    if (sock.connected) wasConnected = true;

    sock.on('connect', function () {
      var firstConnect = !wasConnected;
      wasConnected = true;
      setText('connState', '');
      if (firstConnect) return;            // nothing to catch up on the first join
      setText('connState', 'catching up…');
      catchUp();
      window.setTimeout(function () {
        var el = $('connState'); if (el && el.textContent === 'catching up…') el.textContent = '';
      }, 1200);
    });

    sock.on('disconnect', function () {
      wasConnected = true;
      setText('connState', 'Reconnecting…');
    });

    // Expose for the suite's rejoin/refetch spies.
    window.VTTGame._connSocket = sock;
  }

  function catchUp() {
    // The same loaders boot() uses; each re-renders from the server, so calling
    // them again simply reconciles the board. scene re-joins its room inside boot.
    if (window.VTTScene && window.VTTScene.boot) window.VTTScene.boot(campaignId);
    if (window.VTTCombat && window.VTTCombat.boot) window.VTTCombat.boot(campaignId);
    if (actorsBooted && window.VTTActors && window.VTTActors.boot) window.VTTActors.boot(campaignId);
  }

  // ── Go ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose a tiny surface for the suite to drive/inspect (no behaviour of its
  // own beyond what the shell already does).
  window.VTTGame = {
    boot: boot,
    onTab: onTab,
    toggleDrawer: toggleDrawer,
    openScenes: openScenes,
    openAlign: openAlign,
    openEncounter: openEncounter,
    confirm: confirmThen,
  };
}());
