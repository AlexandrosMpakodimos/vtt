// Dashboard page UI smoke suite. jsdom only — no server, no database:
//   node test-dashboard-ui.js
//
// Same scope and reason as test-landing-ui.js: public/js/dashboard.js is a
// client file with no runtime coverage from any server suite, and the class of
// defect these suites exist to catch — a function deleted by an edit and still
// called, a contract quietly broken, a CSP rule regressed — is invisible to
// `node --check` and to every functional suite. This loads the REAL
// public/dashboard.html + theme.js + common.js + imagepicker.js + dashboard.js
// and asserts: the id manifest, the pure seams (cardState / tabsRole /
// inviteUrl), the boot→header→list render, the tablist keyboard model, the
// closed-game player rule (no Enter), the ?join= flow, the 401→navigate
// redirect, the lobby fakes (subscribe recorded; presence/state/evicted
// applied), profile logout, and source-level probes for the CSP-critical rules.

const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A default signed-in user and a small campaign set the fake API returns.
const USER = {
  id: 'u-self', email: 'me@example.com', username: 'selene',
  avatar_url: null, email_verified: true, created_at: '2026-01-02T00:00:00.000Z',
};
const OWNED = {
  id: 'c-owned', owner_id: 'u-self', name: 'Owned Game', description: 'a campaign I run',
  img_url: null, is_public: true, is_open: true, has_password: false, is_gm: true,
  archived: false, created_at: '2026-02-01T00:00:00.000Z', owner_username: 'selene',
};
const CLOSED_AS_PLAYER = {
  id: 'c-closed', owner_id: 'u-gm', name: 'Closed Game', description: 'a table that is shut',
  img_url: null, is_public: true, is_open: false, has_password: false, is_gm: false,
  archived: false, created_at: '2026-02-02T00:00:00.000Z', owner_username: 'dungeon_dan',
};

// When a card is expanded, its .card-panel is MOVED into #cardOverlayStage, so
// its .cd-* fields are no longer inside the grid card. This finds the panel
// wherever it currently lives (open → in the stage; closed → back in the card).
function openPanel(document) {
  const stage = document.getElementById('cardOverlayStage');
  const inStage = stage && stage.querySelector('.card-panel');
  return inStage || null;
}
// Query a .cd-* control on the currently open panel.
function panelEl(document, selector) {
  const p = openPanel(document);
  return p ? p.querySelector(selector) : null;
}

// A jsdom window with all the browser bits dashboard.js touches, stubbed.
function makeDom(url) {
  const dom = new JSDOM(fs.readFileSync('public/dashboard.html', 'utf8'), {
    runScripts: 'outside-only',
    url: url || 'http://localhost:3000/dashboard.html',
  });
  const { window } = dom;
  window.matchMedia = (q) => ({
    matches: /reduce|hover: none/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.requestAnimationFrame = (cb) => window.setTimeout(cb, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  // jsdom has no layout, so scrollIntoView is missing; the expand-to-centre
  // behaviour calls it. Stub it as a no-op on the prototype.
  window.HTMLElement.prototype.scrollIntoView = function () {};

  // jsdom <dialog> has no showModal/close — stub them to RECORD and reflect state.
  window.__showModalCalls = 0;
  const dialogs = window.document.querySelectorAll('dialog');
  dialogs.forEach((d) => {
    d.showModal = function () { window.__showModalCalls += 1; this.open = true; };
    d.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  });

  // Clipboard + navigation: dashboard.js navigates via VTTCommon.navigate, which
  // the tests stub after eval (jsdom's window.location is not reconfigurable).
  window.__navigated = null;
  return dom;
}

// A URL/method-dispatching fake API. Records every call; returns canned data.
function stubApi(window, opts = {}) {
  const calls = [];
  const meStatus = opts.meStatus != null ? opts.meStatus : 200;
  const campaigns = opts.campaigns || [OWNED];
  window.fetch = async (path, o = {}) => {
    const method = (o.method || 'GET');
    const body = o.body ? JSON.parse(o.body) : null;
    calls.push({ path, method, body });
    const reply = (status, data) => ({ status, json: async () => data });

    if (/\/api\/auth\/me$/.test(path)) {
      return meStatus === 200 ? reply(200, { user: USER }) : reply(401, {});
    }
    if (/\/api\/campaigns\/mine/.test(path)) return reply(200, { campaigns });
    if (/\/api\/campaigns\/deleted$/.test(path)) return reply(200, { campaigns: opts.deleted || [] });
    if (/\/api\/campaigns\/search/.test(path)) return reply(200, { campaigns: opts.search || [] });
    if (/\/api\/campaigns\/[^/]+\/members$/.test(path)) return reply(200, { members: opts.members || [] });
    if (/\/api\/campaigns\/[^/]+\/join$/.test(path)) return reply(200, { ok: true });
    if (/\/api\/campaigns$/.test(path) && method === 'POST') {
      // Create returns 201 with the new campaign, and it now appears in /mine so
      // the post-create reload renders (and auto-expands) its card.
      const created = Object.assign({}, OWNED, { id: 'c-new', name: body && body.name, description: '', img_url: null, is_gm: true });
      campaigns.push(created);
      return reply(201, { campaign: created });
    }
    if (/\/api\/campaigns\/[^/]+$/.test(path) && method === 'PATCH') {
      const id = path.split('/').pop();
      const base = campaigns.find((x) => x.id === id) || OWNED;
      return reply(200, { campaign: Object.assign({}, base, body || {}) });
    }
    if (/\/api\/campaigns\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').pop();
      const c = campaigns.find((x) => x.id === id) || OWNED;
      // The real detail endpoint does NOT include per-user fields like `archived`
      // (it's derived from the member row). Strip it so tests match the server —
      // the client must not lose `archived` when it merges this in.
      const detail = Object.assign({}, c); delete detail.archived;
      return reply(200, { campaign: detail, members: opts.members || [] });
    }
    if (/\/api\/auth\/logout$/.test(path)) return reply(200, { ok: true });
    return reply(200, {});
  };
  return calls;
}

// A fake socket.io: records emits and lets the test push server events.
function installFakeIo(window) {
  const handlers = {};
  const emits = [];
  const sock = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
    emit(ev, payload, ack) { emits.push({ ev, payload }); if (typeof ack === 'function') sock._acks.push(ack); return sock; },
    _acks: [],
    fire(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
  };
  window.io = () => sock;
  return { sock, emits, handlers };
}

function evalApp(window, beforeBoot) {
  let err = null;
  try {
    window.eval(fs.readFileSync('public/js/theme.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/common.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/imagepicker.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/dashboard.js', 'utf8'));
    // Stub seams (e.g. VTTCommon.navigate) after the modules define them but
    // before boot runs on DOMContentLoaded.
    if (typeof beforeBoot === 'function') beforeBoot(window);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  } catch (e) { err = e; }
  return err;
}

(async () => {
  // ── source-level probes (no DOM needed) ────────────────────────────────────
  const dashSrc = fs.readFileSync('public/js/dashboard.js', 'utf8');
  const htmlSrc = fs.readFileSync('public/dashboard.html', 'utf8');
  const commonSrc = fs.readFileSync('public/js/common.js', 'utf8');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  t('dashboard.js has no innerHTML/insertAdjacentHTML/document.write (code)',
    !/innerHTML|insertAdjacentHTML|document\.write/.test(stripComments(dashSrc)));
  t('common.js has no innerHTML/insertAdjacentHTML/document.write (code)',
    !/innerHTML|insertAdjacentHTML|document\.write/.test(stripComments(commonSrc)));
  t('dashboard.html has no inline <script> (every <script> has src)',
    !/<script(?![^>]*\ssrc=)[^>]*>/.test(htmlSrc));
  t('dashboard.html has no on*= handlers',
    !/\son[a-z]+\s*=\s*["']/i.test(htmlSrc));
  t('theme.js is loaded exactly once in the head',
    (htmlSrc.match(/js\/theme\.js/g) || []).length === 1);
  t('the socket.io client is loaded before dashboard.js',
    htmlSrc.indexOf('/socket.io/socket.io.js') < htmlSrc.indexOf('/js/dashboard.js'));
  t('dashboard.js never emits campaign:join (a viewer is not at the table)',
    !/emit\(\s*'campaign:join'/.test(dashSrc));

  // ── id manifest: every referenced id exists exactly once in the HTML ───────
  const MANIFEST = ['connState', 'themeToggle', 'profileBtn', 'profileAvatar', 'profileName',
    'games', 'btnCreate', 'btnFind', 'listTabs', 'tabAll', 'tabRunning', 'tabPlaying',
    'campaignPanel', 'showArchived', 'listStatus', 'cardsGrid', 'emptyState', 'cardTemplate',
    'deletedWrap', 'deletedToggle', 'deletedList',
    'createDialog', 'formCreate', 'crName', 'crDesc', 'crVis', 'crPasswordField', 'crPassword',
    'crStatus', 'crSubmit',
    'findDialog', 'formFind', 'fdQuery', 'fdVis', 'fdSubmit', 'fdStatus', 'fdResults', 'fdMore',
    'formJoin', 'jnId', 'jnPasswordField', 'jnPassword', 'jnSubmit', 'jnStatus',
    'profileDialog', 'pfAvatar', 'pfUsername', 'pfEmail', 'pfVerified',
    'pfHeading', 'pfUsernameBtn', 'pfNameInput', 'pfNameHelp',
    'pfEmailBtn', 'pfEmailEdit', 'emNew', 'emPassword', 'emStatus',
    'pfPasswordBtn', 'pfPasswordEdit', 'pwCurrent', 'pwNew', 'pwStatus',
    'pfAvatarBtn', 'pfAvatarInput', 'pfSaveBtn', 'pfStatus', 'pfLogout',
    'confirmDialog', 'cfTitle', 'cfBody', 'cfCancel', 'cfThird', 'cfOk'];
  {
    const dom = makeDom();
    const { document } = dom.window;
    let missing = [];
    let dup = [];
    for (const id of MANIFEST) {
      const n = (htmlSrc.match(new RegExp(`id="${id}"`, 'g')) || []).length;
      if (n === 0) missing.push(id);
      if (n > 1) dup.push(`${id}(${n})`);
      if (!document.getElementById(id)) missing.push(id + '(dom)');
    }
    t('every manifest id is present', missing.length === 0, missing.join(', '));
    t('no manifest id is duplicated', dup.length === 0, dup.join(', '));
  }

  // ── pure seams ─────────────────────────────────────────────────────────────
  {
    const dom = makeDom();
    const { window } = dom;
    installFakeIo(window);
    stubApi(window);
    const err = evalApp(window);
    t('app evaluates without throwing', err === null, err && `${err.name}: ${err.message}`);
    const D = window.VTTDashboard || {};
    t('VTTDashboard exposes navigate/tabsRole/cardState/inviteUrl',
      typeof D.navigate === 'function' && typeof D.tabsRole === 'function'
      && typeof D.cardState === 'function' && typeof D.inviteUrl === 'function');

    // tabsRole
    t("tabsRole('tabAll') -> all", D.tabsRole('tabAll') === 'all');
    t("tabsRole('tabRunning') -> owner", D.tabsRole('tabRunning') === 'owner');
    t("tabsRole('tabPlaying') -> player", D.tabsRole('tabPlaying') === 'player');

    // cardState — four cases
    const gmOpen = D.cardState({ is_open: true }, true);
    t('cardState GM+open: Enter shown, "Open", "Manage"',
      gmOpen.showEnter === true && gmOpen.stateWord === 'Open' && gmOpen.manageLabel === 'Manage');
    const gmClosed = D.cardState({ is_open: false }, true);
    t('cardState GM+closed: Enter STILL shown (GM preps inside), "Closed"',
      gmClosed.showEnter === true && gmClosed.stateWord === 'Closed');
    const plOpen = D.cardState({ is_open: true }, false);
    t('cardState player+open: Enter shown, "Details"',
      plOpen.showEnter === true && plOpen.manageLabel === 'Details');
    const plClosed = D.cardState({ is_open: false }, false);
    t('cardState player+closed: NO Enter, "Closed"',
      plClosed.showEnter === false && plClosed.stateWord === 'Closed');

    // inviteUrl
    t('inviteUrl builds a ?join= link',
      D.inviteUrl('http://x', 'c1') === 'http://x/dashboard.html?join=c1');
  }

  // ── boot → header + list render (signed in) ────────────────────────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window, { campaigns: [OWNED, CLOSED_AS_PLAYER] });
    evalApp(window);
    await wait(30);
    t('boot fetched /api/auth/me', calls.some((c) => /\/api\/auth\/me$/.test(c.path)));
    t('header shows the username', document.getElementById('profileName').textContent === 'selene');
    t('boot fetched /mine', calls.some((c) => /\/api\/campaigns\/mine/.test(c.path)));
    const cards = document.querySelectorAll('#cardsGrid .card');
    t('two cards rendered', cards.length === 2, String(cards.length));

    // The owned card (collapsed): GM badge, Open pill, small Enter, no description.
    const owned = document.querySelector('[data-id="c-owned"]');
    t('owned card shows GM', owned.querySelector('.badge-role').textContent === 'GM');
    t('owned card owner line reads "by you"', owned.querySelector('.card-owner').textContent === 'by you');
    t('owned card shows Open', owned.querySelector('.pill-state').textContent === 'Open');
    // Join-gate label: public campaigns read "Anyone", private read "Password".
    t('a public game badge reads "Anyone"', owned.querySelector('.badge-vis').textContent === 'Anyone');
    t('owned card keeps a small Enter link', !!owned.querySelector('.card-head .card-enter')
      && /game\.html\?campaign=c-owned/.test(owned.querySelector('.card-head .card-enter').getAttribute('href')));
    t('collapsed card has NO description (moved to expanded)', owned.querySelector('.card-desc') === null);
    t('collapsed card has NO Manage/Details button (removed)', owned.querySelector('.card-manage') === null);
    t('collapsed card has NO archive button (moved to expanded danger zone)', owned.querySelector('.card-archive') === null);
    t('card head is a disclosure trigger', owned.querySelector('.card-head').getAttribute('aria-expanded') === 'false');

    // The closed-as-player card: no Enter on the head; shows the GM's name.
    const closed = document.querySelector('[data-id="c-closed"]');
    t('closed card (player) has NO Enter link on the head', closed.querySelector('.card-head .card-enter') === null);
    t('played card owner line shows the GM name', closed.querySelector('.card-owner').textContent === 'by dungeon_dan');
  }

  // ── tablist keyboard model (APG) ───────────────────────────────────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    const tabs = document.getElementById('listTabs');
    const all = document.getElementById('tabAll');
    const running = document.getElementById('tabRunning');
    const playing = document.getElementById('tabPlaying');
    t('All is selected by default', all.getAttribute('aria-selected') === 'true'
      && all.getAttribute('tabindex') === '0');
    // Labels: the GM tab reads "Hosting", the player tab "Joined".
    t('GM tab is labelled "Hosting"', running.textContent === 'Hosting');
    t('player tab is labelled "Joined"', playing.textContent === 'Joined');
    t('other tabs are not in the tab order', running.getAttribute('tabindex') === '-1');

    // ArrowRight moves selection to Running.
    all.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    t('ArrowRight selects Running', running.getAttribute('aria-selected') === 'true'
      && all.getAttribute('aria-selected') === 'false');
    t('roving tabindex followed selection', running.getAttribute('tabindex') === '0'
      && all.getAttribute('tabindex') === '-1');

    // ArrowLeft from All wraps to Playing (End-like wrap).
    running.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    t('ArrowLeft goes back to All', all.getAttribute('aria-selected') === 'true');
    all.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    t('ArrowLeft from the first tab wraps to the last (Playing)',
      playing.getAttribute('aria-selected') === 'true');
    all.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    // Home focuses/selects the first regardless of current.
    playing.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    t('Home selects the first tab', all.getAttribute('aria-selected') === 'true');
    all.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    t('End selects the last tab', playing.getAttribute('aria-selected') === 'true');
  }

  // ── regression: the shared list panel stays visible across tab switches ────
  // All/Running/Playing all control the SAME #campaignPanel. A naive per-tab
  // hide/show loop hid the panel whenever the selected tab was not the last one
  // in the DOM, so switching to Playing and back to All left the list blank.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window, { campaigns: [OWNED] });
    evalApp(window);
    await wait(20);
    const panel = document.getElementById('campaignPanel');
    const all = document.getElementById('tabAll');
    const running = document.getElementById('tabRunning');
    const playing = document.getElementById('tabPlaying');
    t('panel visible on initial All', !panel.hasAttribute('hidden'));
    playing.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('panel still visible after selecting Playing', !panel.hasAttribute('hidden'));
    all.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('panel STILL visible after switching back to All (was the bug)',
      !panel.hasAttribute('hidden'));
    t('...and the owned card is present under All', !!document.querySelector('[data-id="c-owned"]'));
    running.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('panel visible under Running too', !panel.hasAttribute('hidden'));
  }

  // ── the "Loading…" indicator is deferred so it doesn't flash on fast loads ──
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    // A fetch whose /mine response we can delay on demand.
    let mineDelay = 0;
    window.fetch = async (path, o = {}) => {
      const method = o.method || 'GET';
      if (/\/api\/auth\/me$/.test(path)) return { status: 200, json: async () => ({ user: USER }) };
      if (/\/api\/campaigns\/mine/.test(path)) {
        if (mineDelay) await new Promise((r) => setTimeout(r, mineDelay));
        return { status: 200, json: async () => ({ campaigns: [] }) };
      }
      return { status: 200, json: async () => ({}) };
    };
    evalApp(window);
    await wait(30);
    const status = () => document.getElementById('listStatus').textContent;

    // FAST: switch tab, response is immediate. Within the delay window the
    // indicator must never appear.
    mineDelay = 0;
    document.getElementById('tabRunning').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    let flashed = false;
    for (let i = 0; i < 12; i++) { if (/Loading/.test(status())) flashed = true; await wait(20); }
    t('a fast tab load never flashes "Loading…"', !flashed, JSON.stringify(status()));

    // SLOW: response delayed well past the threshold → the indicator appears,
    // then clears once data arrives.
    mineDelay = 500;
    document.getElementById('tabPlaying').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(360);
    t('a slow tab load does show "Loading…" after the delay', /Loading/.test(status()), JSON.stringify(status()));
    await wait(300);
    t('...and clears it once the data arrives', !/Loading/.test(status()), JSON.stringify(status()));
  }

  // ── ?join= opens the Find dialog on the join face with the id filled ───────
  {
    const dom = makeDom('http://localhost:3000/dashboard.html?join=c-join-me');
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(30);
    t('?join= opened the find dialog', document.getElementById('findDialog').open === true);
    t('the join face is visible, search face hidden',
      !document.getElementById('formJoin').hasAttribute('hidden')
      && document.getElementById('formFind').hasAttribute('hidden'));
    t('the join id field is filled from the URL',
      document.getElementById('jnId').value === 'c-join-me');
    // Submitting the join face POSTs to that campaign's /join endpoint.
    document.getElementById('formJoin').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(10);
    t('submitting the join face POSTs to /campaigns/c-join-me/join',
      calls.some((c) => /\/api\/campaigns\/c-join-me\/join$/.test(c.path) && c.method === 'POST'));
  }

  // ── 401 on boot → navigate('/') ────────────────────────────────────────────
  {
    const dom = makeDom();
    const { window } = dom;
    installFakeIo(window);
    stubApi(window, { meStatus: 401 });
    let navHref = null;
    evalApp(window, (w) => { w.VTTCommon.navigate = (u) => { navHref = u; }; });
    await wait(30);
    t('an unauthenticated boot navigates to /', navHref === '/', String(navHref));
  }

  // ── lobby fakes: subscribe recorded; presence/state/evicted applied ────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    const io = installFakeIo(window);
    stubApi(window, { campaigns: [OWNED] });
    evalApp(window);
    await wait(20);
    // connect → subscribe emitted.
    io.sock.fire('connect');
    await wait(5);
    t('on connect the client emits lobby:subscribe',
      io.emits.some((e) => e.ev === 'lobby:subscribe'));
    t('connState is cleared on connect', document.getElementById('connState').textContent === '');

    // lobby:presence updates the owned card's .card-online.
    io.sock.fire('lobby:presence', { campaign_id: 'c-owned', online: 2 });
    await wait(5);
    const owned = document.querySelector('[data-id="c-owned"]');
    t('lobby:presence updates the card to "2 at the table"',
      /2 at the table/.test(owned.querySelector('.card-online').textContent),
      owned.querySelector('.card-online').textContent);

    // campaign:state closes the table → pill flips to Closed; GM keeps Enter.
    io.sock.fire('campaign:state', { campaign_id: 'c-owned', is_open: false });
    await wait(5);
    t('campaign:state flips the pill to Closed',
      owned.querySelector('.pill-state').textContent === 'Closed');
    t('...and the GM keeps the Enter link (preps inside a closed game)',
      !!owned.querySelector('.card-enter'));

    // disconnect → connState shows Reconnecting…
    io.sock.fire('disconnect');
    await wait(5);
    t('disconnect shows Reconnecting… in connState',
      /Reconnecting/.test(document.getElementById('connState').textContent));

    // campaign:evicted triggers a /mine refetch.
    const before = window.fetch.__mineCount || 0;
    let mineHits = 0;
    const origFetch = window.fetch;
    window.fetch = async (path, o) => { if (/\/api\/campaigns\/mine/.test(path)) mineHits += 1; return origFetch(path, o); };
    io.sock.fire('campaign:evicted', { campaign_id: 'c-owned' });
    await wait(10);
    t('campaign:evicted refetches the list', mineHits >= 1, String(mineHits));
  }

  // ── profile logout posts /logout then navigates to / ───────────────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    let navHref = null;
    evalApp(window, (w) => { w.VTTCommon.navigate = (u) => { navHref = u; }; });
    await wait(20);
    document.getElementById('pfLogout').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('logout POSTs /api/auth/logout', calls.some((c) => /\/api\/auth\/logout$/.test(c.path) && c.method === 'POST'));
    t('logout then navigates to /', navHref === '/', String(navHref));
  }

  // ── Account ID card: opens unfocused, inline edit, unsaved-guard on close ───
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    t('account modal opens', document.getElementById('profileDialog').open === true);
    // #2: nothing pre-selected — no input is the active element on open.
    t('opens with no field focused', !document.activeElement || document.activeElement.tagName !== 'INPUT');
    // Focus lands on the (focusable) heading, never the close ✕ — otherwise
    // Safari draws a focus box around the ✕ on open.
    t('the heading is focusable', document.getElementById('pfHeading').getAttribute('tabindex') === '-1');
    t('focus is not on the close button', !(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('card-close')));
    t('Save is hidden until something changes', document.getElementById('pfSaveBtn').hasAttribute('hidden'));
    t('identity fields are filled', document.getElementById('pfUsername').textContent.length > 0);
    // Email is shown masked (keep first/last of the username + first domain label).
    t('the email is displayed masked, not in the clear',
      document.getElementById('pfEmail').textContent === 'me@e*****e.com',
      document.getElementById('pfEmail').textContent);
    // Save gates on a COMPLETE change: one field of the email/password pair isn't
    // enough. Open password, fill only the current field → Save stays hidden.
    document.getElementById('pfPasswordBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('pwCurrent').value = 'onlycurrent';
    document.getElementById('pwCurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('one password field filled → Save still hidden', document.getElementById('pfSaveBtn').hasAttribute('hidden'));
    document.getElementById('pwNew').value = 'thenewone';
    document.getElementById('pwNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('both password fields filled → Save appears', !document.getElementById('pfSaveBtn').hasAttribute('hidden'));
    document.getElementById('pwNew').value = '';
    document.getElementById('pwNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('clearing one field again → Save hides', document.getElementById('pfSaveBtn').hasAttribute('hidden'));
    // Reset for the following name-edit checks.
    document.getElementById('pwCurrent').value = '';
    document.getElementById('pwCurrent').dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('pfPasswordBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // #1: Name edits in place — clicking Change swaps the text for an input in
    // the same spot (no dropped-down field).
    t('name shows as text, input hidden initially',
      !document.getElementById('pfUsername').hasAttribute('hidden')
      && document.getElementById('pfNameInput').hasAttribute('hidden'));
    document.getElementById('pfUsernameBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('clicking Change turns the name into an in-place input',
      document.getElementById('pfUsername').hasAttribute('hidden')
      && !document.getElementById('pfNameInput').hasAttribute('hidden'));
    t('the Change button becomes "Cancel" while editing',
      document.getElementById('pfUsernameBtn').textContent === 'Cancel');
    // Editing + Save auto-collapses the name editor (no separate "Done" step).
    document.getElementById('pfNameInput').value = 'renamed';
    document.getElementById('pfNameInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('pfSaveBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    t('saving collapses the name editor back to text',
      document.getElementById('pfNameInput').hasAttribute('hidden')
      && !document.getElementById('pfUsername').hasAttribute('hidden'));
    t('...and the button returns to "Change"',
      document.getElementById('pfUsernameBtn').textContent === 'Change');
    // Editing marks dirty → Save appears.
    const nameF = document.getElementById('pfNameInput');
    nameF.value = 'renamed'; nameF.dispatchEvent(new window.Event('input', { bubbles: true }));
    t('editing reveals Save', !document.getElementById('pfSaveBtn').hasAttribute('hidden'));
  }

  // #3: clicking the framed photo opens the image picker directly.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('avatar input is hidden (picker writes to it)', document.getElementById('pfAvatarInput').type === 'hidden');
    const pickerUp = window.VTTImagePicker && window.VTTImagePicker.isOpen();
    t('picker starts closed', pickerUp === false);
    document.getElementById('pfAvatarBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('clicking the photo opens the image picker', window.VTTImagePicker.isOpen() === true);
  }

  // Accordion: opening one editor collapses any other open one AND clears its
  // unsaved fields, recomputing whether anything is still pending.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    const g = (id) => document.getElementById(id);
    // Open email, fill BOTH fields → a complete change, so Save shows.
    g('pfEmailBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    g('emNew').value = 'typed@example.com';
    g('emNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    g('emPassword').value = 'currentpw';
    g('emPassword').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('email editor is open and (both fields filled) Save shows', !g('pfEmailEdit').hasAttribute('hidden') && !g('pfSaveBtn').hasAttribute('hidden'));
    // Open password → email collapses, its field clears, Save hides (nothing left pending).
    g('pfPasswordBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('opening password collapses the email editor', g('pfEmailEdit').hasAttribute('hidden'));
    t('...and clears the abandoned email field', g('emNew').value === '');
    t('...and resets the email button to Change', g('pfEmailBtn').textContent === 'Change');
    t('...and the password editor is now open', !g('pfPasswordEdit').hasAttribute('hidden'));
    t('...and Save hides again (the email change was dropped)', g('pfSaveBtn').hasAttribute('hidden'));
    // A name change must survive being collapsed only by reverting (accordion clears it).
    g('pfUsernameBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // open name (collapses pw)
    g('pfNameInput').value = 'brandnew';
    g('pfNameInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('changing the name shows Save', !g('pfSaveBtn').hasAttribute('hidden'));
    g('pfEmailBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // open email → collapses name
    t('opening another editor reverts the abandoned name', g('pfNameInput').value === g('pfUsername').textContent);
    t('...and Save hides (the name revert dropped the only change)', g('pfSaveBtn').hasAttribute('hidden'));
  }

  // animateResize: the universal FLIP-height helper. Build a minimal DOM with a
  // height stub so the animation path (not the 0-height fallback) runs.
  {
    const { JSDOM } = require('jsdom');
    const d = new JSDOM('<!doctype html><div id="box"><p id="hid" hidden>x</p></div>', { runScripts: 'outside-only' });
    const w = d.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // Report a taller box once the hidden child is shown.
    w.Element.prototype.getBoundingClientRect = function () {
      const shown = this.id === 'box' && !w.document.getElementById('hid').hidden;
      return { height: shown ? 200 : 100, width: 100, top: 0, left: 0, right: 100, bottom: 0 };
    };
    w.eval(fs.readFileSync('public/js/common.js', 'utf8'));
    const C = w.VTTCommon;
    const box = w.document.getElementById('box'), hid = w.document.getElementById('hid');
    C.animateResize(box, function () { hid.hidden = false; });
    t('animateResize applies the mutation', hid.hidden === false);
    t('...locks the start height and transitions to the end height',
      box.style.height === '200px' && /height/.test(box.style.transition));
    t('...hides overflow during the animation', box.style.overflow === 'hidden');
    // Complete the transition → inline styles clear back to auto.
    const ev = new w.Event('transitionend'); ev.propertyName = 'height';
    Object.defineProperty(ev, 'target', { value: box });
    box.dispatchEvent(ev);
    t('...clears inline height/transition/overflow when done',
      box.style.height === '' && box.style.transition === '' && box.style.overflow === '');
  }

  // animateResize honours reduced-motion: apply instantly, never lock a height.
  {
    const { JSDOM } = require('jsdom');
    const d = new JSDOM('<!doctype html><div id="box"><p id="hid" hidden>x</p></div>', { runScripts: 'outside-only' });
    const w = d.window;
    w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.getBoundingClientRect = function () { return { height: 100, width: 100, top: 0, left: 0, right: 100, bottom: 0 }; };
    w.eval(fs.readFileSync('public/js/common.js', 'utf8'));
    const box = w.document.getElementById('box'), hid = w.document.getElementById('hid');
    w.VTTCommon.animateResize(box, function () { hid.hidden = false; });
    t('reduced-motion applies the change with no animation',
      hid.hidden === false && box.style.height === '' && box.style.transition === '');
  }

  // #3: closing with unsaved changes prompts Save/Discard/Keep editing.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    document.getElementById('pfUsernameBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const nameF = document.getElementById('pfNameInput');
    nameF.value = 'changed'; nameF.dispatchEvent(new window.Event('input', { bubbles: true }));
    // Attempt to close via the ✕ button.
    document.querySelector('#profileDialog [data-close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('closing a dirty account card opens the confirm', document.getElementById('confirmDialog').open === true);
    t('the account modal stays open meanwhile', document.getElementById('profileDialog').open === true);
    t('the confirm offers a third (Discard) choice', !document.getElementById('cfThird').hasAttribute('hidden'));
    // Discard → the account modal closes.
    document.getElementById('cfThird').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    t('Discard closes the account modal', document.getElementById('profileDialog').open === false);
  }

  // ── change-password / change-email send the keys the server destructures ────
  // The auth routes read camelCase (currentPassword/newPassword/newEmail). In the
  // ID-card modal these are inline editors saved by the single Save button; this
  // asserts the exact wire shape still goes out.
  {
    // Password change on its own — the accordion means only one editor is open,
    // so this and the email test are separate. Asserts the camelCase wire shape.
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    document.getElementById('pfPasswordBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('pwCurrent').value = 'oldpass123';
    document.getElementById('pwNew').value = 'newpass456';
    document.getElementById('pwNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('pfSaveBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    const pw = calls.find((c) => /\/api\/auth\/change-password$/.test(c.path) && c.method === 'POST');
    t('change-password POSTs', !!pw);
    t('...with currentPassword + newPassword (camelCase)',
      pw && pw.body && pw.body.currentPassword === 'oldpass123' && pw.body.newPassword === 'newpass456',
      JSON.stringify(pw && pw.body));
    t('...and NOT snake_case current_password',
      pw && pw.body && !('current_password' in pw.body));
  }
  {
    // Email change on its own — asserts the camelCase wire shape.
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    document.getElementById('pfEmailBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('emNew').value = 'new@example.com';
    document.getElementById('emNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('emPassword').value = 'oldpass123';
    document.getElementById('pfSaveBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    const em = calls.find((c) => /\/api\/auth\/change-email$/.test(c.path) && c.method === 'POST');
    t('change-email POSTs', !!em);
    t('...with newEmail + currentPassword (camelCase)',
      em && em.body && em.body.newEmail === 'new@example.com' && em.body.currentPassword === 'oldpass123',
      JSON.stringify(em && em.body));
  }

  // #2: a change without the current password shows natural language, not the
  // raw "currentPassword is required", and doesn't fire a doomed request.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('profileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    // Enter a new email but leave the current-password field blank.
    document.getElementById('pfEmailBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('emNew').value = 'new@example.com';
    document.getElementById('emNew').dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('pfSaveBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    const msg = document.getElementById('emStatus').textContent;
    t('missing current password shows natural language', /current password/i.test(msg) && !/currentPassword/.test(msg), JSON.stringify(msg));
    t('no doomed change-email request fired', !calls.some((c) => /\/api\/auth\/change-email$/.test(c.path)));
  }

  // ── Create dialog: visibility toggle + submit body + 201 opens Settings ────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('btnCreate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('Create opens its dialog', document.getElementById('createDialog').open === true);
    t('password field hidden while Public is selected',
      document.getElementById('crPasswordField').hasAttribute('hidden'));
    const crVis = document.getElementById('crVis');
    crVis.value = 'private';
    crVis.dispatchEvent(new window.Event('change', { bubbles: true }));
    t('choosing Private reveals the password field',
      !document.getElementById('crPasswordField').hasAttribute('hidden'));
    document.getElementById('crName').value = 'My New Game';
    document.getElementById('crPassword').value = 'secret';
    document.getElementById('formCreate').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    const createCall = calls.find((c) => /\/api\/campaigns$/.test(c.path) && c.method === 'POST');
    t('Create POSTs to /api/campaigns', !!createCall);
    t('...with the name, is_public:false and the password',
      createCall && createCall.body.name === 'My New Game'
      && createCall.body.is_public === false && createCall.body.password === 'secret',
      JSON.stringify(createCall && createCall.body));
    // The new flow reloads the list and auto-expands the new card so its inline
    // Overview (with the cover picker) is right there.
    await wait(20);
    const newCard = document.querySelector('[data-id="c-new"]');
    t('on 201 the new card is rendered', !!newCard);
    t('...and it is auto-expanded', newCard && newCard.getAttribute('data-expanded') === 'true');
  }

  // ── Create with Public: no password key in the body ────────────────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const calls = stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('btnCreate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('crName').value = 'Public Game';
    document.getElementById('formCreate').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    const createCall = calls.find((c) => /\/api\/campaigns$/.test(c.path) && c.method === 'POST');
    t('a public create sends is_public:true and NO password key',
      createCall && createCall.body.is_public === true && !('password' in createCall.body),
      JSON.stringify(createCall && createCall.body));
  }

  // ── Transfer ownership is a per-member action with a warning ───────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const members = [
      { user_id: 'u-self', username: 'selene', is_gm: true, status: 'active', joined_at: '2026-01-01', avatar_url: null },
      { user_id: 'u-bob', username: 'bob', is_gm: false, status: 'active', joined_at: '2026-01-02', avatar_url: 'http://x/bob.png' },
    ];
    const calls = stubApi(window, { members });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="' + OWNED.id + '"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    panelEl(document, '.cd-tab-mem').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const panel = openPanel(document);
    const rows = panel.querySelectorAll('.member-row');
    const bobRow = Array.prototype.find.call(rows, (r) => /bob/.test(r.textContent));
    t('a member row exists for the other player', !!bobRow);
    const labels = Array.prototype.map.call(bobRow.querySelectorAll('button'), (b) => b.textContent);
    t('the row has Make owner alongside Kick and Ban',
      labels.indexOf('Make owner') !== -1 && labels.indexOf('Kick') !== -1 && labels.indexOf('Ban') !== -1,
      labels.join('/'));
    t('there is no separate transfer dropdown any more', !panel.querySelector('.cd-transfer-sel'));
    const mk = Array.prototype.find.call(bobRow.querySelectorAll('button'), (b) => b.textContent === 'Make owner');
    mk.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('Make owner opens a confirmation naming the player', /bob/.test(document.getElementById('cfTitle').textContent) && /owner/i.test(document.getElementById('cfTitle').textContent));
    t('...with a warning about the consequences', /GM|control|player/i.test(document.getElementById('cfBody').textContent));
    t('...styled as a weighty (danger) confirm', document.getElementById('cfOk').classList.contains('danger'));
    const before = calls.length;
    document.getElementById('cfOk').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    const transfer = calls.slice(before).find((c) => /\/transfer$/.test(c.path) && c.method === 'POST');
    t('confirming POSTs the transfer with the target user_id',
      transfer && transfer.body && transfer.body.user_id === 'u-bob',
      JSON.stringify(transfer && transfer.body));
  }

  // ── a very long username is capped in confirm prompts (layout guard) ───────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const longName = 'bignamelocomanbignamelocomanbi';   // 30 chars
    const members = [
      { user_id: 'u-self', username: 'selene', is_gm: true, status: 'active', joined_at: '2026-01-01', avatar_url: null },
      { user_id: 'u-long', username: longName, is_gm: false, status: 'active', joined_at: '2026-01-02', avatar_url: null },
    ];
    stubApi(window, { members });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="' + OWNED.id + '"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    panelEl(document, '.cd-tab-mem').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const panel = openPanel(document);
    const row = Array.prototype.find.call(panel.querySelectorAll('.member-row'), (r) => r.getAttribute('data-user') === 'u-long');
    t('the member row still carries the full name in the DOM', /bignamelocoman/.test(row.textContent));
    Array.prototype.find.call(row.querySelectorAll('button'), (b) => b.textContent === 'Kick')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const title = document.getElementById('cfTitle').textContent;
    t('the confirm title truncates the long name with an ellipsis',
      title.indexOf('…') !== -1 && title.length < ('Kick ' + longName + '?').length, title);
  }

  // ── Overview is an ID-card: value-text rows, GM inline-edit, player read-only ─
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const g = Object.assign({}, OWNED, { id: 'c-gm', name: 'My Realm', description: 'Epic', is_public: true });
    stubApi(window, { campaigns: [g] });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-gm"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    // The name lives in the header title now; joining/facts in the grid.
    t('the header title shows the name', panelEl(document, '.cp-head-text .cd-title').textContent === 'My Realm');
    t('the title is the name edit target', panelEl(document, '.cd-title').classList.contains('cd-name-text'));
    t('Enter the game is in the header, not the actions row',
      !!panelEl(document, '.cp-head-text .cd-enter') && !panelEl(document, '.cd-actions .cd-enter'));
    t('the Name row is gone from the Overview grid', !panelEl(document, '.ovcard .cd-name-text'));
    t('Overview shows the description as value text', panelEl(document, '.cd-desc-text').textContent === 'Epic');
    t('Overview shows joining as readable text', /anyone/i.test(panelEl(document, '.cd-vis-text').textContent));
    t('joining is grouped with the facts in a Details block',
      !!panelEl(document, '.ov-details .cd-vis-text')
      && !!panelEl(document, '.ov-details .cd-status')
      && !!panelEl(document, '.ov-details .cd-created'));
    t('the description is its own full-width block above the details',
      !panelEl(document, '.ov-details .cd-desc-text') && !!panelEl(document, '.ovcard-desc .cd-desc-text'));
    t('the small cover portrait is gone', !panelEl(document, '.ovcard-photo'));
    // GM: the cover is edited via the banner button (the "portrait" is gone).
    t('the GM sees the cover edit button on the banner', !panelEl(document, '.cd-cover-btn').hasAttribute('hidden'));
    t('the GM sees edit affordances on name/description/joining',
      !panelEl(document, '.cd-name-btn').hasAttribute('hidden')
      && !panelEl(document, '.cd-desc-btn').hasAttribute('hidden')
      && !panelEl(document, '.cd-vis-btn').hasAttribute('hidden'));
    t('the description and joining edits are pencil icons, not "Change" text',
      !!panelEl(document, '.cd-desc-btn .idcard-edit-icon') && panelEl(document, '.cd-desc-btn').textContent.trim() === ''
      && !!panelEl(document, '.cd-vis-btn .idcard-edit-icon') && panelEl(document, '.cd-vis-btn').textContent.trim() === '');
    // Clicking the title's pencil reveals the name input in the header.
    panelEl(document, '.cd-name-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('the title pencil reveals the name input', !panelEl(document, '.cd-f-name').hasAttribute('hidden') && panelEl(document, '.cd-title').hasAttribute('hidden'));
    panelEl(document, '.cd-desc-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('description edits in place (textarea replaces the text, not below it)',
      panelEl(document, '.cd-desc-text').hasAttribute('hidden') && !panelEl(document, '.cd-f-desc').hasAttribute('hidden'));
    t('opening description collapses the name editor (accordion)',
      panelEl(document, '.cd-f-name').hasAttribute('hidden'));
    // Editing + Save collapses every editor back to display.
    panelEl(document, '.cd-f-desc').value = 'New epic';
    panelEl(document, '.cd-f-desc').dispatchEvent(new window.Event('input', { bubbles: true }));
    panelEl(document, '.cd-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    t('saving collapses the Overview editors',
      panelEl(document, '.cd-f-desc').hasAttribute('hidden') && panelEl(document, '.cd-vis-edit').hasAttribute('hidden'));
  }
  {
    // A player (is_gm:false) sees a read-only Overview: static cover, no Change.
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const played = Object.assign({}, OWNED, { id: 'c-play', is_gm: false, owner_username: 'gandalf', img_url: 'http://x/c.png' });
    stubApi(window, { campaigns: [played] });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-play"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('a player does not see the cover edit button',
      panelEl(document, '.cd-cover-btn').hasAttribute('hidden'));
    t('a player sees no Change buttons',
      panelEl(document, '.cd-name-btn').hasAttribute('hidden')
      && panelEl(document, '.cd-desc-btn').hasAttribute('hidden')
      && panelEl(document, '.cd-vis-btn').hasAttribute('hidden'));
  }

  // ── regressions: open/close updates the button; click-away works after it ──
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); // reduce-motion → instant collapse
    installFakeIo(window);
    let st = Object.assign({}, OWNED, { id: 'c-tog', is_open: true });
    const calls = stubApi(window, { campaigns: [st] });
    // reflect is_open back on PATCH so the button can update
    const origFetch = window.fetch;
    window.fetch = async (p, o = {}) => {
      const m = (o && o.method) || 'GET';
      if (/\/api\/campaigns\/c-tog$/.test(p) && m === 'PATCH') {
        st = Object.assign(st, JSON.parse(o.body));
        return { status: 200, json: async () => ({ campaign: st }) };
      }
      return origFetch(p, o);
    };
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-tog"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const oc = panelEl(document, '.cd-openclose');
    t('open/close button starts on "Close the table"', /close the table/i.test(oc.textContent), oc.textContent);
    oc.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    // BUG 2: the label must flip to "Open the table" (not stay on the stale label).
    t('toggling open/close updates the button label', /open the table/i.test(panelEl(document, '.cd-openclose').textContent), panelEl(document, '.cd-openclose').textContent);
    // BUG 3: after the toggle, a scrim click must still close the overlay.
    t('the card is still expanded after the toggle', document.querySelector('[data-id="c-tog"]').getAttribute('data-expanded') === 'true');
    document.getElementById('cardOverlayScrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    t('clicking away closes the modal after a toggle', document.querySelector('[data-id="c-tog"]').getAttribute('data-expanded') === 'false');
  }

  // ── the name is edited via the big header title (not an Overview row) ──────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    installFakeIo(window);
    let st = Object.assign({}, OWNED, { id: 'c-nm', name: 'Old Name' });
    const origState = st;
    stubApi(window, { campaigns: [st] });
    const of = window.fetch;
    window.fetch = async (p, o = {}) => {
      const m = (o && o.method) || 'GET';
      if (/\/api\/campaigns\/c-nm$/.test(p) && m === 'PATCH') { st = Object.assign(st, JSON.parse(o.body)); return { status: 200, json: async () => ({ campaign: st }) }; }
      return of(p, o);
    };
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-nm"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('the header title shows the current name', panelEl(document, '.cd-title').textContent === 'Old Name');
    // Click the pencil → the title becomes an input carrying the name.
    panelEl(document, '.cd-name-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const input = panelEl(document, '.cd-f-name');
    t('editing swaps the title for an input with the name', !input.hasAttribute('hidden') && input.value === 'Old Name');
    // The input sits in the same title-line slot and the pencil stays put beside it.
    t('the name input shares the title line (no layout shift on edit)', !!panelEl(document, '.cd-title-line .cd-f-name'));
    t('the rename pencil stays visible while editing', !panelEl(document, '.cd-name-btn').hasAttribute('hidden'));
    input.value = 'Fresh Name';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    panelEl(document, '.cd-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    t('saving updates the header title and restores it', panelEl(document, '.cd-title').textContent === 'Fresh Name' && !panelEl(document, '.cd-title').hasAttribute('hidden'));
    t('the PATCH carried the new name', st.name === 'Fresh Name');
  }
  {
    // A player sees the title but no pencil, and no Enter-in-actions leakage.
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const played = Object.assign({}, OWNED, { id: 'c-ro', is_gm: false, owner_username: 'gandalf' });
    stubApi(window, { campaigns: [played] });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-ro"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('a player sees no rename pencil on the title', panelEl(document, '.cd-name-btn').hasAttribute('hidden'));
  }

  // ── the settings password-omit semantics (now inline in the expanded card) ─
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const priv = Object.assign({}, OWNED, { id: 'c-priv', is_public: false, has_password: true });
    const calls = stubApi(window, { campaigns: [priv] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="c-priv"]');
    // Expand the card; its panel (with the edit fields) moves to the overlay.
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const pwField = panelEl(document, '.cd-f-pw');
    const save = panelEl(document, '.cd-save');
    // Blank password, still private → editing something reveals Save; save omits password.
    panelEl(document, '.cd-f-desc').value = 'edited';
    panelEl(document, '.cd-f-desc').dispatchEvent(new window.Event('input', { bubbles: true }));
    t('editing a field reveals the Save button', !save.hasAttribute('hidden'));
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    const patch1 = calls.filter((c) => /\/api\/campaigns\/c-priv$/.test(c.path) && c.method === 'PATCH').pop();
    t('inline save omits password when the field is blank (stays private)',
      patch1 && !('password' in patch1.body), JSON.stringify(patch1 && patch1.body));
    t('...and still sends is_public:false', patch1 && patch1.body.is_public === false);
    // Now type a password → it is sent.
    pwField.value = 'newpass';
    pwField.dispatchEvent(new window.Event('input', { bubbles: true }));
    panelEl(document, '.cd-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    const patch2 = calls.filter((c) => /\/api\/campaigns\/c-priv$/.test(c.path) && c.method === 'PATCH').pop();
    t('inline save sends the password when the field has a value',
      patch2 && patch2.body.password === 'newpass', JSON.stringify(patch2 && patch2.body));
  }

  // ── Joining uses the themed dropdown; public→private requires a password ────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    // A PUBLIC game with no existing password — the risky transition.
    const pub = Object.assign({}, OWNED, { id: 'c-pub', is_public: true, has_password: false });
    const calls = stubApi(window, { campaigns: [pub] });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-pub"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    // Open the Joining editor.
    panelEl(document, '.cd-vis-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('Joining is the themed dropdown, not a native <select>',
      !!panelEl(document, '.cd-vis-dd .vtt-dd-btn') && !panelEl(document, '.cd-vis-edit select'));
    // Drive it to "Password" via the dropdown option.
    panelEl(document, '.cd-vis-dd .vtt-dd-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const opts = panelEl(document, '.cd-vis-dd .vtt-dd-list').querySelectorAll('.vtt-dd-opt');
    Array.prototype.find.call(opts, (o) => /password/i.test(o.textContent)).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('choosing Password sets the value and reveals the password field',
      panelEl(document, '.cd-f-vis').value === 'private' && !panelEl(document, '.cd-pw-field').hasAttribute('hidden'));
    // Save with a blank password → blocked, no PATCH, friendly message.
    const before = calls.filter((c) => /\/c-pub$/.test(c.path) && c.method === 'PATCH').length;
    panelEl(document, '.cd-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    const after = calls.filter((c) => /\/c-pub$/.test(c.path) && c.method === 'PATCH').length;
    t('making a public game private with no password is blocked before any request', after === before);
    t('...with a message telling the user to set a password', /set a password/i.test(panelEl(document, '.cd-status-msg').textContent));
    // Provide a password → it saves, sending password + is_public:false.
    panelEl(document, '.cd-f-pw').value = 'hunter2x';
    panelEl(document, '.cd-f-pw').dispatchEvent(new window.Event('input', { bubbles: true }));
    panelEl(document, '.cd-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    const patch = calls.filter((c) => /\/c-pub$/.test(c.path) && c.method === 'PATCH').pop();
    t('once a password is set, the private switch saves with it',
      patch && patch.body.is_public === false && patch.body.password === 'hunter2x', JSON.stringify(patch && patch.body));
  }

  // ── the description textarea grows to fit its content (no manual resize) ────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    // jsdom has no layout, so fake scrollHeight from the line count.
    Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true, get() { return (String(this.value).split('\n').length * 20) + 40; },
    });
    installFakeIo(window);
    stubApi(window, { campaigns: [Object.assign({}, OWNED, { id: 'c-ag', description: 'one line' })] });
    evalApp(window);
    await wait(20);
    document.querySelector('[data-id="c-ag"] .card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    panelEl(document, '.cd-desc-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const ta = panelEl(document, '.cd-f-desc');
    const short = parseInt(ta.style.height, 10) || 0;
    ta.value = 'a\nb\nc\nd\ne\nf\ng'; ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    const tall = parseInt(ta.style.height, 10) || 0;
    t('the description textarea grows as content is added', tall > short, short + ' -> ' + tall);
  }

  // ── Find search renders enriched rows (owner + description + thumb) ────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const results = [
      { id: 'c-s1', name: 'Public Realm', description: 'come one come all', img_url: 'http://x/cover.png',
        is_public: true, is_open: true, has_password: false, owner_username: 'gandalf', member_count: 3 },
      { id: 'c-s2', name: 'Secret Lair', description: 'members only', img_url: null,
        is_public: false, is_open: true, has_password: true, owner_username: 'saruman', member_count: 1 },
      // A game I already belong to (matches OWNED.id from /mine), and a full one.
      { id: OWNED.id, name: 'My Own Realm', description: '', img_url: null,
        is_public: true, is_open: true, has_password: false, owner_username: 'selene', member_count: 2 },
      { id: 'c-full', name: 'Packed House', description: '', img_url: null,
        is_public: true, is_open: true, has_password: false, owner_username: 'sauron', member_count: 8 },
    ];
    stubApi(window, { search: results });
    evalApp(window);
    await wait(20);
    document.getElementById('btnFind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    document.getElementById('fdQuery').value = 'realm';
    document.getElementById('formFind').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(25);
    const rows = document.querySelectorAll('#fdResults .find-card');
    t('search renders a card per result', rows.length === 4, String(rows.length));
    const r1 = document.querySelector('#fdResults [data-id="c-s1"]');
    t('result shows the owner name', /by gandalf/.test(r1.querySelector('.find-body').textContent));
    t('result no longer shows a description', !r1.querySelector('.find-desc'));
    t('result with a cover renders an <img> thumbnail', !!r1.querySelector('.find-thumb img'));
    const r2 = document.querySelector('#fdResults [data-id="c-s2"]');
    t('result without a cover uses the mask thumbnail', r2.querySelector('.find-thumb').classList.contains('mask'));
    t('private (joinable) result has a Join button', !!Array.prototype.find.call(r2.querySelectorAll('button'), (b) => b.textContent === 'Join'));
    // Only the password-required game carries a lock tag; the open one shows none.
    t('a public game shows NO "anyone" tag', !r1.querySelector('.find-lock') && !/anyone/i.test(r1.textContent));
    t('a private game shows a Password lock tag', !!r2.querySelector('.find-lock') && /password/i.test(r2.querySelector('.find-lock').textContent));
    // #5: membership + capacity states replace the Join button.
    const rMine = document.querySelector('#fdResults [data-id="' + OWNED.id + '"]');
    t('a game I already belong to shows "Already joined" (no Join button)',
      /already joined/i.test(rMine.textContent) && !rMine.querySelector('button.btn'),
      rMine.querySelector('.find-actions').textContent);
    const rFull = document.querySelector('#fdResults [data-id="c-full"]');
    t('a full game shows "Full" in the danger state (no Join button)',
      /full/i.test(rFull.textContent) && !!rFull.querySelector('.find-state.full') && !rFull.querySelector('button.btn'));
  }

  // ── the visibility filter is a custom themed dropdown (not a native select) ──
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window);
    evalApp(window);
    await wait(20);
    document.getElementById('btnFind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('the Show control is not a native <select>', !document.querySelector('#fdVisDD select'));
    const ddBtn = document.getElementById('fdVisBtn');
    const ddList = document.getElementById('fdVisList');
    t('the dropdown starts closed', ddList.hasAttribute('hidden') && document.getElementById('fdVis').value === 'all');
    ddBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('clicking the control opens a themed option list', !ddList.hasAttribute('hidden'));
    const opts = ddList.querySelectorAll('.vtt-dd-opt');
    t('the list has the three options', opts.length === 3);
    opts[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('choosing an option writes its value to the hidden input', document.getElementById('fdVis').value === 'private');
    t('...updates the button label', ddBtn.textContent === 'Password-protected');
    t('...and closes the list', ddList.hasAttribute('hidden'));
  }

  // ── archive / unarchive from the expanded card (any member, both ways) ─────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    // A game I only PLAY in (is_gm:false) — archive must still be offered.
    const played = Object.assign({}, CLOSED_AS_PLAYER, { id: 'c-play', is_open: true, archived: false });
    const calls = stubApi(window, { campaigns: [played] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="c-play"]');
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const btn = panelEl(document, '.cd-archive');
    t('a played (non-GM) game still offers Archive in the expanded card', !!btn && btn.textContent === 'Archive');
    t('...and a player does NOT see the delete danger zone', panelEl(document, '.cd-danger').hasAttribute('hidden'));
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('clicking Archive POSTs /archive', calls.some((c) => /\/api\/campaigns\/c-play\/archive$/.test(c.path) && c.method === 'POST'));
    t('archive closes the overlay too', document.getElementById('cardOverlay').hasAttribute('hidden'));
  }
  {
    // An already-archived card offers Unarchive (the revert path).
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const arch = Object.assign({}, OWNED, { id: 'c-arch', archived: true });
    const calls = stubApi(window, { campaigns: [arch] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="c-arch"]');
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // Wait long enough for loadMembers() to resolve — the detail response omits
    // `archived`, and a wholesale c-replacement here used to flip the button.
    await wait(60);
    const btn = panelEl(document, '.cd-archive');
    t('an archived game still shows Unarchive after members load', btn.textContent === 'Unarchive');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('clicking Unarchive POSTs /unarchive (not /archive)',
      calls.some((c) => /\/api\/campaigns\/c-arch\/unarchive$/.test(c.path) && c.method === 'POST'));
    t('does NOT post to /archive (the bug sent the wrong endpoint)',
      !calls.some((c) => /\/api\/campaigns\/c-arch\/archive$/.test(c.path) && c.method === 'POST'));
    // Regression: the game leaves the current view, so the overlay must close —
    // otherwise the panel is orphaned over a rebuilt grid and looks frozen.
    t('unarchive closes the overlay (no orphaned panel)',
      document.getElementById('cardOverlay').hasAttribute('hidden')
      && !document.getElementById('cardOverlayStage').querySelector('.card-panel'));
    t('...and unlocks background scroll', !document.body.classList.contains('overlay-open'));
  }

  // ── Find pagination: Load more appends a second page ───────────────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    // Server returns a FULL page (20) first, then a short page (2) → then stops.
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      id: 'p1-' + i, name: 'Game ' + i, is_public: true, is_open: true, has_password: false,
      owner_username: 'gm' + i, member_count: 1,
    }));
    const page2 = [
      { id: 'p2-a', name: 'Extra A', is_public: true, is_open: true, has_password: false, owner_username: 'z', member_count: 1 },
      { id: 'p2-b', name: 'Extra B', is_public: true, is_open: true, has_password: false, owner_username: 'y', member_count: 1 },
    ];
    // Offset-aware fake search.
    const calls = [];
    window.fetch = async (path, o = {}) => {
      const method = o.method || 'GET';
      calls.push({ path, method });
      const reply = (s, d) => ({ status: s, json: async () => d });
      if (/\/api\/auth\/me$/.test(path)) return reply(200, { user: USER });
      if (/\/api\/campaigns\/mine/.test(path)) return reply(200, { campaigns: [] });
      if (/\/api\/campaigns\/deleted$/.test(path)) return reply(200, { campaigns: [] });
      if (/\/api\/campaigns\/search/.test(path)) {
        const m = /offset=(\d+)/.exec(path);
        const offset = m ? Number(m[1]) : 0;
        return reply(200, { campaigns: offset === 0 ? page1 : page2 });
      }
      return reply(200, {});
    };
    evalApp(window);
    await wait(20);
    document.getElementById('btnFind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('formFind').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    t('first search page renders 20 rows', document.querySelectorAll('#fdResults .find-card').length === 20);
    t('Load more is shown after a full page', !document.getElementById('fdMore').hasAttribute('hidden'));
    document.getElementById('fdMore').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    t('Load more APPENDS the next page (22 total)', document.querySelectorAll('#fdResults .find-card').length === 22);
    t('the second request used offset=20', calls.some((c) => /search.*offset=20/.test(c.path)));
    t('Load more hides after a short page', document.getElementById('fdMore').hasAttribute('hidden'));
  }

  // ── expand / collapse / accordion / inline-edit / unsaved-guard ────────────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const g1 = Object.assign({}, OWNED, { id: 'e-1', name: 'One' });
    const g2 = Object.assign({}, OWNED, { id: 'e-2', name: 'Two' });
    stubApi(window, { campaigns: [g1, g2] });
    evalApp(window);
    await wait(20);
    const c1 = document.querySelector('[data-id="e-1"]');
    const c2 = document.querySelector('[data-id="e-2"]');
    const overlay = document.getElementById('cardOverlay');
    const stage = document.getElementById('cardOverlayStage');

    // expand c1 → panel floats into the overlay stage
    c1.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('clicking a card expands it', c1.getAttribute('data-expanded') === 'true');
    t('the overlay is shown', !overlay.hasAttribute('hidden'));
    t('the panel is moved into the overlay stage', !!stage.querySelector('.card-panel'));
    t('body scroll is locked', document.body.classList.contains('overlay-open'));
    t('head aria-expanded reflects state', c1.querySelector('.card-head').getAttribute('aria-expanded') === 'true');
    t('the floating panel fills its title', panelEl(document, '.cd-title').textContent === 'One');
    t('GM sees editable name field', !panelEl(document, '.cd-f-name').hasAttribute('readonly'));
    t('GM sees the delete danger zone', !panelEl(document, '.cd-danger').hasAttribute('hidden'));
    t('pinned head + scroll body structure present',
      !!panelEl(document, '.cp-head') && !!panelEl(document, '.cp-body'));

    // accordion: expanding c2 collapses c1 (only one panel in the stage)
    c2.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(40);
    t('opening another card collapses the first (accordion)', c1.getAttribute('data-expanded') === 'false');
    t('the second card is now expanded', c2.getAttribute('data-expanded') === 'true');
    t('the open panel is now the second card', panelEl(document, '.cd-title').textContent === 'Two');

    // collapse c2 by clicking its head again → panel returns, overlay hides
    c2.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(40);
    t('clicking an expanded head collapses it', c2.getAttribute('data-expanded') === 'false');
    t('overlay hidden after close', overlay.hasAttribute('hidden'));
    t('panel returned into its card', !!c2.querySelector('.card-panel'));
    t('scroll unlocked after close', !document.body.classList.contains('overlay-open'));
  }

  // Scrim click and Escape both close the floating card.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window, { campaigns: [Object.assign({}, OWNED, { id: 's-1' })] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="s-1"]');
    // scrim close
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    document.getElementById('cardOverlayScrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('clicking the scrim closes the card', card.getAttribute('data-expanded') === 'false');
    // Escape close
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(30);
    t('pressing Escape closes the card', card.getAttribute('data-expanded') === 'false');
  }

  // Inline edit reveals Save; the unsaved-guard fires on collapse.
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    stubApi(window, { campaigns: [Object.assign({}, OWNED, { id: 'u-1' })] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="u-1"]');
    card.querySelector('.card-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('the save bar is hidden before any edit', panelEl(document, '.cd-savebar').hasAttribute('hidden'));
    const nameF = panelEl(document, '.cd-f-name');
    // Reveal the in-place name editor, then type — dirtying shows the save bar.
    panelEl(document, '.cd-name-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    nameF.value = 'Changed'; nameF.dispatchEvent(new window.Event('input', { bubbles: true }));
    t('editing a field reveals the save bar', !panelEl(document, '.cd-savebar').hasAttribute('hidden'));
    t('the save bar carries the Save button and hint',
      !!panelEl(document, '.cd-savebar .cd-save') && !!panelEl(document, '.cd-savebar .cd-save-hint'));
    // The bar is a footer flush at the very bottom of the panel (nothing beneath).
    {
      const p = openPanel(document);
      const bar = p.querySelector('.cd-savebar');
      t('the save bar is the panel\u2019s last child (flush at the bottom)', p.children[p.children.length - 1] === bar);
    }
    // Try to close (via scrim) with unsaved edits → 3-way confirm dialog opens.
    document.getElementById('cardOverlayScrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('closing with unsaved edits opens the confirm dialog', document.getElementById('confirmDialog').open === true);
    t('the confirm shows a third (Discard) button', !document.getElementById('cfThird').hasAttribute('hidden'));
    // "Keep editing" (Cancel) → dialog closes, card stays open.
    document.getElementById('cfCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    t('Keep editing leaves the card expanded', card.getAttribute('data-expanded') === 'true');
    // Discard → collapses without saving.
    document.getElementById('cardOverlayScrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(10);
    document.getElementById('cfThird').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    t('Discard collapses the card', card.getAttribute('data-expanded') === 'false');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SUITE CRASHED:', e);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
