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
      // Create returns 201 with the new campaign (owned, GM).
      const created = Object.assign({}, OWNED, { id: 'c-new', name: body && body.name, is_gm: true });
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
      return reply(200, { campaign: c, members: opts.members || [] });
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
    'findDialog', 'formFind', 'fdQuery', 'fdVis', 'fdSubmit', 'fdStatus', 'fdResults',
    'formJoin', 'jnId', 'jnPasswordField', 'jnPassword', 'jnSubmit', 'jnStatus',
    'campaignDialog', 'cdTitle', 'cdClose', 'cdTabs', 'cdTabOverview', 'cdTabMembers',
    'cdTabSettings', 'cdOverview', 'cdCover', 'cdDesc', 'cdVis', 'cdState', 'cdOnline',
    'cdCreated', 'cdOpenToggle', 'cdEnter', 'cdInvite', 'cdCopyInvite', 'cdLeave', 'cdStatus',
    'cdMembers', 'cdMemberList', 'cdBannedHead', 'cdBannedList', 'cdTransferBlock',
    'cdTransferSel', 'cdTransferBtn', 'cdRefresh', 'cdSettings', 'formSettings', 'stName',
    'stDesc', 'stImg', 'stImgPreview', 'stVis', 'stPasswordField', 'stPassword', 'stStatus',
    'stSubmit', 'stArchive', 'stDelete',
    'profileDialog', 'pfAvatar', 'pfUsername', 'pfEmail', 'pfVerified', 'pfSince',
    'formProfile', 'pfNameInput', 'pfAvatarInput', 'pfSaveBtn', 'pfStatus',
    'formPassword', 'pwCurrent', 'pwNew', 'pwSubmit', 'pwStatus',
    'formEmail', 'emNew', 'emPassword', 'emSubmit', 'emStatus', 'pfLogout',
    'confirmDialog', 'cfTitle', 'cfBody', 'cfCancel', 'cfOk'];
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

    // The owned card: GM badge, Open pill, Enter link present.
    const owned = document.querySelector('[data-id="c-owned"]');
    t('owned card shows GM', owned.querySelector('.badge-role').textContent === 'GM');
    t('owned card owner line reads "by you"', owned.querySelector('.card-owner').textContent === 'by you');
    t('owned card shows Open', owned.querySelector('.pill-state').textContent === 'Open');
    t('owned card has an Enter link to the game', !!owned.querySelector('.card-enter')
      && /game\.html\?campaign=c-owned/.test(owned.querySelector('.card-enter').getAttribute('href')));

    // The closed-as-player card: no Enter, a "closed" note, Details button.
    const closed = document.querySelector('[data-id="c-closed"]');
    t('closed card (player) has NO Enter link', closed.querySelector('.card-enter') === null);
    t('closed card (player) shows a closed note',
      !closed.querySelector('.card-note').hasAttribute('hidden')
      && /Closed/.test(closed.querySelector('.card-note').textContent));
    t('closed card manage button reads "Details" for a player',
      closed.querySelector('.card-manage').textContent === 'Details');
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
    t('on 201 the campaign dialog opens', document.getElementById('campaignDialog').open === true);
    t('...on the Settings tab', document.getElementById('cdTabSettings').getAttribute('aria-selected') === 'true');
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

  // ── Settings password-omit semantics (verified against the PATCH route) ────
  {
    const dom = makeDom();
    const { window, window: { document } } = dom;
    installFakeIo(window);
    const priv = Object.assign({}, OWNED, { id: 'c-priv', is_public: false, has_password: true });
    const calls = stubApi(window, { campaigns: [priv] });
    evalApp(window);
    await wait(20);
    const card = document.querySelector('[data-id="c-priv"]');
    card.querySelector('.card-manage').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(15);
    document.getElementById('cdTabSettings').click();
    document.getElementById('stPassword').value = '';
    document.getElementById('formSettings').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    const patch1 = calls.filter((c) => /\/api\/campaigns\/c-priv$/.test(c.path) && c.method === 'PATCH').pop();
    t('Settings PATCH omits password when the field is blank (stays private)',
      patch1 && !('password' in patch1.body), JSON.stringify(patch1 && patch1.body));
    t('...and still sends is_public:false', patch1 && patch1.body.is_public === false);
    document.getElementById('stPassword').value = 'newpass';
    document.getElementById('formSettings').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    const patch2 = calls.filter((c) => /\/api\/campaigns\/c-priv$/.test(c.path) && c.method === 'PATCH').pop();
    t('Settings PATCH sends the password when the field has a value',
      patch2 && patch2.body.password === 'newpass', JSON.stringify(patch2 && patch2.body));
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
    ];
    stubApi(window, { search: results });
    evalApp(window);
    await wait(20);
    document.getElementById('btnFind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('fdQuery').value = 'realm';
    document.getElementById('formFind').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(15);
    const rows = document.querySelectorAll('#fdResults .result');
    t('search renders a row per result', rows.length === 2, String(rows.length));
    const r1 = document.querySelector('#fdResults [data-id="c-s1"]');
    t('result shows the owner name', /by gandalf/.test(r1.querySelector('.who').textContent));
    t('result shows the description', /come one come all/.test(r1.textContent));
    t('result with a cover renders an <img> thumbnail', !!r1.querySelector('.result-thumb img'));
    const r2 = document.querySelector('#fdResults [data-id="c-s2"]');
    t('result without a cover uses the mask thumbnail', r2.querySelector('.result-thumb').classList.contains('mask'));
    t('private result has a Join button', !!Array.prototype.find.call(r2.querySelectorAll('button'), (b) => b.textContent === 'Join'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SUITE CRASHED:', e);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
