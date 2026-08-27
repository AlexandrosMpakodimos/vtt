// public/js/dashboard.js — the signed-in home (page 2 of 3): your games, the
// actions on them, discovery of others' games, and your account.
//
// REST is the source of truth (dashboard-design-spec §0.1). A lightweight lobby
// socket (initLobby, wired in a later commit) carries only presence and
// open/closed-state deltas; the list never waits for it and works without it.
//
// Constraints in force (CSP + house rules), identical to landing.js:
//   - No innerHTML / insertAdjacentHTML / document.write. Every dynamic string
//     reaches the DOM via textContent or an attribute setter; rows are cloned
//     from <template> or built with createElement.
//   - Classic script, no framework, no build step. Shared helpers come from
//     window.VTTCommon (theme, api, dialogs, navigate, fmtDate).

(function () {
  'use strict';

  var C = window.VTTCommon;
  var $ = C.$;
  var api = C.api;
  var fmtDate = C.fmtDate;
  var NETWORK_ERROR = C.NETWORK_ERROR;

  // ── Pure seams the suite drives directly ──────────────────────────────────
  function tabsRole(tabId) {
    if (tabId === 'tabRunning') return 'owner';
    if (tabId === 'tabPlaying') return 'player';
    return 'all';
  }

  // The "closed game, player viewing" rule as a testable function. A player
  // cannot enter a closed table (campaignAuth forbids it), so the card offers no
  // Enter and says why; the GM keeps Enter on a closed game (they prep inside).
  function cardState(campaign, isGm) {
    var open = campaign.is_open !== false;
    var showEnter = isGm || open;
    var stateWord = open ? 'Open' : 'Closed';
    var manageLabel = isGm ? 'Manage' : 'Details';
    return { showEnter: showEnter, stateWord: stateWord, manageLabel: manageLabel };
  }

  function inviteUrl(origin, id) {
    return origin + '/dashboard.html?join=' + id;
  }

  window.VTTDashboard = {
    navigate: C.navigate,
    tabsRole: tabsRole,
    cardState: cardState,
    inviteUrl: inviteUrl,
  };

  // ── Small DOM helpers (no innerHTML) ───────────────────────────────────────
  function setText(id, msg) { var el = $(id); if (el) el.textContent = msg == null ? '' : String(msg); }
  function show(id) { var el = $(id); if (el) el.removeAttribute('hidden'); }
  function hide(id) { var el = $(id); if (el) el.setAttribute('hidden', ''); }
  function on(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
  function serverError(r) {
    if (r && r.data && typeof r.data.error === 'string') return humanError(r.data.error);
    return NETWORK_ERROR;
  }

  // Translate raw, field-name-y server validation errors into natural language.
  // Most server messages are already human; these few leak internal field names.
  function humanError(msg) {
    var map = {
      'currentPassword is required': 'Please enter your current password.',
      'newPassword is required': 'Please enter a new password.',
      'newEmail is required': 'Please enter a new email address.',
      'email is required': 'Please enter your email address.',
      'password is required': 'Please enter your password.',
      'username is required': 'Please enter a username.'
    };
    return map[msg] || msg;
  }
  // Disable a submit while a request is in flight; restore its label after.
  function withPending(btn, run) {
    var label = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    return run().finally(function () {
      if (btn) { btn.disabled = false; if (label !== null) btn.textContent = label; }
    });
  }
  function originOf() {
    try { return window.location.origin; } catch (e) { return ''; }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  var me = null;                 // the signed-in user
  var activeTab = 'tabAll';      // which list tab is selected
  var loadingTimer = null;       // deferred "Loading…" — only shows on a slow load
  var onlineByCampaign = {};     // campaign_id -> online count (from the lobby)

  // ── Boot ─────────────────────────────────────────────────────────────────
  var booted = false;
  function boot() {
    // Idempotent: depending on how the page is loaded, both the readyState
    // check and a DOMContentLoaded dispatch can fire, and double-init would bind
    // every handler (e.g. the search submit) twice — causing duplicate requests.
    if (booted) return;
    booted = true;
    api('GET', '/api/auth/me').then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.user) { C.navigate('/'); return; }
      me = r.data.user;
      renderHeader();
      readUrlParams();
      C.initTheme();
      initTabs('listTabs', onListTab);
      initButtons();
      initCreate();
      initFind();
      initProfile();
      initConfirm();
      initCardOverlay();
      loadList();
      loadDeleted();
      initLobby();

      // Enable theme-crossfade only after the first paint.
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          document.documentElement.classList.add('theme-ready');
        });
      });
    }).catch(function () { C.navigate('/'); });
  }

  function renderHeader() {
    setText('profileName', me.username || 'you');
    var av = $('profileAvatar');
    if (av) {
      if (me.avatar_url) {
        // Swap the mask span for a real image via attributes only.
        av.classList.remove('mask');
        av.style.webkitMask = 'none';
        av.style.mask = 'none';
        av.style.backgroundImage = '';
        av.setAttribute('role', 'img');
        // Use an <img> child so we never touch innerHTML: clear then append.
        while (av.firstChild) av.removeChild(av.firstChild);
        var img = document.createElement('img');
        img.src = me.avatar_url;
        img.alt = '';
        img.style.width = '100%'; img.style.height = '100%';
        img.style.objectFit = 'cover'; img.style.borderRadius = '50%';
        av.appendChild(img);
      } else {
        av.classList.add('mask');
      }
    }
  }

  // ── URL params: ?join=<uuid> opens Find on the join face ───────────────────
  function readUrlParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return; }
    var join = params.get('join');
    if (join) {
      // Defer opening until dialogs are initialised; stash it.
      pendingJoinId = join;
      try { window.history.replaceState(null, '', '/dashboard.html'); } catch (e) { /* no-op */ }
    }
  }
  var pendingJoinId = null;

  // ── Tabs component (APG) — used for #listTabs and #cdTabs ──────────────────
  // role=tablist/tab/tabpanel, aria-selected, roving tabindex (0 on selected,
  // -1 else), Left/Right wrap, Home/End, activation on arrow, click activates.
  function initTabs(tablistId, onSelect) {
    var strip = $(tablistId);
    if (!strip) return;
    var tabs = Array.prototype.slice.call(strip.querySelectorAll('[role="tab"]'));
    function select(tab, focusIt) {
      // The selected tab's panel. When several tabs share ONE panel (the list's
      // All/Running/Playing all control #campaignPanel), that panel must stay
      // visible on every switch — only its contents reload. So we show the
      // selected panel first, then hide only panels that are NOT it.
      var selectedPanelId = tab.getAttribute('aria-controls');
      for (var i = 0; i < tabs.length; i++) {
        var selected = tabs[i] === tab;
        tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
        tabs[i].setAttribute('tabindex', selected ? '0' : '-1');
        var panelId = tabs[i].getAttribute('aria-controls');
        var panel = panelId ? $(panelId) : null;
        if (!panel) continue;
        if (panelId === selectedPanelId) {
          panel.removeAttribute('hidden');
          panel.setAttribute('aria-labelledby', tab.id);
        } else {
          panel.setAttribute('hidden', '');
        }
      }
      if (focusIt && typeof tab.focus === 'function') tab.focus();
      if (onSelect) onSelect(tab.id);
    }
    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(idx + 1) % tabs.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(idx - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
    // Expose a programmatic selector for callers (e.g. open dialog on Settings).
    strip._select = function (tabId) {
      var t = tabs.filter(function (x) { return x.id === tabId; })[0];
      if (t) select(t, false);
    };
    return strip;
  }

  function onListTab(tabId) {
    activeTab = tabId;
    loadList();
  }

  // ── The list ────────────────────────────────────────────────────────────
  function currentFilter() {
    var cb = $('showArchived');
    return (cb && cb.checked) ? 'archived' : 'active';
  }

  // Show "Loading…" only if the fetch is genuinely slow. A timer arms the text
  // after a short delay; a fast response clears the timer before it ever fires,
  // so quick tab switches don't flash a spinner. LOADING_DELAY is the threshold.
  var LOADING_DELAY = 300;
  function clearLoading() {
    if (loadingTimer) { window.clearTimeout(loadingTimer); loadingTimer = null; }
  }

  function loadList(onDone) {
    var role = tabsRole(activeTab);
    var filter = currentFilter();
    var panel = $('campaignPanel');
    if (panel) panel.setAttribute('aria-busy', 'true');
    // Defer the visible "Loading…" — don't show it immediately.
    clearLoading();
    loadingTimer = window.setTimeout(function () { setText('listStatus', 'Loading…'); loadingTimer = null; }, LOADING_DELAY);
    api('GET', '/api/campaigns/mine?role=' + role + '&filter=' + filter).then(function (r) {
      clearLoading();
      if (panel) panel.removeAttribute('aria-busy');
      if (r.status === 401) { C.navigate('/'); return; }
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.campaigns)) {
        setText('listStatus', serverError(r));
        return;
      }
      setText('listStatus', '');
      renderCards(r.data.campaigns);
      // Presence is re-requested after any list change (idempotent server-side).
      lobbyResubscribe();
      if (typeof onDone === 'function') onDone();
    }).catch(function () { clearLoading(); if (panel) panel.removeAttribute('aria-busy'); setText('listStatus', NETWORK_ERROR); });
  }

  // Expand a specific card by id (used after create so the new game opens with
  // its cover picker ready). No-op if not found.
  function expandCardById(id) {
    for (var i = 0; i < cardControllers.length; i++) {
      if (cardControllers[i].id === id) { cardControllers[i].open(); return; }
    }
  }

  // Track the currently expanded card's controller so opening another closes it
  // (accordion), and so we can guard unsaved GM edits before collapsing.
  var openController = null;
  // When a save/open-close happens while a card is expanded, we defer refreshing
  // the (hidden) background grid until the overlay closes — rebuilding it mid-open
  // would orphan the moved panel and null out openController (breaking click-away).
  var pendingListReload = false;
  function scheduleListReload() { pendingListReload = true; }
  var cardControllers = [];   // rebuilt each render, so stale nodes are dropped

  function renderCards(campaigns) {
    var grid = $('cardsGrid');
    var tmpl = $('cardTemplate');
    if (!grid || !tmpl) return;
    openController = null;
    cardControllers = [];
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!campaigns.length) { show('emptyState'); return; }
    hide('emptyState');

    campaigns.forEach(function (c) {
      var node = tmpl.content.firstElementChild.cloneNode(true);
      node.setAttribute('data-id', c.id);
      var ctrl = makeCardController(node, c);
      cardControllers.push(ctrl);
      grid.appendChild(node);
    });
  }

  // One controller per card: owns its collapsed head, its expand/collapse, and
  // (lazily) its expanded Overview/Members. The expanded region is populated the
  // first time it opens and re-synced after saves/lobby updates.
  function makeCardController(node, c) {
    var isGm = c.is_gm === true;
    var built = false;       // expanded region wired yet?
    var dirty = false;       // GM has unsaved edits?

    // ── collapsed head ──
    var head = node.querySelector('.card-head');
    var cover = node.querySelector('.card-cover');
    if (c.img_url) {
      var img = document.createElement('img');
      img.className = 'card-cover'; img.src = c.img_url; img.alt = ''; img.loading = 'lazy';
      cover.parentNode.replaceChild(img, cover);
    }
    node.querySelector('.card-name').textContent = c.name || '(untitled)';
    var owner = node.querySelector('.card-owner');
    if (isGm) owner.textContent = 'by you';
    else if (c.owner_username) owner.textContent = 'by ' + c.owner_username;
    else owner.setAttribute('hidden', '');
    node.querySelector('.badge-role').textContent = isGm ? 'GM' : 'Player';
    node.querySelector('.badge-vis').textContent = c.is_public ? 'Anyone' : 'Password';
    var pill = node.querySelector('.pill-state');
    var st = cardState(c, isGm);
    pill.textContent = st.stateWord;
    pill.classList.add(c.is_open !== false ? 'open' : 'closed');
    var online = node.querySelector('.card-online');
    var count = onlineByCampaign[c.id];
    online.textContent = (count != null) ? (count + ' at the table') : '';
    if (c.archived) node.querySelector('.badge-archived').removeAttribute('hidden');

    // Small Enter on the collapsed head (one-click to play). Hidden when the
    // player can't enter a closed table; the GM always can.
    var headEnter = node.querySelector('.card-head .card-enter');
    if (st.showEnter) headEnter.setAttribute('href', '/game.html?campaign=' + c.id);
    else if (headEnter && headEnter.parentNode) headEnter.parentNode.removeChild(headEnter);
    // Enter must not toggle the card.
    if (headEnter) headEnter.addEventListener('click', function (e) { e.stopPropagation(); });

    var expand = node.querySelector('.card-expand');
    var panel = node.querySelector('.card-panel');   // the floating rectangle

    function isOpen() { return node.getAttribute('data-expanded') === 'true'; }

    function open() {
      if (isOpen()) return;
      // Accordion: only one open. Close whoever's open first (guarding edits).
      if (openController && openController !== ctrl) {
        openController.requestCollapse(function () { reallyOpen(); });
      } else {
        reallyOpen();
      }
    }

    // Compute the centred, viewport-fitting target rect for the panel.
    function targetRect() {
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      // Responsive: large on desktop, near-fullscreen on small screens. Always
      // fits, with a margin, so nothing overflows the screen.
      var margin = vw < 640 ? 12 : 24;
      var w = Math.min(560, vw - margin * 2);
      var maxH = vh - margin * 2;
      var h = Math.min(vw < 640 ? maxH : 720, maxH);
      return { left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2), width: Math.round(w), height: Math.round(h) };
    }

    function reallyOpen() {
      if (!built) { buildExpanded(); built = true; }
      var overlay = $('cardOverlay');
      var stage = $('cardOverlayStage');
      if (!overlay || !stage || !panel) return;

      // Measure the collapsed card's current position (FLIP: "First").
      var from = node.getBoundingClientRect();
      // Move the panel into the shared overlay stage (only one card is ever open).
      stage.appendChild(panel);
      overlay.removeAttribute('hidden');
      node.setAttribute('data-expanded', 'true');
      head.setAttribute('aria-expanded', 'true');
      openController = ctrl;

      var to = targetRect();
      var reduce = prefersReducedMotion();

      // Place the panel at the target rect, then transform it BACK to the card's
      // rect, so the transition animates from card → centre ("Invert" + "Play").
      panel.style.left = to.left + 'px';
      panel.style.top = to.top + 'px';
      panel.style.width = to.width + 'px';
      panel.style.height = to.height + 'px';

      if (reduce || !from.width) {
        // No motion (or no geometry, e.g. jsdom): just show it centred + scrim.
        window.requestAnimationFrame(function () { overlay.classList.add('open'); });
      } else {
        var sx = from.width / to.width;
        var sy = from.height / to.height;
        var tx = from.left - to.left;
        var ty = from.top - to.top;
        panel.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sx + ',' + sy + ')';
        panel.style.opacity = '0.6';
        // Next frame: enable the transition and clear the transform → it eases
        // to the centred rect.
        window.requestAnimationFrame(function () {
          panel.classList.add('flipping');
          overlay.classList.add('open');
          panel.style.transform = 'none';
          panel.style.opacity = '1';
        });
      }
      // Lock background scroll while open.
      document.body.classList.add('overlay-open');
      // Focus the close button for keyboard users.
      var closeBtn = panel.querySelector('.cp-close');
      if (closeBtn && closeBtn.focus) { try { closeBtn.focus(); } catch (e) {} }
    }

    function collapse() {
      if (!isOpen()) return;
      var overlay = $('cardOverlay');
      var reduce = prefersReducedMotion();
      node.setAttribute('data-expanded', 'false');
      head.setAttribute('aria-expanded', 'false');
      if (openController === ctrl) openController = null;
      document.body.classList.remove('overlay-open');

      function finish() {
        panel.classList.remove('flipping');
        panel.style.transform = 'none'; panel.style.opacity = '';
        panel.style.left = panel.style.top = panel.style.width = panel.style.height = '';
        if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('hidden', ''); }
        // Move the panel back into its card node so its cached els/listeners
        // survive for next time (panel is MOVED, never recreated).
        if (expand && panel.parentNode !== expand) expand.appendChild(panel);
        // A save/toggle while open deferred the grid refresh (rebuilding the grid
        // mid-open would orphan this panel and drop openController). Do it now.
        if (pendingListReload) { pendingListReload = false; loadList(); }
      }

      if (reduce || !panel.getBoundingClientRect().width) { finish(); return; }

      // FLIP back toward the collapsed card's current rect.
      var to = node.getBoundingClientRect();
      var cur = panel.getBoundingClientRect();
      var sx = to.width / cur.width;
      var sy = to.height / cur.height;
      var tx = to.left - cur.left;
      var ty = to.top - cur.top;
      panel.classList.add('flipping');
      if (overlay) overlay.classList.remove('open');
      panel.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sx + ',' + sy + ')';
      panel.style.opacity = '0.4';
      var done = false;
      var onEnd = function () { if (done) return; done = true; panel.removeEventListener('transitionend', onEnd); finish(); };
      panel.addEventListener('transitionend', onEnd);
      window.setTimeout(onEnd, 400); // fallback if transitionend doesn't fire
    }

    // Collapse, but if the GM has unsaved edits, ask first. onProceed runs once
    // it's safe to collapse (after save or discard); cancel aborts.
    function requestCollapse(onProceed) {
      if (!dirty) { collapse(); if (onProceed) onProceed(); return; }
      confirmThreeWay(
        'Unsaved changes',
        'You have unsaved changes to this game. Save them before closing?',
        'Save', 'Discard', 'Keep editing',
        function () { // Save
          saveSettings(function (ok) { if (ok) { dirty = false; setDirty(false); collapse(); if (onProceed) onProceed(); } });
        },
        function () { // Discard
          dirty = false; setDirty(false); syncFields(); collapse(); if (onProceed) onProceed();
        }
        // Cancel: do nothing (stay open, keep editing)
      );
    }

    head.addEventListener('click', function () { if (isOpen()) requestCollapse(); else open(); });

    // ── expanded region (built lazily) ──
    var els = {};
    var tabsApi = null;
    var visDD = null;   // the themed Joining dropdown's API (set/get)

    function buildExpanded() {
      // Banner
      var banner = node.querySelector('.card-banner-img');
      if (c.img_url) {
        var bimg = document.createElement('img');
        bimg.className = 'card-banner-img'; bimg.src = c.img_url; bimg.alt = ''; bimg.loading = 'lazy';
        banner.parentNode.replaceChild(bimg, banner);
      }
      node.querySelector('.cd-title').textContent = c.name || '(untitled)';
      var cdOwner = node.querySelector('.cd-owner');
      cdOwner.textContent = isGm ? 'Run by you' : (c.owner_username ? ('Run by ' + c.owner_username) : '');

      // Cache field refs (inputs + their value-text displays + reveal editors).
      els.fName = node.querySelector('.cd-f-name');
      els.fDesc = node.querySelector('.cd-f-desc');
      els.fImg = node.querySelector('.cd-f-img');
      els.fVis = node.querySelector('.cd-f-vis');
      els.fPw = node.querySelector('.cd-f-pw');
      els.nameText = node.querySelector('.cd-name-text');
      els.descText = node.querySelector('.cd-desc-text');
      els.visText = node.querySelector('.cd-vis-text');
      els.nameBtn = node.querySelector('.cd-name-btn');
      els.descBtn = node.querySelector('.cd-desc-btn');
      els.visBtn = node.querySelector('.cd-vis-btn');
      els.visEdit = node.querySelector('.cd-vis-edit');
      els.coverBtn = node.querySelector('.cd-cover-btn');
      els.pwField = node.querySelector('.cd-pw-field');
      els.save = node.querySelector('.cd-save');
      els.saveHint = node.querySelector('.cd-save-hint');
      els.savebar = node.querySelector('.cd-savebar');
      els.openclose = node.querySelector('.cd-openclose');
      els.enter = node.querySelector('.cd-enter');
      els.leave = node.querySelector('.cd-leave');
      els.invite = node.querySelector('.cd-invite');
      els.copy = node.querySelector('.cd-copy');
      els.danger = node.querySelector('.cd-danger');
      els.archive = node.querySelector('.cd-archive');
      els.del = node.querySelector('.cd-delete');
      els.statusMsg = node.querySelector('.cd-status-msg');
      els.note = node.querySelector('.cd-note');
      els.status = node.querySelector('.cd-status');
      els.online = node.querySelector('.cd-online');
      els.created = node.querySelector('.cd-created');
      els.memberList = node.querySelector('.cd-member-list');
      els.bannedHead = node.querySelector('.cd-banned-head');
      els.bannedList = node.querySelector('.cd-banned-list');

      // In-card tabs (per card).
      tabsApi = wireCardTabs(node);

      // GM vs player: the GM gets Change affordances + the cover picker + danger.
      if (isGm) {
        els.danger.removeAttribute('hidden');
        if (els.coverBtn) els.coverBtn.removeAttribute('hidden');
        [els.nameBtn, els.descBtn, els.visBtn].forEach(function (b) { if (b) b.removeAttribute('hidden'); });

        // The big banner is the cover editor: clicking it opens the picker.
        if (window.VTTImagePicker && els.coverBtn) {
          els.coverBtn.addEventListener('click', function () {
            window.VTTImagePicker.open({
              kind: 'cover', campaignId: c.id, current: els.fImg ? els.fImg.value : (c.img_url || ''),
              onChoose: function (url) {
                if (els.fImg) { els.fImg.value = url; }
                updateBannerPreview(url); markDirty();
              }
            });
          });
        }

        // Name: in-place edit (text ↔ input), Change ↔ Cancel.
        if (els.nameBtn) els.nameBtn.addEventListener('click', function () { toggleNameEdit(); });
        if (els.descBtn) els.descBtn.addEventListener('click', function () { toggleDescEdit(); });
        // Description textarea grows to fit its content as you type.
        if (els.fDesc) els.fDesc.addEventListener('input', function () { autoGrowDesc(); });
        wireOvReveal('vis', els.visBtn, els.visEdit);

        // Joining uses our themed dropdown (not a native select) — same component
        // as Find. It writes to the hidden .cd-f-vis input, so readers/writers of
        // els.fVis.value are unchanged; choosing dispatches change (handled below).
        visDD = initDropdown(node.querySelector('.cd-vis-dd'), [
          { value: 'public', label: 'Anyone' },
          { value: 'private', label: 'Password' }
        ]);

        // Editing signals: any change reveals Save + marks dirty.
        ['input', 'change'].forEach(function (ev) {
          [els.fName, els.fDesc, els.fVis, els.fPw].forEach(function (f) {
            if (f) f.addEventListener(ev, function () { markDirty(); if (f === els.fVis) applyVisField(); });
          });
        });
        els.save.addEventListener('click', function () { saveSettings(); });
        els.del.addEventListener('click', onDelete);
        wirePwToggle(node.querySelector('.cd-pw-toggle'), els.fPw);
      }


      // Archive is available to everyone (per-user; server allows any member).
      els.archive.textContent = (c.archived === true) ? 'Unarchive' : 'Archive';
      els.archive.addEventListener('click', onArchive);
      els.copy.addEventListener('click', onCopyInvite);
      els.openclose.addEventListener('click', onToggleOpen);
      els.leave.addEventListener('click', onLeave);
      node.querySelector('.cd-collapse').addEventListener('click', function () { requestCollapse(); });

      syncFields();
      loadMembers();
    }

    // Fill display + fields from the current `c`.
    function syncFields() {
      els.fName.value = c.name || '';
      els.fDesc.value = c.description || '';
      if (els.fImg) els.fImg.value = c.img_url || '';
      els.fVis.value = c.is_public ? 'public' : 'private';
      if (visDD) visDD.set(c.is_public ? 'public' : 'private');
      if (els.fPw) els.fPw.value = '';
      // Value-text displays (the read/collapsed state of each row).
      if (els.nameText) els.nameText.textContent = c.name || '';
      if (els.descText) els.descText.textContent = c.description || 'No description';
      if (els.visText) els.visText.textContent = c.is_public ? 'Anyone can join' : 'Password required';
      applyVisField();
      updateBannerPreview(c.img_url || '');
      var stx = cardState(c, isGm);
      els.status.textContent = c.is_open !== false ? 'Open' : 'Closed';
      var cnt = onlineByCampaign[c.id];
      els.online.textContent = cnt != null ? String(cnt) : '—';
      els.created.textContent = fmtDate(c.created_at);
      els.invite.value = inviteUrl(originOf(), c.id);

      // Enter / note
      if (stx.showEnter) { els.enter.setAttribute('href', '/game.html?campaign=' + c.id); els.enter.removeAttribute('hidden'); els.note.setAttribute('hidden', ''); }
      else { els.enter.setAttribute('hidden', ''); els.note.textContent = "Closed — the GM hasn't opened the table."; els.note.removeAttribute('hidden'); }

      // GM open/close toggle; player Leave.
      if (isGm) { els.openclose.removeAttribute('hidden'); els.openclose.textContent = (c.is_open !== false) ? 'Close the table' : 'Open the table'; }
      else els.openclose.setAttribute('hidden', '');
      if (!isGm) els.leave.removeAttribute('hidden'); else els.leave.setAttribute('hidden', '');
    }

    // Name row: swap the value-text for the input in place; Change ↔ Cancel.
    function toggleNameEdit() {
      if (!els.fName || !els.nameText || !els.nameBtn) return;
      var editing = !els.fName.hasAttribute('hidden');
      if (editing) {
        els.fName.value = c.name || '';           // revert on cancel
        els.fName.setAttribute('hidden', ''); els.nameText.removeAttribute('hidden');
        els.nameBtn.classList.remove('active');
      } else {
        closeOtherOvEditors('name');
        els.nameText.setAttribute('hidden', ''); els.fName.removeAttribute('hidden');
        els.nameBtn.classList.add('active');
      }
      if (!editing && els.fName.focus) { els.fName.focus(); els.fName.select && els.fName.select(); }
    }

    // Description row: swap the value-text <p> for the textarea in place.
    function toggleDescEdit() {
      if (!els.fDesc || !els.descText || !els.descBtn) return;
      var editing = !els.fDesc.hasAttribute('hidden');
      C.animateResize(ovCard(), function () {
        if (editing) {
          els.fDesc.value = c.description || '';     // revert on cancel
          els.fDesc.setAttribute('hidden', ''); els.descText.removeAttribute('hidden');
          els.descBtn.classList.remove('active');
        } else {
          closeOtherOvEditors('desc');
          els.descText.setAttribute('hidden', ''); els.fDesc.removeAttribute('hidden');
          els.descBtn.classList.add('active');
        }
      });
      if (!editing) { autoGrowDesc(); if (els.fDesc.focus) els.fDesc.focus(); }
    }
    // Resize the description textarea to fit its content (no manual drag needed).
    function autoGrowDesc() {
      var ta = els.fDesc; if (!ta || ta.hasAttribute('hidden')) return;
      ta.style.height = 'auto';
      ta.style.height = (ta.scrollHeight + 2) + 'px';
    }

    // Description / Joining rows: reveal editors, accordion with each other + name.
    var OV_EDITORS = { desc: null, vis: null };
    function wireOvReveal(which, btn, edit) {
      OV_EDITORS[which] = { btn: btn, edit: edit };
      if (!btn || !edit) return;
      btn.addEventListener('click', function () {
        var open = !edit.hasAttribute('hidden');
        C.animateResize(ovCard(), function () {
          if (open) { collapseOvEditor(which); }
          else {
            closeOtherOvEditors(which);
            edit.removeAttribute('hidden'); btn.classList.add('active');
          }
        });
        if (!open) { var f = edit.querySelector('textarea, select, input'); if (f && f.focus) f.focus(); }
      });
    }
    function ovEditorOpen(which) {
      if (which === 'name') return els.fName && !els.fName.hasAttribute('hidden');
      if (which === 'desc') return els.fDesc && !els.fDesc.hasAttribute('hidden');
      var e = OV_EDITORS[which]; return e && e.edit && !e.edit.hasAttribute('hidden');
    }
    function collapseOvEditor(which) {
      if (which === 'name') {
        if (els.fName) { els.fName.value = c.name || ''; els.fName.setAttribute('hidden', ''); }
        if (els.nameText) els.nameText.removeAttribute('hidden');
        if (els.nameBtn) els.nameBtn.classList.remove('active');
        return;
      }
      if (which === 'desc') {
        if (els.fDesc) { els.fDesc.value = c.description || ''; els.fDesc.setAttribute('hidden', ''); }
        if (els.descText) els.descText.removeAttribute('hidden');
        if (els.descBtn) els.descBtn.classList.remove('active');
        return;
      }
      var e = OV_EDITORS[which]; if (!e || !e.edit) return;
      // Revert the field to its saved value on collapse.
      if (which === 'vis' && els.fVis) { els.fVis.value = c.is_public ? 'public' : 'private'; if (visDD) visDD.set(c.is_public ? 'public' : 'private'); if (els.fPw) els.fPw.value = ''; applyVisField(); }
      e.edit.setAttribute('hidden', '');
      if (e.btn) e.btn.classList.remove('active');
    }
    function closeOtherOvEditors(keep) {
      ['name', 'desc', 'vis'].forEach(function (which) {
        if (which !== keep && ovEditorOpen(which)) collapseOvEditor(which);
      });
    }
    function collapseAllOvEditors() {
      ['name', 'desc', 'vis'].forEach(function (which) { if (ovEditorOpen(which)) collapseOvEditor(which); });
    }
    function ovCard() { return node.querySelector('.cd-ov'); }

    function applyVisField() {
      if (!els.pwField) return;
      // Password field only relevant to a GM setting a private game.
      if (isGm && els.fVis.value === 'private') els.pwField.removeAttribute('hidden');
      else els.pwField.setAttribute('hidden', '');
    }

    function updateBannerPreview(url) {
      var banner = panel.querySelector('.card-banner-img');
      if (!banner) return;
      if (url) {
        if (banner.tagName !== 'IMG') {
          var bimg = document.createElement('img');
          bimg.className = 'card-banner-img'; bimg.alt = ''; banner.parentNode.replaceChild(bimg, banner); banner = bimg;
        }
        banner.src = url; banner.classList.remove('mask');
      } else if (banner.tagName === 'IMG') {
        var span = document.createElement('span');
        span.className = 'card-banner-img mask'; span.setAttribute('aria-hidden', 'true');
        banner.parentNode.replaceChild(span, banner);
      }
    }

    function markDirty() { if (!dirty) { dirty = true; setDirty(true); } }
    function setDirty(on) {
      if (!els.savebar) return;
      if (on) els.savebar.removeAttribute('hidden');
      else els.savebar.setAttribute('hidden', '');
    }

    function saveSettings(done) {
      var isPublic = els.fVis.value === 'public';
      // A game with no existing password that's going private MUST get one now, or
      // it would be private-but-unjoinable (the server rejects this too). Catch it
      // client-side for an immediate, friendly message instead of a raw 400.
      var hasExistingPw = !c.is_public;   // currently private ⇒ already has a password
      if (!isPublic && !hasExistingPw && (!els.fPw || els.fPw.value === '')) {
        // Make sure the editor + password field are visible so the error has context.
        if (!ovEditorOpen('vis') && els.visBtn) els.visBtn.click();
        applyVisField();
        if (els.fPw && els.fPw.focus) els.fPw.focus();
        els.statusMsg.textContent = 'Set a password to make this game password-protected.';
        if (done) done(false);
        return;
      }
      var body = { name: els.fName.value, description: els.fDesc.value, img_url: els.fImg ? els.fImg.value : c.img_url, is_public: isPublic };
      // Password-omit semantics (verified against the PATCH route): staying
      // private with a blank field omits the key (keeps current); '' would 400.
      if (!isPublic && els.fPw && els.fPw.value !== '') body.password = els.fPw.value;
      els.statusMsg.textContent = '';
      withPending(els.save, function () {
        return api('PATCH', '/api/campaigns/' + c.id, body).then(function (r) {
          if (r.status === 200 && r.data && r.data.campaign) {
            Object.assign(c, r.data.campaign);
            dirty = false; setDirty(false);
            els.statusMsg.textContent = 'Saved.';
            collapseAllOvEditors();
            syncFields();
            refreshHead();
            scheduleListReload(); // background grid refreshes on close, keeps overlay wired
            if (done) done(true);
          } else { els.statusMsg.textContent = serverError(r); if (done) done(false); }
        }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; if (done) done(false); });
      });
    }

    // Keep the collapsed head in sync after a save (name/vis/state/cover).
    function refreshHead() {
      node.querySelector('.card-name').textContent = c.name || '(untitled)';
      node.querySelector('.badge-vis').textContent = c.is_public ? 'Anyone' : 'Password';
      var p = node.querySelector('.pill-state');
      p.textContent = (c.is_open !== false) ? 'Open' : 'Closed';
      p.classList.remove('open', 'closed'); p.classList.add(c.is_open !== false ? 'open' : 'closed');
    }

    function onToggleOpen() {
      var next = !(c.is_open !== false);
      var btn = els.openclose;
      if (btn) btn.disabled = true;
      var prev = btn ? btn.textContent : '';
      if (btn) btn.textContent = 'Working…';
      api('PATCH', '/api/campaigns/' + c.id, { is_open: next }).then(function (r) {
        if (r.status === 200 && r.data && r.data.campaign) {
          Object.assign(c, r.data.campaign);
          if (btn) btn.disabled = false;
          syncFields();          // sets the correct new label ("Open/Close the table")
          refreshHead();
          scheduleListReload();  // refresh the background grid on close, not now
        } else {
          if (btn) { btn.disabled = false; btn.textContent = prev; }
          els.statusMsg.textContent = serverError(r);
        }
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = prev; }
        els.statusMsg.textContent = NETWORK_ERROR;
      });
    }

    function onCopyInvite() {
      var text = els.invite.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { els.statusMsg.textContent = 'Copied'; }).catch(function () { els.invite.select(); });
      } else els.invite.select();
    }

    function onLeave() {
      confirmThen('Leave this game?', 'You can rejoin later if it stays public.', false, function () {
        api('POST', '/api/campaigns/' + c.id + '/leave').then(function (r) {
          if (r.status === 200) { collapse(); loadList(); } else els.statusMsg.textContent = serverError(r);
        }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; });
      });
    }

    function onArchive() {
      var archived = c.archived === true;
      api('POST', '/api/campaigns/' + c.id + '/' + (archived ? 'unarchive' : 'archive')).then(function (r) {
        if (r.status === 200) {
          // The game moves between the active/archived views, so the open panel
          // shouldn't linger over a grid it's leaving — close, then reload.
          collapse();
          loadList();
        } else els.statusMsg.textContent = serverError(r);
      }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; });
    }

    function onDelete() {
      confirmThen('Delete this game?', 'Deleted games can be restored for 30 days from Recently deleted.', true, function () {
        api('DELETE', '/api/campaigns/' + c.id).then(function (r) {
          if (r.status === 200) { collapse(); loadList(); loadDeleted(); } else els.statusMsg.textContent = serverError(r);
        }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; });
      });
    }

    // Members: active roster immediately; GM also gets all-status + moderation.
    function loadMembers() {
      api('GET', '/api/campaigns/' + c.id).then(function (r) {
        if (r.status === 200 && r.data && r.data.campaign) {
          // Merge, don't replace: the detail endpoint omits per-user fields like
          // `archived` (derived from the member row), and replacing c with it
          // would drop that — flipping the archive/unarchive button's direction.
          Object.assign(c, r.data.campaign);
          renderMemberRows(r.data.members || []);
          if (isGm) {
            api('GET', '/api/campaigns/' + c.id + '/members').then(function (mr) {
              if (mr.status === 200 && mr.data && Array.isArray(mr.data.members)) renderMemberRows(mr.data.members);
            }).catch(function () {});
          }
        }
      }).catch(function () {});
    }

    function renderMemberRows(members) {
      var list = els.memberList, banned = els.bannedList;
      while (list.firstChild) list.removeChild(list.firstChild);
      while (banned.firstChild) banned.removeChild(banned.firstChild);
      var bannedCount = 0;
      members.forEach(function (m) {
        if (m.status === 'left') return;
        if (m.status === 'banned') { bannedCount++; banned.appendChild(buildMemberRow(m, true)); return; }
        list.appendChild(buildMemberRow(m, false));
      });
      if (els.bannedHead) { if (isGm && bannedCount) els.bannedHead.removeAttribute('hidden'); else els.bannedHead.setAttribute('hidden', ''); }
    }

    function buildMemberRow(m, isBanned) {
      var row = document.createElement('div');
      row.className = 'member-row'; row.setAttribute('data-user', m.user_id);
      var who = document.createElement('div'); who.className = 'who';
      var av = document.createElement('span'); av.className = 'avatar';
      if (m.avatar_url) { var i = document.createElement('img'); i.src = m.avatar_url; i.alt = ''; i.style.width = '100%'; i.style.height = '100%'; i.style.objectFit = 'cover'; i.style.borderRadius = '50%'; av.appendChild(i); }
      var col = document.createElement('div');
      var nm = document.createElement('div'); nm.className = 'name'; nm.textContent = m.username || m.user_id;
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = (m.is_gm ? 'GM' : 'Player') + (m.joined_at ? (' · joined ' + fmtDate(m.joined_at)) : '');
      col.appendChild(nm); col.appendChild(meta); who.appendChild(av); who.appendChild(col); row.appendChild(who);
      if (isGm && m.user_id !== (me && me.id)) {
        var actions = document.createElement('div'); actions.className = 'row-actions';
        if (isBanned) {
          actions.appendChild(smallBtn('Unban', 'secondary', function () { moderateMember(m, 'unban'); }));
        } else {
          // Transfer ownership lives with the other per-member actions now. It's
          // a significant, one-way change (you become a player, they become GM),
          // so it gets an explicit warning naming who and what.
          actions.appendChild(smallBtn('Make owner', 'secondary', function () {
            confirmThen(
              'Make ' + shortName(m.username) + ' the owner?',
              'They become the GM with full control of this game, and you become a regular player. This can only be undone if the new owner transfers it back.',
              true,
              function () { transferTo(m); }
            );
          }));
          actions.appendChild(smallBtn('Kick', 'secondary', function () { confirmThen('Kick ' + shortName(m.username) + '?', 'They can rejoin on their own if the game is public.', false, function () { moderateMember(m, 'kick'); }); }));
          actions.appendChild(smallBtn('Ban', 'danger', function () { confirmThen('Ban ' + shortName(m.username) + '?', 'They will not be able to rejoin until you unban them.', true, function () { moderateMember(m, 'ban'); }); }));
        }
        row.appendChild(actions);
      }
      return row;
    }
    function smallBtn(label, variant, fn) { var b = document.createElement('button'); b.className = 'btn ' + variant + ' small'; b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); return b; }
    // Cap a username for use inside a sentence (e.g. a confirm title) so an
    // extremely long name doesn't dominate the dialog. The row itself shows the
    // full (ellipsised) name; here we just keep the prompt readable.
    function shortName(name, fallback) {
      var n = name || fallback || 'this player';
      return n.length > 24 ? (n.slice(0, 24) + '…') : n;
    }
    function moderateMember(m, action) {
      api('POST', '/api/campaigns/' + c.id + '/members/' + m.user_id + '/' + action).then(function (r) {
        if (r.status === 200) { loadMembers(); loadList(); } else els.statusMsg.textContent = serverError(r);
      }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; });
    }
    function transferTo(m) {
      api('POST', '/api/campaigns/' + c.id + '/transfer', { user_id: m.user_id }).then(function (r) {
        if (r.status === 200) { loadList(); loadMembers(); } else els.statusMsg.textContent = serverError(r);
      }).catch(function () { els.statusMsg.textContent = NETWORK_ERROR; });
    }

    // Lobby deltas can update this card while open.
    function applyPresence(cnt) {
      online.textContent = cnt != null ? (cnt + ' at the table') : '';
      if (built && els.online) els.online.textContent = cnt != null ? (cnt + ' at the table') : '—';
    }
    function applyState(isOpenNow) {
      c.is_open = isOpenNow;
      pill.textContent = isOpenNow ? 'Open' : 'Closed';
      pill.classList.remove('open', 'closed'); pill.classList.add(isOpenNow ? 'open' : 'closed');
      var he = node.querySelector('.card-head .card-enter');
      if (he) { if (isGm || isOpenNow) he.setAttribute('href', '/game.html?campaign=' + c.id); }
      if (built) { refreshHead(); syncFields(); }
    }

    var ctrl = {
      id: c.id, node: node,
      open: open,
      requestCollapse: requestCollapse,
      collapse: collapse,
      applyPresence: applyPresence,
      applyState: applyState,
      isGm: function () { return isGm; },
    };
    return ctrl;
  }

  // Per-card Overview/Members tabs (each card has its own, so we wire on the
  // node rather than by global id).
  function wireCardTabs(node) {
    var tabs = [node.querySelector('.cd-tab-ov'), node.querySelector('.cd-tab-mem')];
    var panels = [node.querySelector('.cd-ov'), node.querySelector('.cd-mem')];
    function select(idx, focusIt) {
      tabs.forEach(function (t, i) {
        var on = i === idx;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.setAttribute('tabindex', on ? '0' : '-1');
        if (on) panels[i].removeAttribute('hidden'); else panels[i].setAttribute('hidden', '');
      });
      if (focusIt && tabs[idx].focus) tabs[idx].focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i, false); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select((i + 1) % tabs.length, true); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select((i - 1 + tabs.length) % tabs.length, true); }
        else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
        else if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
      });
    });
    return { select: select };
  }

  function wirePwToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
      var showing = input.getAttribute('type') === 'password';
      input.setAttribute('type', showing ? 'text' : 'password');
      btn.setAttribute('aria-pressed', showing ? 'true' : 'false');
      btn.textContent = showing ? 'Hide' : 'Show';
    });
  }

  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  // Global overlay wiring: click the scrim or press Escape to close the open
  // card (routes through requestCollapse so the unsaved-guard still applies).
  function initCardOverlay() {
    var scrim = $('cardOverlayScrim');
    if (scrim) scrim.addEventListener('click', function () { if (openController) openController.requestCollapse(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openController) { e.preventDefault(); openController.requestCollapse(); }
    });
  }

  // ── Recently deleted ───────────────────────────────────────────────────────
  function loadDeleted() {
    api('GET', '/api/campaigns/deleted').then(function (r) {
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.campaigns)) { hide('deletedWrap'); return; }
      renderDeleted(r.data.campaigns);
    }).catch(function () { hide('deletedWrap'); });
  }

  function renderDeleted(rows) {
    var wrap = $('deletedWrap');
    var list = $('deletedList');
    var toggle = $('deletedToggle');
    if (!wrap || !list || !toggle) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!rows.length) { wrap.setAttribute('hidden', ''); return; }
    wrap.removeAttribute('hidden');
    toggle.textContent = 'Recently deleted (' + rows.length + ')';
    rows.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'deleted-row';
      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.name || '(untitled)';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var until = c.deleted_at ? new Date(new Date(c.deleted_at).getTime() + 30 * 86400000).toISOString() : null;
      meta.textContent = 'deleted ' + fmtDate(c.deleted_at) + (until ? (' · restorable until ' + fmtDate(until)) : '');
      left.appendChild(name); left.appendChild(meta);
      var btn = document.createElement('button');
      btn.className = 'btn secondary small';
      btn.type = 'button';
      btn.textContent = 'Restore';
      btn.addEventListener('click', function () {
        withPending(btn, function () {
          return api('POST', '/api/campaigns/' + c.id + '/restore').then(function (rr) {
            if (rr.status === 200) { loadList(); loadDeleted(); }
            else { btn.textContent = 'Restore'; meta.textContent = serverError(rr); }
          }).catch(function () { meta.textContent = NETWORK_ERROR; });
        });
      });
      row.appendChild(left); row.appendChild(btn);
      list.appendChild(row);
    });
  }

  // ── Top buttons + toggles ──────────────────────────────────────────────────
  function initButtons() {
    on('btnCreate', 'click', function () { openCreate(this); });
    on('btnFind', 'click', function () { openFind(this, false); });
    on('showArchived', 'change', loadList);
    var ec = document.querySelector('[data-empty-create]');
    if (ec) ec.addEventListener('click', function () { openCreate(this); });
    var ef = document.querySelector('[data-empty-find]');
    if (ef) ef.addEventListener('click', function () { openFind(this, false); });
    on('deletedToggle', 'click', function () {
      var list = $('deletedList');
      var expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      if (list) { if (expanded) list.setAttribute('hidden', ''); else list.removeAttribute('hidden'); }
    });
    // Password field show/hide toggles across all dialogs.
    var toggles = document.querySelectorAll('.pw-toggle');
    for (var i = 0; i < toggles.length; i++) {
      (function (el) {
        el.addEventListener('click', function () {
          var targetId = el.getAttribute('aria-controls');
          var input = targetId ? $(targetId) : null;
          if (!input) return;
          var showing = input.getAttribute('type') === 'password';
          input.setAttribute('type', showing ? 'text' : 'password');
          el.setAttribute('aria-pressed', showing ? 'true' : 'false');
          el.textContent = showing ? 'Hide' : 'Show';
        });
      })(toggles[i]);
    }
  }

  // Visibility <select> → reveal/hide the matching password field.
  function bindVisibilityToggle(selectId, fieldId) {
    var sel = $(selectId);
    if (!sel) return;
    var apply = function () {
      if (sel.value === 'private') show(fieldId); else hide(fieldId);
    };
    sel.addEventListener('change', apply);
    apply();
  }

  // ── Create dialog ──────────────────────────────────────────────────────────
  function initCreate() {
    bindVisibilityToggle('crVis', 'crPasswordField');
    var form = $('formCreate');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var isPublic = $('crVis').value === 'public';
      var body = {
        name: $('crName').value,
        description: $('crDesc').value,
        is_public: isPublic,
      };
      if (!isPublic) body.password = $('crPassword').value;
      setText('crStatus', '');
      withPending($('crSubmit'), function () {
        return api('POST', '/api/campaigns', body).then(function (r) {
          if (r.status === 201 && r.data && (r.data.id || (r.data.campaign && r.data.campaign.id))) {
            var id = r.data.id || r.data.campaign.id;
            C.closeDialog($('createDialog'));
            resetCreate();
            // Reload, then expand the new card so its Overview (with the cover
            // picker) is right there — the "add a cover now" flow, inline.
            loadList(function () { expandCardById(id); });
          } else {
            setText('crStatus', serverError(r));
          }
        }).catch(function () { setText('crStatus', NETWORK_ERROR); });
      });
    });
  }
  function resetCreate() {
    var f = $('formCreate'); if (f) f.reset();
    hide('crPasswordField'); setText('crStatus', '');
  }
  function openCreate(invoker) {
    resetCreate();
    bindVisibilityToggle('crVis', 'crPasswordField'); // re-apply after reset
    C.openDialog($('createDialog'), { invoker: invoker, focus: $('crName') });
  }

  // ── Find dialog (search + join-by-link) ────────────────────────────────────
  // A small themed dropdown that stands in for a native <select> so its open
  // option list matches the site. Writes the chosen value into a hidden input of
  // the same id, so every reader of $('fdVis').value keeps working. Accessible:
  // button + role=listbox, arrow/Enter/Escape keys, outside-click to close.
  var ddSeq = 0;
  function initDropdown(ddRef, options) {
    var dd = (typeof ddRef === 'string') ? $(ddRef) : ddRef; if (!dd) return;
    var btn = dd.querySelector('.vtt-dd-btn');
    var list = dd.querySelector('.vtt-dd-list');
    var hidden = dd.querySelector('input[type="hidden"]');
    if (!btn || !list || !hidden) return;
    var optBase = (typeof ddRef === 'string' ? ddRef : ('vttdd' + (++ddSeq)));
    var activeIdx = 0;

    function currentIdx() {
      for (var i = 0; i < options.length; i++) { if (options[i].value === hidden.value) return i; }
      return 0;
    }
    function render() {
      while (list.firstChild) list.removeChild(list.firstChild);
      options.forEach(function (opt, i) {
        var li = document.createElement('li');
        li.className = 'vtt-dd-opt';
        li.setAttribute('role', 'option');
        li.id = optBase + '-opt-' + i;
        li.textContent = opt.label;
        if (opt.value === hidden.value) li.setAttribute('aria-selected', 'true');
        if (i === activeIdx) li.setAttribute('data-active', 'true');
        li.addEventListener('click', function () { choose(i); });
        li.addEventListener('mousemove', function () { setActive(i); });
        list.appendChild(li);
      });
    }
    function setActive(i) {
      activeIdx = i;
      var opts = list.querySelectorAll('.vtt-dd-opt');
      for (var k = 0; k < opts.length; k++) {
        if (k === i) opts[k].setAttribute('data-active', 'true'); else opts[k].removeAttribute('data-active');
      }
      if (opts[i]) { list.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView({ block: 'nearest' }); }
    }
    function isOpen() { return dd.getAttribute('data-open') === 'true'; }
    function positionList() {
      var r = btn.getBoundingClientRect();
      list.style.width = r.width + 'px';
      list.style.left = r.left + 'px';
      // Prefer opening downward; if there isn't room below, open upward instead.
      var belowRoom = window.innerHeight - r.bottom;
      var listH = list.offsetHeight || 0;
      if (belowRoom < listH + 8 && r.top > belowRoom) {
        list.style.top = ''; list.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      } else {
        list.style.bottom = ''; list.style.top = (r.bottom + 4) + 'px';
      }
    }
    function open() {
      dd.setAttribute('data-open', 'true');
      btn.setAttribute('aria-expanded', 'true');
      list.removeAttribute('hidden');
      activeIdx = currentIdx();
      render(); setActive(activeIdx);
      positionList();
      document.addEventListener('mousedown', onOutside, true);
      window.addEventListener('scroll', positionList, true);
      window.addEventListener('resize', positionList);
    }
    function close() {
      dd.setAttribute('data-open', 'false');
      btn.setAttribute('aria-expanded', 'false');
      list.setAttribute('hidden', '');
      document.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('scroll', positionList, true);
      window.removeEventListener('resize', positionList);
    }
    function choose(i) {
      var opt = options[i]; if (!opt) return;
      hidden.value = opt.value;
      dd.setAttribute('data-value', opt.value);
      btn.textContent = opt.label;
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      close(); btn.focus();
    }
    function onOutside(e) { if (!dd.contains(e.target)) close(); }

    btn.addEventListener('click', function () { isOpen() ? close() : open(); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        if (!isOpen()) { e.preventDefault(); open(); return; }
      }
    });
    list.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, options.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIdx); }
      else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
      else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    });
    // Keyboard flows to the list once open; make it focusable target.
    btn.addEventListener('keydown', function (e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && isOpen()) { e.preventDefault(); list.focus(); setActive(activeIdx); }
    });

    // Initial label reflects the starting value.
    var init = options[currentIdx()];
    if (init) btn.textContent = init.label;

    // Small API so callers can drive the value programmatically (e.g. sync/revert).
    return {
      set: function (value) {
        hidden.value = value; dd.setAttribute('data-value', value);
        var i = currentIdx(); if (options[i]) btn.textContent = options[i].label;
      },
      get: function () { return hidden.value; }
    };
  }

  function initFind() {
    initDropdown('fdVisDD', [
      { value: 'all', label: 'All games' },
      { value: 'public', label: 'Open to anyone' },
      { value: 'private', label: 'Password-protected' }
    ]);
    on('fdMore', 'click', loadMoreResults);
    var find = $('formFind');
    if (find) {
      find.addEventListener('submit', function (e) {
        e.preventDefault();
        doSearch();
      });
    }
    var joinForm = $('formJoin');
    if (joinForm) {
      joinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        doJoinById($('jnId').value, $('jnPassword').value, $('jnStatus'), function () {
          C.closeDialog($('findDialog'));
          selectTab('tabPlaying');
          loadList();
        });
      });
    }
    // If we arrived via ?join=, open on the join face now.
    if (pendingJoinId) {
      openFind($('btnFind'), true, pendingJoinId);
      pendingJoinId = null;
    }
  }

  function openFind(invoker, joinFace, joinId) {
    var join = $('formJoin');
    var find = $('formFind');
    setText('fdStatus', ''); setText('jnStatus', '');
    hide('jnPasswordField');
    if (joinFace) {
      if (join) join.removeAttribute('hidden');
      if (find) find.setAttribute('hidden', '');
      var jn = $('jnId');
      if (jn) { jn.value = joinId || ''; jn.setAttribute('readonly', ''); }
      C.openDialog($('findDialog'), { invoker: invoker, focus: $('jnPassword') });
    } else {
      if (join) join.setAttribute('hidden', '');
      if (find) find.removeAttribute('hidden');
      var results = $('fdResults'); if (results) while (results.firstChild) results.removeChild(results.firstChild);
      hide('fdMore');
      refreshMyMemberships();   // so results can show "Already joined"
      C.openDialog($('findDialog'), { invoker: invoker, focus: $('fdQuery') });
    }
  }

  var SEARCH_PAGE = 20;              // matches the server's default limit
  var searchState = { q: '', vis: 'all', offset: 0 };

  // For labelling search results. The server is always the authority on both of
  // these — a Join click is still validated there — but knowing them lets the
  // list show "Already joined" / "Full" instead of a Join that will just fail.
  //   • myCampaignIds: the games I'm already in, refreshed when Find opens.
  //   • FULL_AT: mirrors MAX_PLAYERS_PER_CAMPAIGN (8, incl. GM) in campaigns.js.
  //     If that env-overridable cap ever changes, update this one line; a stale
  //     value only mislabels a card, it can't let anyone over the real cap.
  var myCampaignIds = {};
  var myMembershipsPromise = null;
  var FULL_AT = 8;

  function refreshMyMemberships() {
    myMembershipsPromise = api('GET', '/api/campaigns/mine?role=all&filter=all').then(function (r) {
      if (r.status === 200 && r.data && Array.isArray(r.data.campaigns)) {
        var ids = {};
        r.data.campaigns.forEach(function (c) { ids[c.id] = true; });
        myCampaignIds = ids;
      }
    }).catch(function () { /* non-fatal: labels just fall back to Join */ });
    return myMembershipsPromise;
  }

  function doSearch() {
    // A fresh search: reset paging and clear the list.
    searchState.q = $('fdQuery').value;
    searchState.vis = $('fdVis').value;
    searchState.offset = 0;
    var box = $('fdResults');
    if (box) while (box.firstChild) box.removeChild(box.firstChild);
    hide('fdMore');
    setText('fdStatus', 'Searching…');
    // Wait for my membership set (loaded when the modal opened) so results can be
    // labelled "Already joined" on the first paint rather than after a flicker.
    var ready = myMembershipsPromise || refreshMyMemberships();
    ready.then(function () { fetchSearchPage($('fdSubmit'), true); });
  }

  function loadMoreResults() {
    fetchSearchPage($('fdMore'), false);
  }

  function fetchSearchPage(pendingBtn, isFirst) {
    var url = '/api/campaigns/search?q=' + encodeURIComponent(searchState.q)
      + '&visibility=' + encodeURIComponent(searchState.vis)
      + '&limit=' + SEARCH_PAGE + '&offset=' + searchState.offset;
    return withPending(pendingBtn, function () {
      return api('GET', url).then(function (r) {
        if (r.status !== 200 || !r.data || !Array.isArray(r.data.campaigns)) {
          setText('fdStatus', serverError(r));
          return;
        }
        var rows = r.data.campaigns;
        if (isFirst) {
          setText('fdStatus', '');
          if (!rows.length) {
            var box = $('fdResults');
            if (box) {
              var empty = document.createElement('p');
              empty.className = 'find-empty';
              empty.textContent = 'No games match your search.';
              box.appendChild(empty);
            }
          }
        }
        appendResults(rows);
        searchState.offset += rows.length;
        // A full page implies there may be more; a short page means we're done.
        if (rows.length === SEARCH_PAGE) show('fdMore'); else hide('fdMore');
      }).catch(function () { setText('fdStatus', NETWORK_ERROR); });
    });
  }

  function renderResults(rows) {
    var box = $('fdResults');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    appendResults(rows);
  }

  function appendResults(rows) {
    var box = $('fdResults');
    if (!box) return;
    rows.forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'find-card';
      card.setAttribute('data-id', c.id);

      // Cover thumbnail, or the d20 mask when there's none.
      var thumb = document.createElement('span');
      thumb.className = 'find-thumb mask';
      if (c.img_url) {
        thumb.classList.remove('mask');
        var timg = document.createElement('img');
        timg.src = c.img_url; timg.alt = ''; timg.loading = 'lazy';
        thumb.appendChild(timg);
      }
      card.appendChild(thumb);

      var body = document.createElement('div');
      body.className = 'find-body';
      var name = document.createElement('span');
      name.className = 'find-name';
      name.textContent = c.name || '(untitled)';
      body.appendChild(name);
      if (c.owner_username) {
        var owner = document.createElement('span');
        owner.className = 'find-owner';
        owner.textContent = 'by ' + c.owner_username;
        body.appendChild(owner);
      }
      // Tags: only a password-required game shows a lock tag — open games show
      // nothing (their openness is the default, so it needs no label). Member
      // count, when known, sits alongside.
      var tags = document.createElement('span');
      tags.className = 'find-tags';
      if (!c.is_public) {
        var lock = document.createElement('span');
        lock.className = 'find-lock';
        lock.textContent = 'Password';
        tags.appendChild(lock);
      }
      if (typeof c.member_count === 'number') {
        var count = document.createElement('span');
        count.className = 'find-count';
        count.textContent = c.member_count + (c.member_count === 1 ? ' member' : ' members');
        tags.appendChild(count);
      }
      if (tags.childNodes.length) body.appendChild(tags);
      card.appendChild(body);

      var actions = document.createElement('div');
      actions.className = 'find-actions';

      var alreadyMember = !!myCampaignIds[c.id];
      var isFull = typeof c.member_count === 'number' && c.member_count >= FULL_AT;

      if (alreadyMember) {
        // Already in this game — no Join, just a quiet status.
        var joined = document.createElement('span');
        joined.className = 'find-state';
        joined.textContent = 'Already joined';
        actions.appendChild(joined);
      } else if (isFull) {
        // At capacity — a Join would only get a 409, so say so, in red.
        var full = document.createElement('span');
        full.className = 'find-state full';
        full.textContent = 'Full';
        actions.appendChild(full);
      } else {
        // Private campaigns reveal an inline password field on first Join click.
        var pwInput = null;
        if (!c.is_public) {
          pwInput = document.createElement('input');
          pwInput.type = 'password';
          pwInput.placeholder = 'Password';
          pwInput.setAttribute('aria-label', 'Campaign password');
          pwInput.setAttribute('hidden', '');
          actions.appendChild(pwInput);
        }
        var joinBtn = document.createElement('button');
        joinBtn.className = 'btn primary small';
        joinBtn.type = 'button';
        joinBtn.textContent = 'Join';
        var revealed = false;
        joinBtn.addEventListener('click', function () {
          if (pwInput && !revealed) { pwInput.removeAttribute('hidden'); pwInput.focus(); revealed = true; return; }
          var pw = pwInput ? pwInput.value : undefined;
          doJoinById(c.id, pw, $('fdStatus'), function () {
            C.closeDialog($('findDialog'));
            selectTab('tabPlaying');
            loadList();
          });
        });
        actions.appendChild(joinBtn);
      }
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function doJoinById(id, password, statusEl, onOk) {
    if (statusEl) statusEl.textContent = '';
    var body = {};
    if (password !== undefined && password !== '') body.password = password;
    return api('POST', '/api/campaigns/' + id + '/join', body).then(function (r) {
      if (r.status === 200 || r.status === 201) { if (onOk) onOk(); return; }
      if (r.status === 401) {
        // Private campaign wants a password — reveal the join-face field.
        if (statusEl && statusEl.id === 'jnStatus') { show('jnPasswordField'); }
        if (statusEl) statusEl.textContent = serverError(r);
        return;
      }
      if (statusEl) statusEl.textContent = serverError(r);
    }).catch(function () { if (statusEl) statusEl.textContent = NETWORK_ERROR; });
  }

  // ── Profile dialog ─────────────────────────────────────────────────────────
  // ── Account (ID card): inline edit, one Save routing to the right endpoints,
  //    and an unsaved-guard on close. ────────────────────────────────────────
  var pfDirty = false;

  function initProfile() {
    on('profileBtn', 'click', function () { openProfile(this); });
    on('pfLogout', 'click', function () {
      api('POST', '/api/auth/logout').then(function () { C.navigate('/'); }).catch(function () { C.navigate('/'); });
    });

    // Name: Change toggles the value text into an in-place input (no dropdown).
    on('pfUsernameBtn', 'click', function () {
      var input = $('pfNameInput'), text = $('pfUsername'), help = $('pfNameHelp'), btn = $('pfUsernameBtn');
      var editing = !input.hasAttribute('hidden');
      C.animateResize(pfCard(), function () {
        if (editing) {
          // Closing without saving: revert to the saved value, drop the change.
          input.value = (me && me.username) || '';
          input.setAttribute('hidden', ''); text.removeAttribute('hidden');
          if (help) help.setAttribute('hidden', ''); btn.classList.remove('active'); btn.textContent = 'Change';
        } else {
          closeOtherEditors('name');           // accordion: collapse + clear others
          text.setAttribute('hidden', ''); input.removeAttribute('hidden');
          if (help) help.removeAttribute('hidden'); btn.classList.add('active'); btn.textContent = 'Cancel';
        }
      });
      recomputePfDirty();
      if (!editing && input.focus) { input.focus(); input.select && input.select(); }
    });

    // Email / password: Change toggles the revealed inputs.
    wireRevealToggle('pfEmailBtn', 'pfEmailEdit', 'emNew');
    wireRevealToggle('pfPasswordBtn', 'pfPasswordEdit', 'pwCurrent');

    // Photo: click the framed image to open the image picker directly. The
    // chosen URL is written to the hidden avatar input, which marks the card
    // dirty (via the input event) exactly as typing would.
    on('pfAvatarBtn', 'click', function () {
      if (!window.VTTImagePicker) return;
      window.VTTImagePicker.open({
        kind: 'avatar', campaignId: null,
        current: (me && me.avatar_url) || ($('pfAvatarInput') && $('pfAvatarInput').value) || null,
        onChoose: function (url) {
          var i = $('pfAvatarInput');
          if (i) { i.value = url; i.dispatchEvent(new Event('input', { bubbles: true })); }
          // Live-update the portrait so the choice is visible immediately.
          previewAvatar(url);
        }
      });
    });

    // Any input recomputes whether a save is possible — Save shows only when a
    // change is actually complete (name/avatar changed, or a full email/password
    // pair filled), and hides again if the fields are cleared back out.
    ['pfNameInput', 'pfAvatarInput', 'emNew', 'emPassword', 'pwCurrent', 'pwNew'].forEach(function (id) {
      var el = $(id);
      if (el) ['input', 'change'].forEach(function (ev) { el.addEventListener(ev, recomputePfDirty); });
    });

    on('pfSaveBtn', 'click', function () { savePf(); });

    // Unsaved-guard: intercept the dialog's close paths (✕ / backdrop / Esc) in
    // the CAPTURE phase, before common.js's own close listeners run, so a dirty
    // card prompts Save/Discard/Keep editing instead of silently discarding.
    var dlg = $('profileDialog');
    if (dlg) {
      dlg.addEventListener('click', function (e) {
        var onClose = e.target === dlg || (e.target.closest && e.target.closest('[data-close]'));
        if (onClose && pfDirty) {
          e.preventDefault(); e.stopPropagation();
          requestCloseProfile(function () { C.closeDialog(dlg); });
        }
      }, true);
      dlg.addEventListener('cancel', function (e) {
        // Let the image picker consume its own Esc (handled by common.js).
        if (window.VTTImagePicker && typeof window.VTTImagePicker.isOpen === 'function' && window.VTTImagePicker.isOpen()) return;
        if (pfDirty) {
          e.preventDefault(); e.stopPropagation();
          requestCloseProfile(function () { C.closeDialog(dlg); });
        }
      }, true);
    }
  }

  function pfCard() { var d = $('profileDialog'); return d ? d.querySelector('.idcard') : null; }

  function wireRevealToggle(btnId, editId, focusId) {
    on(btnId, 'click', function () {
      var ed = $(editId), btn = $(btnId);
      if (!ed) return;
      var open = !ed.hasAttribute('hidden');
      var which = (editId === 'pfEmailEdit') ? 'email' : 'password';
      C.animateResize(pfCard(), function () {
        if (open) {
          // Closing without saving: clear this editor's fields.
          collapsePfEditor(which);
        } else {
          closeOtherEditors(which);            // accordion: collapse + clear others
          ed.removeAttribute('hidden');
          if (btn) { btn.classList.add('active'); btn.textContent = 'Cancel'; }
        }
      });
      recomputePfDirty();
      if (!open) { var f = $(focusId); if (f && f.focus) f.focus(); }
    });
  }

  function markPfDirty() { if (!pfDirty) { pfDirty = true; var b = $('pfSaveBtn'); if (b) b.removeAttribute('hidden'); } }
  function clearPfDirty() {
    pfDirty = false;
    var b = $('pfSaveBtn'); if (b) b.setAttribute('hidden', '');
  }

  // Recompute dirty from scratch: something is pending only if the name differs
  // from the saved value, a new avatar was chosen, or any email/password field
  // has content. Used after collapsing an editor whose fields we've just cleared,
  // so Save disappears if that was the only pending change.
  function pfHasPending() {
    if (!me) return false;
    var name = $('pfNameInput') ? $('pfNameInput').value : (me.username || '');
    var avatar = $('pfAvatarInput') ? $('pfAvatarInput').value : (me.avatar_url || '');
    if (name !== (me.username || '')) return true;
    if (avatar !== (me.avatar_url || '')) return true;
    // A change of email or password is "pending" only once BOTH of its fields
    // are filled — a lone current-password (or a lone new value) can't be saved,
    // so Save stays hidden until the pair is complete.
    var val = function (id) { var e = $(id); return e ? e.value : ''; };
    if (val('emNew') && val('emPassword')) return true;
    if (val('pwCurrent') && val('pwNew')) return true;
    return false;
  }
  function recomputePfDirty() { if (pfHasPending()) markPfDirty(); else clearPfDirty(); }

  // The three inline editors form an accordion — opening one collapses the
  // others and CLEARS their unsaved fields (name reverts to the saved value;
  // email/password fields blank). `keep` is the editor id being opened.
  var PF_EDITORS = {
    name: { edit: null, btn: 'pfUsernameBtn' },     // in-place
    email: { edit: 'pfEmailEdit', btn: 'pfEmailBtn' },
    password: { edit: 'pfPasswordEdit', btn: 'pfPasswordBtn' }
  };
  function pfEditorOpen(which) {
    if (which === 'name') return $('pfNameInput') && !$('pfNameInput').hasAttribute('hidden');
    var e = $(PF_EDITORS[which].edit); return e && !e.hasAttribute('hidden');
  }
  function collapsePfEditor(which) {
    if (which === 'name') {
      var input = $('pfNameInput'), text = $('pfUsername'), help = $('pfNameHelp'), btn = $('pfUsernameBtn');
      if (input) { input.value = (me && me.username) || ''; input.setAttribute('hidden', ''); } // revert
      if (text) text.removeAttribute('hidden');
      if (help) help.setAttribute('hidden', '');
      if (btn) { btn.classList.remove('active'); btn.textContent = 'Change'; }
    } else {
      var ed = $(PF_EDITORS[which].edit), b = $(PF_EDITORS[which].btn);
      if (ed) ed.setAttribute('hidden', '');
      if (b) { b.classList.remove('active'); b.textContent = 'Change'; }
      // Clear the abandoned fields + any per-editor status.
      if (which === 'email') { ['emNew', 'emPassword'].forEach(function (id) { var e = $(id); if (e) e.value = ''; }); setText('emStatus', ''); }
      if (which === 'password') { ['pwCurrent', 'pwNew'].forEach(function (id) { var e = $(id); if (e) e.value = ''; }); setText('pwStatus', ''); }
    }
  }
  function closeOtherEditors(keep) {
    Object.keys(PF_EDITORS).forEach(function (which) {
      if (which !== keep && pfEditorOpen(which)) collapsePfEditor(which);
    });
  }
  // Collapse every editor (used after a successful save).
  function collapsePfEditors() {
    Object.keys(PF_EDITORS).forEach(function (which) {
      if (pfEditorOpen(which)) collapsePfEditor(which);
    });
  }

  // Render a URL (or the d20 fallback) into the portrait immediately.
  function previewAvatar(url) {
    var av = $('pfAvatar');
    if (!av) return;
    while (av.firstChild) av.removeChild(av.firstChild);
    av.classList.remove('mask');
    if (url) { var img = document.createElement('img'); img.src = url; img.alt = ''; av.appendChild(img); }
    else av.classList.add('mask');
  }

  // Mask an email for display: keep the first and last character of the username
  // and of the first domain label, replacing each hidden character with one
  // asterisk, and leave the rest of the domain (the TLD, any subdomain tail)
  // visible. e.g. test@google.com -> t**t@g****e.com. Parts of 1-2 chars have no
  // maskable middle and are left as-is.
  function maskPart(s) {
    if (s.length <= 2) return s;
    return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  }
  function maskEmail(email) {
    var at = email.lastIndexOf('@');
    if (at < 1) return email;                       // not an address shape — leave it
    var user = email.slice(0, at);
    var domain = email.slice(at + 1);
    var dot = domain.indexOf('.');
    if (dot < 1) return maskPart(user) + '@' + maskPart(domain);
    var label = domain.slice(0, dot);
    var rest = domain.slice(dot);                   // includes the leading dot(s)/TLD
    return maskPart(user) + '@' + maskPart(label) + rest;
  }

  function fillProfile() {
    if (!me) return;
    previewAvatar(me.avatar_url || '');
    setText('pfUsername', me.username || '');
    setText('pfEmail', maskEmail(me.email || ''));
    var vf = $('pfVerified');
    if (vf) { vf.textContent = me.email_verified ? 'Verified' : 'Unverified'; vf.classList.toggle('verified', !!me.email_verified); }
    if ($('pfNameInput')) $('pfNameInput').value = me.username || '';
    if ($('pfAvatarInput')) $('pfAvatarInput').value = me.avatar_url || '';
  }

  // Collapse all inline editors and reset transient fields.
  function resetPfEditors() {
    // Name: collapse the in-place input back to text.
    var ni = $('pfNameInput'), nt = $('pfUsername'), nh = $('pfNameHelp'), nb = $('pfUsernameBtn');
    if (ni) ni.setAttribute('hidden', ''); if (nt) nt.removeAttribute('hidden');
    if (nh) nh.setAttribute('hidden', ''); if (nb) { nb.classList.remove('active'); nb.textContent = 'Change'; }
    // Email / password / avatar: collapse reveals + reset their Change buttons.
    [['pfEmailEdit', 'pfEmailBtn'], ['pfPasswordEdit', 'pfPasswordBtn']].forEach(function (pair) {
      var e = $(pair[0]), b = $(pair[1]);
      if (e) e.setAttribute('hidden', '');
      if (b) { b.classList.remove('active'); b.textContent = 'Change'; }
    });
    // Avatar: revert the hidden input + portrait to the saved value.
    if ($('pfAvatarInput')) $('pfAvatarInput').value = (me && me.avatar_url) || '';
    previewAvatar((me && me.avatar_url) || '');
    ['emNew', 'emPassword', 'pwCurrent', 'pwNew'].forEach(function (id) { var e = $(id); if (e) e.value = ''; });
    setText('pfStatus', ''); setText('pwStatus', ''); setText('emStatus', '');
  }

  function openProfile(invoker) {
    fillProfile();
    resetPfEditors();
    clearPfDirty();
    // Open with nothing focused inside (no field pre-selected) — focus the card.
    C.openDialog($('profileDialog'), { invoker: invoker, focus: $('pfHeading') });
  }

  // Save whatever changed, across the relevant endpoints. Username/avatar go to
  // PATCH /me; a filled new-email goes to change-email; a filled new-password to
  // change-password. done(ok) fires after all attempted calls settle.
  function savePf(done) {
    var tasks = [];
    var anyErr = false;

    // Profile (username/avatar) — only if changed from `me`.
    var newName = $('pfNameInput') ? $('pfNameInput').value : (me && me.username);
    var newAvatar = $('pfAvatarInput') ? $('pfAvatarInput').value : (me && me.avatar_url);
    if (me && (newName !== (me.username || '') || newAvatar !== (me.avatar_url || ''))) {
      tasks.push(api('PATCH', '/api/auth/me', { username: newName, avatar_url: newAvatar }).then(function (r) {
        if (r.status === 200 && r.data && r.data.user) { me = r.data.user; renderHeader(); fillProfile(); loadList(); }
        else { anyErr = true; setText('pfStatus', serverError(r)); }
      }).catch(function () { anyErr = true; setText('pfStatus', NETWORK_ERROR); }));
    }

    // Email — only if a new email was entered. Needs the current password to
    // confirm; check locally so the message is natural and no doomed request goes.
    var emNew = $('emNew') ? $('emNew').value : '';
    if (emNew) {
      var emPw = $('emPassword') ? $('emPassword').value : '';
      if (!emPw) { anyErr = true; setText('emStatus', 'Please enter your current password to change your email.'); }
      else tasks.push(api('POST', '/api/auth/change-email', { newEmail: emNew, currentPassword: emPw }).then(function (r) {
        setText('emStatus', (r.data && r.data.message) || serverError(r));
        if (r.status !== 200) anyErr = true; else { if ($('emNew')) $('emNew').value = ''; if ($('emPassword')) $('emPassword').value = ''; }
      }).catch(function () { anyErr = true; setText('emStatus', NETWORK_ERROR); }));
    }

    // Password — only if a new password was entered. Needs the current password.
    var pwNew = $('pwNew') ? $('pwNew').value : '';
    if (pwNew) {
      var pwCur = $('pwCurrent') ? $('pwCurrent').value : '';
      if (!pwCur) { anyErr = true; setText('pwStatus', 'Please enter your current password to set a new one.'); }
      else tasks.push(api('POST', '/api/auth/change-password', { currentPassword: pwCur, newPassword: pwNew }).then(function (r) {
        if (r.status === 200) { setText('pwStatus', (r.data && r.data.message) || 'Password changed.'); if ($('pwCurrent')) $('pwCurrent').value = ''; if ($('pwNew')) $('pwNew').value = ''; }
        else { anyErr = true; setText('pwStatus', serverError(r)); }
      }).catch(function () { anyErr = true; setText('pwStatus', NETWORK_ERROR); }));
    }

    // A local validation error with no actual request still needs feedback.
    if (!tasks.length) {
      if (anyErr) { if (done) done(false); return; }
      clearPfDirty(); if (done) done(true); return;
    }

    var btn = $('pfSaveBtn');
    withPending(btn, function () {
      return Promise.all(tasks).then(function () {
        if (!anyErr) {
          // Success: collapse every editor back to its display form — Save was
          // the commit, so there's no separate "Done" step.
          collapsePfEditors();
          setText('pfStatus', 'Saved.'); clearPfDirty();
        }
        if (done) done(!anyErr);
      });
    });
  }

  // Guard the profile dialog's close paths (Esc / backdrop / ✕) when dirty.
  function requestCloseProfile(proceed) {
    if (!pfDirty) { proceed(); return; }
    confirmThreeWay(
      'Unsaved changes',
      'You have unsaved changes to your account. Save them before closing?',
      'Save', 'Discard', 'Keep editing',
      function () { savePf(function (ok) { if (ok) { proceed(); } }); },
      function () { clearPfDirty(); proceed(); }
    );
  }

  // ── Confirm dialog (opened over another dialog / inline card) ──────────────
  var confirmCb = null;       // primary (OK / Save)
  var confirmThirdCb = null;  // third (Discard), null for 2-way
  function initConfirm() {
    on('cfCancel', 'click', function () { C.closeDialog($('confirmDialog')); confirmCb = null; confirmThirdCb = null; });
    on('cfOk', 'click', function () {
      var cb = confirmCb; confirmCb = null; confirmThirdCb = null;
      C.closeDialog($('confirmDialog'));
      if (cb) cb();
    });
    on('cfThird', 'click', function () {
      var cb = confirmThirdCb; confirmCb = null; confirmThirdCb = null;
      C.closeDialog($('confirmDialog'));
      if (cb) cb();
    });
  }
  function confirmThen(title, body, danger, cb) {
    setText('cfTitle', title);
    setText('cfBody', body);
    var ok = $('cfOk');
    if (ok) { ok.classList.remove('danger', 'primary'); ok.classList.add(danger ? 'danger' : 'primary'); ok.textContent = 'OK'; }
    var third = $('cfThird');
    if (third) third.setAttribute('hidden', '');   // 2-way: hide the third button
    var cancel = $('cfCancel'); if (cancel) cancel.textContent = 'Cancel';
    confirmCb = cb; confirmThirdCb = null;
    C.openDialog($('confirmDialog'), { invoker: document.activeElement, focus: $('cfCancel') });
  }
  // Three choices: primary (okLabel→onOk), secondary (thirdLabel→onThird), and
  // Cancel (cancelLabel→dismiss). Used for the unsaved-edits guard
  // (Save / Discard / Keep editing).
  function confirmThreeWay(title, body, okLabel, thirdLabel, cancelLabel, onOk, onThird) {
    setText('cfTitle', title);
    setText('cfBody', body);
    var ok = $('cfOk');
    if (ok) { ok.classList.remove('danger'); ok.classList.add('primary'); ok.textContent = okLabel || 'OK'; }
    var third = $('cfThird');
    if (third) { third.textContent = thirdLabel || 'Discard'; third.removeAttribute('hidden'); }
    var cancel = $('cfCancel'); if (cancel) cancel.textContent = cancelLabel || 'Cancel';
    confirmCb = onOk; confirmThirdCb = onThird;
    C.openDialog($('confirmDialog'), { invoker: document.activeElement, focus: $('cfCancel') });
  }

  // ── Tab selection helper (list strip) ──────────────────────────────────────
  function selectTab(tabId) {
    var strip = $('listTabs');
    if (strip && strip._select) strip._select(tabId);
  }

  // ── Lobby socket ────────────────────────────────────────────────────────
  // REST already populated the list; the socket only layers on presence and
  // open/closed deltas. The dashboard subscribes to lobby rooms (derived
  // server-side) and NEVER emits campaign:join — a dashboard viewer is not "at
  // the table". Works with or without the socket: every handler no-ops if the
  // element is gone, and the list never waited for any of this.
  var socket = null;

  function setConn(text) { setText('connState', text || ''); }

  function initLobby() {
    // If socket.io's io() isn't present, run REST-only (spec §4 boot).
    if (typeof window.io !== 'function') return;
    try { socket = window.io(); } catch (e) { socket = null; return; }
    if (!socket) return;

    socket.on('connect', function () {
      setConn('');
      // (Re)subscribe on every connect — the first connect and each reconnect.
      lobbySubscribe();
    });
    socket.on('disconnect', function () { setConn('Reconnecting…'); });
    socket.on('connect_error', function () { setConn('Reconnecting…'); });

    // Presence for one campaign: update its card (collapsed head + expanded
    // Overview via the controller). Cache the count so re-renders keep it.
    socket.on('lobby:presence', function (p) {
      if (!p || p.campaign_id == null) return;
      onlineByCampaign[p.campaign_id] = p.online;
      var ctrl = controllerFor(p.campaign_id);
      if (ctrl) ctrl.applyPresence(p.online);
    });

    // Open/closed changed elsewhere: flip the pill + Enter on the card (and its
    // expanded view if built).
    socket.on('campaign:state', function (p) {
      if (!p || p.campaign_id == null) return;
      var ctrl = controllerFor(p.campaign_id);
      if (ctrl) ctrl.applyState(p.is_open !== false);
    });

    // Kicked/banned/campaign gone: the card should disappear. Refetch the list.
    socket.on('campaign:evicted', function () { loadList(); });
  }

  function lobbySubscribe() {
    if (!socket || !socket.emit) return;
    socket.emit('lobby:subscribe', {}, function (ack) {
      if (ack && ack.ok && Array.isArray(ack.campaigns)) {
        ack.campaigns.forEach(function (c) {
          onlineByCampaign[c.campaign_id] = c.online;
          var ctrl = controllerFor(c.campaign_id);
          if (ctrl) ctrl.applyPresence(c.online);
        });
      }
    });
  }
  // Called after any list-changing mutation; re-emit is idempotent server-side.
  function lobbyResubscribe() { lobbySubscribe(); }

  function controllerFor(campaignId) {
    for (var i = 0; i < cardControllers.length; i++) {
      if (cardControllers[i].id === campaignId) return cardControllers[i];
    }
    return null;
  }

  // ── Boot on DOM ready ──────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
