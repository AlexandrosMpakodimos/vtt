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
    if (r && r.data && typeof r.data.error === 'string') return r.data.error;
    return NETWORK_ERROR;
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
  var currentCampaign = null;    // campaign object loaded in the dialog
  var currentMembers = null;     // all-status members (GM view)
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
      initCampaignDialogTabs();
      initButtons();
      initCreate();
      initFind();
      initCampaignDialog();
      initProfile();
      initConfirm();
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

  function loadList() {
    var role = tabsRole(activeTab);
    var filter = currentFilter();
    var panel = $('campaignPanel');
    if (panel) panel.setAttribute('aria-busy', 'true');
    setText('listStatus', 'Loading…');
    api('GET', '/api/campaigns/mine?role=' + role + '&filter=' + filter).then(function (r) {
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
    }).catch(function () { if (panel) panel.removeAttribute('aria-busy'); setText('listStatus', NETWORK_ERROR); });
  }

  function renderCards(campaigns) {
    var grid = $('cardsGrid');
    var tmpl = $('cardTemplate');
    if (!grid || !tmpl) return;
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!campaigns.length) {
      show('emptyState');
      return;
    }
    hide('emptyState');

    var archivedShown = currentFilter() === 'archived';
    campaigns.forEach(function (c) {
      var node = tmpl.content.firstElementChild.cloneNode(true);
      node.setAttribute('data-id', c.id);

      var isGm = c.is_gm === true;
      var st = cardState(c, isGm);

      // Cover
      var cover = node.querySelector('.card-cover');
      if (c.img_url) {
        // Replace the mask span with an <img> (attributes only, no innerHTML).
        var img = document.createElement('img');
        img.className = 'card-cover';
        img.src = c.img_url;
        img.alt = '';
        img.loading = 'lazy';
        cover.parentNode.replaceChild(img, cover);
      }

      node.querySelector('.card-name').textContent = c.name || '(untitled)';

      // Whose game it is. "by you" for games you run; the GM's name otherwise.
      var owner = node.querySelector('.card-owner');
      if (isGm) owner.textContent = 'by you';
      else if (c.owner_username) owner.textContent = 'by ' + c.owner_username;
      else owner.setAttribute('hidden', '');

      node.querySelector('.badge-role').textContent = isGm ? 'GM' : 'Player';

      var vis = node.querySelector('.badge-vis');
      vis.textContent = c.is_public ? 'Public' : 'Private';

      var pill = node.querySelector('.pill-state');
      pill.textContent = st.stateWord;
      pill.classList.add(c.is_open !== false ? 'open' : 'closed');

      var online = node.querySelector('.card-online');
      var count = onlineByCampaign[c.id];
      online.textContent = (count != null) ? (count + ' at the table') : '';

      var desc = node.querySelector('.card-desc');
      if (c.description) desc.textContent = c.description;
      else desc.setAttribute('hidden', '');

      if (c.archived) node.querySelector('.badge-archived').removeAttribute('hidden');

      var note = node.querySelector('.card-note');
      var enter = node.querySelector('.card-enter');
      if (st.showEnter) {
        enter.setAttribute('href', '/game.html?campaign=' + c.id);
      } else {
        enter.parentNode.removeChild(enter);
        note.textContent = "Closed — the GM hasn't opened the table.";
        note.removeAttribute('hidden');
      }

      node.querySelector('.card-manage').textContent = st.manageLabel;
      // Archive is per-user and open to any member (player or GM), so it lives
      // on the card where everyone can reach it — and toggles both directions,
      // so an archived card can be brought back.
      var archiveBtn = node.querySelector('.card-archive');
      archiveBtn.textContent = c.archived ? 'Unarchive' : 'Archive';
      grid.appendChild(node);
    });
  }

  // Event delegation on the grid for manage + archive.
  function initGridDelegation() {
    var grid = $('cardsGrid');
    if (!grid) return;
    grid.addEventListener('click', function (e) {
      var manage = e.target.closest && e.target.closest('.card-manage');
      if (manage) {
        var mcard = manage.closest('[data-id]');
        if (mcard) openCampaignDialog(mcard.getAttribute('data-id'), manage);
        return;
      }
      var arch = e.target.closest && e.target.closest('.card-archive');
      if (arch) {
        var acard = arch.closest('[data-id]');
        if (!acard) return;
        var id = acard.getAttribute('data-id');
        // The button's own label tells us the direction (server allows both for
        // any member; archive state is per-user).
        var toArchive = arch.textContent !== 'Unarchive';
        var path = '/api/campaigns/' + id + '/' + (toArchive ? 'archive' : 'unarchive');
        withPending(arch, function () {
          return api('POST', path).then(function (r) {
            if (r.status === 200) { loadList(); }
            else { setText('listStatus', serverError(r)); }
          }).catch(function () { setText('listStatus', NETWORK_ERROR); });
        });
        return;
      }
      // .card-enter is a real link (href set) — no JS needed; let it navigate.
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
    initGridDelegation();
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
            loadList();
            // Open the new campaign on Settings AND pop the cover picker so
            // adding an image is immediate (the two-step flow you asked for).
            openCampaignDialog(id, $('btnCreate'), { tab: 'cdTabSettings', status: 'Game created. Add a cover image, or close this to finish.', openCover: true });
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
  function initFind() {
    bindVisibilityToggle('fdVis', null); // no-op; fdVis has no password field
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
      C.openDialog($('findDialog'), { invoker: invoker, focus: $('fdQuery') });
    }
  }

  var SEARCH_PAGE = 20;              // matches the server's default limit
  var searchState = { q: '', vis: 'all', offset: 0 };

  function doSearch() {
    // A fresh search: reset paging and clear the list.
    searchState.q = $('fdQuery').value;
    searchState.vis = $('fdVis').value;
    searchState.offset = 0;
    var box = $('fdResults');
    if (box) while (box.firstChild) box.removeChild(box.firstChild);
    hide('fdMore');
    setText('fdStatus', 'Searching…');
    fetchSearchPage($('fdSubmit'), true);
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
        if (isFirst) setText('fdStatus', rows.length ? '' : 'No games found.');
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
      var row = document.createElement('div');
      row.className = 'result result-rich';
      row.setAttribute('data-id', c.id);

      // Thumbnail: the cover image, or the d20 mask when there's none.
      var thumb = document.createElement('span');
      thumb.className = 'result-thumb mask';
      if (c.img_url) {
        thumb.classList.remove('mask');
        var timg = document.createElement('img');
        timg.src = c.img_url; timg.alt = ''; timg.loading = 'lazy';
        timg.style.width = '100%'; timg.style.height = '100%'; timg.style.objectFit = 'cover'; timg.style.borderRadius = '3px';
        thumb.appendChild(timg);
      }
      row.appendChild(thumb);

      var who = document.createElement('div');
      who.className = 'who';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name || '(untitled)';
      who.appendChild(name);
      // Owner line, now that search exposes owner_username.
      if (c.owner_username) {
        var ownerLine = document.createElement('span');
        ownerLine.className = 'meta';
        ownerLine.textContent = 'by ' + c.owner_username;
        who.appendChild(ownerLine);
      }
      // Description (clamped by CSS).
      if (c.description) {
        var desc = document.createElement('p');
        desc.className = 'result-desc';
        desc.textContent = c.description;
        who.appendChild(desc);
      }
      var meta = document.createElement('span');
      meta.className = 'meta';
      var pieces = [c.is_public ? 'Public' : 'Private'];
      if (typeof c.member_count === 'number') pieces.push(c.member_count + (c.member_count === 1 ? ' member' : ' members'));
      meta.textContent = pieces.join(' · ');
      who.appendChild(meta);
      row.appendChild(who);

      var actions = document.createElement('div');
      actions.className = 'row-actions';

      // Private campaigns reveal an inline password field on first Join click.
      var pwInput = null;
      if (!c.is_public) {
        pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.placeholder = 'Password';
        pwInput.setAttribute('aria-label', 'Campaign password');
        pwInput.style.minHeight = '36px';
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
      row.appendChild(actions);
      box.appendChild(row);
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

  // ── Campaign dialog ────────────────────────────────────────────────────────
  var cdTabsStrip = null;
  function initCampaignDialogTabs() {
    cdTabsStrip = initTabs('cdTabs', null);
  }

  function initCampaignDialog() {
    on('cdClose', 'click', function () { /* handled by openDialog data-close */ });
    on('cdRefresh', 'click', function () { if (currentCampaign) loadCampaignInto(currentCampaign.id); });
    on('cdCopyInvite', 'click', copyInvite);
    on('cdOpenToggle', 'click', toggleOpen);
    on('cdLeave', 'click', function () {
      if (!currentCampaign) return;
      confirmThen('Leave this game?', 'You can rejoin later if it stays public.', false, function () {
        api('POST', '/api/campaigns/' + currentCampaign.id + '/leave').then(function (r) {
          if (r.status === 200) { C.closeDialog($('campaignDialog')); loadList(); }
          else setText('cdStatus', serverError(r));
        }).catch(function () { setText('cdStatus', NETWORK_ERROR); });
      });
    });
    on('cdTransferBtn', 'click', doTransfer);
    initSettingsForm();
    // Attach the cover picker to the Settings URL field once.
    if (window.VTTImagePicker && $('stImg')) {
      window.VTTImagePicker.attach('stImg', { kind: 'cover', campaignId: function () { return currentCampaign ? currentCampaign.id : null; } });
    }
    // Live preview of the cover URL as it changes.
    var stImg = $('stImg');
    if (stImg) stImg.addEventListener('input', function () { updateImgPreview(stImg.value); });
    bindVisibilityToggle('stVis', 'stPasswordField');
  }

  function openCampaignDialog(id, invoker, opts) {
    opts = opts || {};
    C.openDialog($('campaignDialog'), { invoker: invoker, focus: $('cdTitle') });
    // Reset to Overview unless told otherwise.
    if (cdTabsStrip && cdTabsStrip._select) cdTabsStrip._select(opts.tab || 'cdTabOverview');
    setText('cdStatus', opts.status || '');
    loadCampaignInto(id, opts);
  }

  function loadCampaignInto(id, opts) {
    opts = opts || {};
    api('GET', '/api/campaigns/' + id).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.campaign) {
        setText('cdStatus', serverError(r));
        return;
      }
      currentCampaign = r.data.campaign;
      currentMembers = null;
      renderCampaignDialog(r.data.campaign, r.data.members || []);
      // Post-create convenience: land on Settings AND open the cover picker, so
      // adding an image is immediate rather than a hunt for the button. The
      // campaign now exists, so the picker has an id to upload against.
      if (opts.openCover && currentCampaign.is_gm && window.VTTImagePicker && typeof window.VTTImagePicker.open === 'function') {
        window.VTTImagePicker.open({ kind: 'cover', campaignId: currentCampaign.id, onChoose: function (url) {
          var f = $('stImg'); if (f) { f.value = url; updateImgPreview(url); }
        } });
      }
      if (currentCampaign.is_gm) {
        api('GET', '/api/campaigns/' + id + '/members').then(function (mr) {
          if (mr.status === 200 && mr.data && Array.isArray(mr.data.members)) {
            currentMembers = mr.data.members;
            renderMembers(currentMembers);
          }
        }).catch(function () { /* members are best-effort; overview still works */ });
      }
    }).catch(function () { setText('cdStatus', NETWORK_ERROR); });
  }

  function renderCampaignDialog(c, activeMembers) {
    var isGm = c.is_gm === true;
    setText('cdTitle', c.name || 'Game');

    // Overview
    var cover = $('cdCover');
    if (cover) {
      // reset to mask, then swap to an <img> if there's a cover
      cover.className = 'card-cover mask';
      while (cover.firstChild) cover.removeChild(cover.firstChild);
      if (c.img_url) {
        cover.classList.remove('mask');
        var img = document.createElement('img');
        img.src = c.img_url; img.alt = '';
        img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; img.style.borderRadius = '3px';
        cover.appendChild(img);
      }
    }
    var desc = $('cdDesc');
    if (desc) desc.textContent = c.description || '';
    setText('cdVis', c.is_public ? 'Public' : 'Private');
    setText('cdState', c.is_open !== false ? 'Open' : 'Closed');
    var count = onlineByCampaign[c.id];
    setText('cdOnline', count != null ? (count + ' at the table') : '—');
    setText('cdCreated', fmtDate(c.created_at));

    // Invite link (everyone)
    var invite = $('cdInvite');
    if (invite) invite.value = inviteUrl(originOf(), c.id);

    // Enter (same rule as the card)
    var enter = $('cdEnter');
    var st = cardState(c, isGm);
    if (enter) {
      if (st.showEnter) { enter.setAttribute('href', '/game.html?campaign=' + c.id); enter.removeAttribute('hidden'); }
      else enter.setAttribute('hidden', '');
    }

    // GM-only: open/close toggle + Settings tab; player: Leave.
    var toggle = $('cdOpenToggle');
    if (toggle) {
      if (isGm) { toggle.removeAttribute('hidden'); toggle.textContent = (c.is_open !== false) ? 'Close the table' : 'Open the table'; }
      else toggle.setAttribute('hidden', '');
    }
    var settingsTab = $('cdTabSettings');
    if (settingsTab) { if (isGm) settingsTab.removeAttribute('hidden'); else settingsTab.setAttribute('hidden', ''); }
    var leave = $('cdLeave');
    if (leave) { if (!isGm) leave.removeAttribute('hidden'); else leave.setAttribute('hidden', ''); }

    // Members: non-GM sees active roster read-only immediately.
    renderMembers(activeMembers.map(function (m) { return m; }));
    var transferBlock = $('cdTransferBlock');
    if (transferBlock) { if (isGm) transferBlock.removeAttribute('hidden'); else transferBlock.setAttribute('hidden', ''); }
    var bannedHead = $('cdBannedHead');
    if (bannedHead) bannedHead.setAttribute('hidden', ''); // shown by renderMembers when GM has banned rows

    // Settings form (GM)
    if (isGm) fillSettings(c);
  }

  function renderMembers(members) {
    var list = $('cdMemberList');
    var banned = $('cdBannedList');
    if (!list || !banned) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    while (banned.firstChild) banned.removeChild(banned.firstChild);
    var isGm = currentCampaign && currentCampaign.is_gm === true;

    var transferSel = $('cdTransferSel');
    if (transferSel) while (transferSel.firstChild) transferSel.removeChild(transferSel.firstChild);

    var bannedCount = 0;
    members.forEach(function (m) {
      if (m.status === 'left') return; // left rows are not shown
      if (m.status === 'banned') {
        bannedCount++;
        banned.appendChild(memberRow(m, isGm, true));
        return;
      }
      // active
      list.appendChild(memberRow(m, isGm, false));
      // populate transfer select (active, non-self)
      if (isGm && transferSel && m.user_id !== me.id) {
        var opt = document.createElement('option');
        opt.value = m.user_id;
        opt.textContent = m.username || m.user_id;
        transferSel.appendChild(opt);
      }
    });
    var bannedHead = $('cdBannedHead');
    if (bannedHead) { if (isGm && bannedCount) bannedHead.removeAttribute('hidden'); else bannedHead.setAttribute('hidden', ''); }
  }

  function memberRow(m, isGm, isBanned) {
    var row = document.createElement('div');
    row.className = 'member-row';
    row.setAttribute('data-user', m.user_id);
    var who = document.createElement('div');
    who.className = 'who';
    var av = document.createElement('span');
    av.className = 'avatar';
    if (m.avatar_url) { var img = document.createElement('img'); img.src = m.avatar_url; img.alt = ''; img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; img.style.borderRadius = '50%'; av.appendChild(img); }
    var col = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.username || m.user_id;
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (m.is_gm ? 'GM' : 'Player') + (m.joined_at ? (' · joined ' + fmtDate(m.joined_at)) : '');
    col.appendChild(name); col.appendChild(meta);
    who.appendChild(av); who.appendChild(col);
    row.appendChild(who);

    // GM actions on non-self rows.
    if (isGm && m.user_id !== me.id) {
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      if (isBanned) {
        actions.appendChild(actionBtn('Unban', 'secondary', function () { moderate(m, 'unban'); }));
      } else {
        actions.appendChild(actionBtn('Kick', 'secondary', function () {
          confirmThen('Kick ' + (m.username || 'this player') + '?', 'They can rejoin on their own if the game is public.', false, function () { moderate(m, 'kick'); });
        }));
        actions.appendChild(actionBtn('Ban', 'danger', function () {
          confirmThen('Ban ' + (m.username || 'this player') + '?', 'They will not be able to rejoin until you unban them.', true, function () { moderate(m, 'ban'); });
        }));
      }
      row.appendChild(actions);
    }
    return row;
  }

  function actionBtn(label, variant, fn) {
    var b = document.createElement('button');
    b.className = 'btn ' + variant + ' small';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function moderate(m, action) {
    if (!currentCampaign) return;
    var path = '/api/campaigns/' + currentCampaign.id + '/members/' + m.user_id + '/' + action;
    api('POST', path).then(function (r) {
      if (r.status === 200) { loadCampaignInto(currentCampaign.id); loadList(); }
      else setText('cdStatus', serverError(r));
    }).catch(function () { setText('cdStatus', NETWORK_ERROR); });
  }

  function doTransfer() {
    if (!currentCampaign) return;
    var sel = $('cdTransferSel');
    if (!sel || !sel.value) { setText('cdStatus', 'Choose a member to transfer to.'); return; }
    var targetId = sel.value;
    confirmThen('Transfer ownership?', 'You will remain in the game as a player.', false, function () {
      api('POST', '/api/campaigns/' + currentCampaign.id + '/transfer', { user_id: targetId }).then(function (r) {
        if (r.status === 200) { loadCampaignInto(currentCampaign.id); loadList(); }
        else setText('cdStatus', serverError(r));
      }).catch(function () { setText('cdStatus', NETWORK_ERROR); });
    });
  }

  function toggleOpen() {
    if (!currentCampaign) return;
    var next = !(currentCampaign.is_open !== false);
    withPending($('cdOpenToggle'), function () {
      return api('PATCH', '/api/campaigns/' + currentCampaign.id, { is_open: next }).then(function (r) {
        if (r.status === 200 && r.data && r.data.campaign) {
          currentCampaign = r.data.campaign;
          renderCampaignDialog(currentCampaign, []);
          if (currentMembers) renderMembers(currentMembers);
          loadList();
        } else setText('cdStatus', serverError(r));
      }).catch(function () { setText('cdStatus', NETWORK_ERROR); });
    });
  }

  function copyInvite() {
    var input = $('cdInvite');
    if (!input) return;
    var text = input.value;
    var done = function () { setText('cdStatus', 'Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { input.select(); });
    } else { input.select(); }
  }

  // ── Settings form ──────────────────────────────────────────────────────────
  function fillSettings(c) {
    if ($('stName')) $('stName').value = c.name || '';
    if ($('stDesc')) $('stDesc').value = c.description || '';
    if ($('stImg')) $('stImg').value = c.img_url || '';
    if ($('stVis')) $('stVis').value = c.is_public ? 'public' : 'private';
    updateImgPreview(c.img_url || '');
    if ($('stVis').value === 'private') show('stPasswordField'); else hide('stPasswordField');
    if ($('stPassword')) $('stPassword').value = '';
  }

  function updateImgPreview(url) {
    var img = $('stImgPreview');
    if (!img) return;
    if (url) { img.src = url; img.removeAttribute('hidden'); }
    else { img.setAttribute('hidden', ''); img.removeAttribute('src'); }
  }

  function initSettingsForm() {
    var form = $('formSettings');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentCampaign) return;
        var isPublic = $('stVis').value === 'public';
        var body = {
          name: $('stName').value,
          description: $('stDesc').value,
          img_url: $('stImg').value,
          is_public: isPublic,
        };
        // Password semantics (verified against the PATCH route):
        //  - going/staying public: never send a password (the route NULLs it).
        //  - staying private, field blank: OMIT password → keep the current one.
        //    (Sending '' would 400: validateCampaignPassword rejects empty.)
        //  - private with a value: send it (validated 4–128, re-hashed).
        if (!isPublic) {
          var pw = $('stPassword').value;
          if (pw !== '') body.password = pw;
        }
        setText('stStatus', '');
        withPending($('stSubmit'), function () {
          return api('PATCH', '/api/campaigns/' + currentCampaign.id, body).then(function (r) {
            if (r.status === 200 && r.data && r.data.campaign) {
              currentCampaign = r.data.campaign;
              setText('stStatus', 'Saved.');
              fillSettings(currentCampaign);
              renderCampaignDialog(currentCampaign, []);
              if (currentMembers) renderMembers(currentMembers);
              loadList();
            } else setText('stStatus', serverError(r));
          }).catch(function () { setText('stStatus', NETWORK_ERROR); });
        });
      });
    }
    on('stArchive', 'click', function () {
      if (!currentCampaign) return;
      var archived = currentCampaign.archived === true;
      var path = '/api/campaigns/' + currentCampaign.id + '/' + (archived ? 'unarchive' : 'archive');
      api('POST', path).then(function (r) {
        if (r.status === 200) { loadCampaignInto(currentCampaign.id); loadList(); }
        else setText('stStatus', serverError(r));
      }).catch(function () { setText('stStatus', NETWORK_ERROR); });
    });
    on('stDelete', 'click', function () {
      if (!currentCampaign) return;
      confirmThen('Delete this game?', 'Deleted games can be restored for 30 days from Recently deleted.', true, function () {
        api('DELETE', '/api/campaigns/' + currentCampaign.id).then(function (r) {
          if (r.status === 200) { C.closeDialog($('campaignDialog')); loadList(); loadDeleted(); }
          else setText('stStatus', serverError(r));
        }).catch(function () { setText('stStatus', NETWORK_ERROR); });
      });
    });
  }

  // ── Profile dialog ─────────────────────────────────────────────────────────
  function initProfile() {
    on('profileBtn', 'click', function () { openProfile(this); });
    on('pfLogout', 'click', function () {
      api('POST', '/api/auth/logout').then(function () { C.navigate('/'); }).catch(function () { C.navigate('/'); });
    });
    var pf = $('formProfile');
    if (pf) pf.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { username: $('pfNameInput').value, avatar_url: $('pfAvatarInput').value };
      setText('pfStatus', '');
      withPending($('pfSaveBtn'), function () {
        return api('PATCH', '/api/auth/me', body).then(function (r) {
          if (r.status === 200 && r.data && r.data.user) {
            me = r.data.user;
            renderHeader();
            fillProfile();
            setText('pfStatus', 'Saved.');
            // GM badge usernames refresh on next list load; refetch to be safe.
            loadList();
          } else setText('pfStatus', serverError(r));
        }).catch(function () { setText('pfStatus', NETWORK_ERROR); });
      });
    });
    var pw = $('formPassword');
    if (pw) pw.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { currentPassword: $('pwCurrent').value, newPassword: $('pwNew').value };
      setText('pwStatus', '');
      withPending($('pwSubmit'), function () {
        return api('POST', '/api/auth/change-password', body).then(function (r) {
          if (r.status === 200) { setText('pwStatus', (r.data && r.data.message) || 'Password changed.'); $('formPassword').reset(); }
          else setText('pwStatus', serverError(r));
        }).catch(function () { setText('pwStatus', NETWORK_ERROR); });
      });
    });
    var em = $('formEmail');
    if (em) em.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { newEmail: $('emNew').value, currentPassword: $('emPassword').value };
      setText('emStatus', '');
      withPending($('emSubmit'), function () {
        return api('POST', '/api/auth/change-email', body).then(function (r) {
          // Uniform response rendered verbatim.
          setText('emStatus', (r.data && r.data.message) || serverError(r));
          if (r.status === 200) $('formEmail').reset();
        }).catch(function () { setText('emStatus', NETWORK_ERROR); });
      });
    });
    // Avatar picker (kind avatar, no campaign).
    if (window.VTTImagePicker && $('pfAvatarInput')) {
      window.VTTImagePicker.attach('pfAvatarInput', { kind: 'avatar', campaignId: null });
    }
  }

  function fillProfile() {
    if (!me) return;
    var av = $('pfAvatar');
    if (av) {
      while (av.firstChild) av.removeChild(av.firstChild);
      if (me.avatar_url) { var img = document.createElement('img'); img.src = me.avatar_url; img.alt = ''; img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; img.style.borderRadius = '50%'; av.appendChild(img); }
    }
    setText('pfUsername', me.username || '');
    setText('pfEmail', me.email || '');
    setText('pfVerified', me.email_verified ? 'Verified' : 'Unverified');
    setText('pfSince', me.created_at ? ('Member since ' + fmtDate(me.created_at)) : '');
    if ($('pfNameInput')) $('pfNameInput').value = me.username || '';
    if ($('pfAvatarInput')) $('pfAvatarInput').value = me.avatar_url || '';
  }

  function openProfile(invoker) {
    fillProfile();
    setText('pfStatus', ''); setText('pwStatus', ''); setText('emStatus', '');
    C.openDialog($('profileDialog'), { invoker: invoker, focus: $('pfNameInput') });
  }

  // ── Confirm dialog (opened over another dialog) ────────────────────────────
  var confirmCb = null;
  function initConfirm() {
    on('cfCancel', 'click', function () { C.closeDialog($('confirmDialog')); confirmCb = null; });
    on('cfOk', 'click', function () {
      var cb = confirmCb; confirmCb = null;
      C.closeDialog($('confirmDialog'));
      if (cb) cb();
    });
  }
  function confirmThen(title, body, danger, cb) {
    setText('cfTitle', title);
    setText('cfBody', body);
    var ok = $('cfOk');
    if (ok) { ok.classList.remove('danger', 'primary'); ok.classList.add(danger ? 'danger' : 'primary'); }
    confirmCb = cb;
    // Opened over the currently open dialog: the native top layer stacks them.
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

    // Presence for one campaign: update its card and, if its dialog is open,
    // the Overview count.
    socket.on('lobby:presence', function (p) {
      if (!p || p.campaign_id == null) return;
      onlineByCampaign[p.campaign_id] = p.online;
      updateCardOnline(p.campaign_id, p.online);
      if (currentCampaign && currentCampaign.id === p.campaign_id) {
        setText('cdOnline', p.online != null ? (p.online + ' at the table') : '—');
      }
    });

    // Open/closed changed elsewhere: flip the pill and Enter affordance on the
    // card, and the dialog if it is showing this campaign.
    socket.on('campaign:state', function (p) {
      if (!p || p.campaign_id == null) return;
      applyState(p.campaign_id, p.is_open !== false);
    });

    // Kicked/banned/campaign gone: the card should disappear. Refetch the list;
    // the reason is not editorialised.
    socket.on('campaign:evicted', function (p) {
      loadList();
      if (currentCampaign && p && currentCampaign.id === p.campaign_id) {
        C.closeDialog($('campaignDialog'));
      }
    });
  }

  function lobbySubscribe() {
    if (!socket || !socket.emit) return;
    socket.emit('lobby:subscribe', {}, function (ack) {
      if (ack && ack.ok && Array.isArray(ack.campaigns)) {
        ack.campaigns.forEach(function (c) {
          onlineByCampaign[c.campaign_id] = c.online;
          updateCardOnline(c.campaign_id, c.online);
        });
      }
    });
  }
  // Called after any list-changing mutation; re-emit is idempotent server-side.
  function lobbyResubscribe() { lobbySubscribe(); }

  function cardFor(campaignId) {
    var grid = $('cardsGrid');
    if (!grid) return null;
    return grid.querySelector('[data-id="' + cssEscape(campaignId) + '"]');
  }
  // Minimal attribute-selector escaping for a UUID (defensive; UUIDs are safe).
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function updateCardOnline(campaignId, online) {
    var card = cardFor(campaignId);
    if (!card) return;
    var el = card.querySelector('.card-online');
    if (el) el.textContent = (online != null) ? (online + ' at the table') : '';
  }

  function applyState(campaignId, isOpen) {
    // Update the card pill + Enter affordance.
    var card = cardFor(campaignId);
    if (card) {
      var pill = card.querySelector('.pill-state');
      if (pill) {
        pill.textContent = isOpen ? 'Open' : 'Closed';
        pill.classList.remove('open', 'closed');
        pill.classList.add(isOpen ? 'open' : 'closed');
      }
      var isGm = card.querySelector('.badge-role') && card.querySelector('.badge-role').textContent === 'GM';
      var enter = card.querySelector('.card-enter');
      var note = card.querySelector('.card-note');
      var showEnter = isGm || isOpen;
      if (enter) {
        if (showEnter) { enter.removeAttribute('hidden'); if (note) note.setAttribute('hidden', ''); }
        else {
          enter.setAttribute('hidden', '');
          if (note) { note.textContent = "Closed — the GM hasn't opened the table."; note.removeAttribute('hidden'); }
        }
      }
    }
    // Update the open dialog if it is showing this campaign.
    if (currentCampaign && currentCampaign.id === campaignId) {
      currentCampaign.is_open = isOpen;
      setText('cdState', isOpen ? 'Open' : 'Closed');
      var toggle = $('cdOpenToggle');
      if (toggle && currentCampaign.is_gm) toggle.textContent = isOpen ? 'Close the table' : 'Open the table';
      var cdEnter = $('cdEnter');
      if (cdEnter) {
        var showCd = currentCampaign.is_gm || isOpen;
        if (showCd) { cdEnter.setAttribute('href', '/game.html?campaign=' + campaignId); cdEnter.removeAttribute('hidden'); }
        else cdEnter.setAttribute('hidden', '');
      }
    }
  }

  // ── Boot on DOM ready ──────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
