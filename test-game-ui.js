// Game page UI smoke suite. jsdom only — no server, no database:
//   node test-game-ui.js
//
// Same scope and reason as test-landing-ui.js / test-dashboard-ui.js: the game
// shell (public/js/game.js) is a client file with no runtime coverage from any
// server suite, and folding four covered harnesses into one page is the
// riskiest work in the project. This loads the REAL public/game.html + the full
// game script list (theme, common, imagepicker, closednotice, scene, combat,
// actors, sheet, itemsheet, align, game) and asserts the build contract:
//
//   - the page evaluates without throwing, for a GM and for a player;
//   - the id manifest (union − DEAD + SHELL), each id exactly once, DEAD absent;
//   - body.is-gm set only for the GM fixture;
//   - the boot order (scene boots before combat; actors DEFERRED — no
//     VTTActors.boot until the first Characters/Library open, then exactly one);
//   - the tablist keyboard model (roving tabindex, arrows/Home/End);
//   - sidebar collapse toggles aria-expanded;
//   - the rail: railPing arms → a canvas pointerdown calls VTTScene.pingAt →
//     disarms; Esc disarms an armed ping; a rail popover closes on Esc;
//   - Esc clears selection only when nothing is above it (a rail popover open →
//     Esc closes the popover and leaves selection to the canvas);
//   - dialogs open via a recorded showModal and return focus to their invoker;
//   - the player fixture hides railFog/railAlign/railScenes/railConsole and the
//     drawer, and keeps #tokenPop; the GM fixture shows all rail items;
//   - connState: a fake disconnect shows "Reconnecting…"; a fake reconnect
//     re-invokes the boot loaders (scene + combat) to refetch the board;
//   - source probes: no innerHTML in game.js, no inline script/handlers in
//     game.html; the four boot seams exist and the harness input wiring is
//     guarded in each of scene/combat/actors/align.

const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const USER = { id: 'u-self', username: 'selene', avatar_url: null };

// The full game script list, in the page's load order (dice3d is an ES module
// on the page; here it is faked below, so it is not eval'd as a classic script).
const SCRIPTS = [
  'theme.js', 'common.js', 'imagepicker.js', 'closednotice.js',
  'scene.js', 'combat.js', 'actors.js', 'sheet.js', 'itemsheet.js', 'align.js', 'game.js',
];

// A URL-dispatching fake API. Records every call; returns canned game state.
function stubApi(window, opts) {
  opts = opts || {};
  const calls = [];
  const isGm = opts.isGm !== false;
  const activeSceneId = opts.activeSceneId || null;
  window.fetch = async (path, o) => {
    o = o || {};
    calls.push({ path: String(path), method: o.method || 'GET' });
    const reply = (status, data) => ({ status, json: async () => data });
    if (/\/api\/auth\/me$/.test(path)) return reply(200, { user: USER });
    if (/\/api\/campaigns\/[^/]+\/scenes\/[^/]+$/.test(path)) {
      return reply(200, { scene: { id: activeSceneId || 'S1', name: 'Map', width: 1000, height: 800, img_url: null, grid: {} }, tokens: [] });
    }
    if (/\/api\/campaigns\/[^/]+\/scenes$/.test(path)) {
      return reply(200, { scenes: activeSceneId ? [{ id: activeSceneId, name: 'Map', width: 1000, height: 800 }] : [] });
    }
    if (/\/api\/campaigns\/[^/]+$/.test(path)) {
      return reply(200, { campaign: { id: 'C', name: 'Test Table', is_gm: isGm, owner_id: 'GM', active_scene_id: activeSceneId, is_open: true } });
    }
    return reply(200, { tokens: [], members: [], items: [], actors: [], spells: [], assets: [], token: {} });
  };
  return calls;
}

// A recording fake socket.io. Each io() call returns a socket that records its
// handlers and lets the test fire connect/disconnect; emits are recorded too.
function installFakeIo(window) {
  const sockets = [];
  window.io = function () {
    const handlers = {};
    const sock = {
      connected: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      emit(ev, payload, ack) { sock._emits.push({ ev, payload }); if (typeof ack === 'function') ack({ ok: true }); return sock; },
      _emits: [],
      _fire(ev, a) { (handlers[ev] || []).forEach((fn) => fn(a)); },
    };
    sockets.push(sock);
    return sock;
  };
  // The last socket created is the shell's connection-state observer (game.js
  // opens io() last, after scene.js and combat.js).
  window.__sockets = sockets;
  return sockets;
}

function makeDom() {
  const dom = new JSDOM(fs.readFileSync('public/game.html', 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost:3000/game.html?campaign=' + CAMPAIGN_ID,
  });
  const { window } = dom;
  window.matchMedia = (q) => ({
    matches: /reduce/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.requestAnimationFrame = (cb) => window.setTimeout(cb, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.CSS = { escape: (s) => s };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
  window.PointerEvent = class extends window.MouseEvent {
    // button is a read-only getter on MouseEvent; it must come through the init
    // dict passed to super(), not an assignment. pointerId is not a MouseEvent
    // field, so it can be set directly.
    constructor(ty, o) { o = o || {}; super(ty, Object.assign({ button: 0 }, o)); this.pointerId = o.pointerId || 1; }
  };
  // jsdom <dialog> has no showModal/close — stub them to RECORD and reflect state.
  window.__showModalCalls = 0;
  window.document.querySelectorAll('dialog').forEach((d) => {
    d.showModal = function () { window.__showModalCalls += 1; this.open = true; };
    d.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  });
  return dom;
}

// Evaluate the full script list. Returns { window, document, threw, calls }.
// Spies on the four boot seams are installed at the export boundary (right after
// align.js and before game.js), so the boot-order assertions see clean counts.
function bootPage(opts) {
  opts = opts || {};
  const dom = makeDom();
  const { window } = dom;
  const calls = stubApi(window, opts);
  installFakeIo(window);

  const bootSpies = { scene: 0, combat: 0, actors: 0, sceneArgs: [], pingAt: 0 };
  const threw = [];
  for (const s of SCRIPTS) {
    try { window.eval(fs.readFileSync('public/js/' + s, 'utf8')); }
    catch (e) { threw.push(s + ': ' + e.message); }
    if (s === 'align.js') {
      // All four boot exports exist now; wrap them before game.js drives them.
      const sB = window.VTTScene && window.VTTScene.boot;
      const cB = window.VTTCombat && window.VTTCombat.boot;
      const aB = window.VTTActors && window.VTTActors.boot;
      const pA = window.VTTScene && window.VTTScene.pingAt;
      if (sB) window.VTTScene.boot = function () { bootSpies.scene += 1; bootSpies.sceneArgs.push(arguments[0]); return sB.apply(this, arguments); };
      if (cB) window.VTTCombat.boot = function () { bootSpies.combat += 1; return cB.apply(this, arguments); };
      if (aB) window.VTTActors.boot = function () { bootSpies.actors += 1; return aB.apply(this, arguments); };
      if (pA) window.VTTScene.pingAt = function () { bootSpies.pingAt += 1; return pA.apply(this, arguments); };
    }
  }
  return { dom, window, document: window.document, threw, calls, bootSpies };
}

// ── The id manifest, computed here from the four harness files (not hard-coded),
// so the assertion tracks the sources: union − DEAD + SHELL. ─────────────────
function idsIn(file) {
  const html = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /id="([^"]*)"/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
const DEAD = ['campaignId', 'loadCampaign', 'campaign-id'];
const SHELL = [
  'topBar', 'barBack', 'campName', 'sceneName', 'btnScenes', 'connState', 'sidebarToggle',
  'stripZone', 'btnEncounter', 'encounterPop',
  'sideBar', 'sideTabs', 'tabChat', 'tabChars', 'tabLibrary', 'panelChat', 'panelChars', 'panelLibrary',
  'railZone', 'railToken', 'railPing', 'railFog', 'railAlign', 'railScenes', 'railConsole', 'tokenPop',
  'sheetDialog', 'itemDialog', 'scenesDialog', 'alignDialog', 'drawer', 'gameGate',
];

(async () => {
  // ── 1. Manifest: union − DEAD + SHELL, each id exactly once, DEAD absent ────
  {
    const union = Array.from(new Set([].concat(
      idsIn('public/scene.html'), idsIn('public/combat.html'),
      idsIn('public/actors.html'), idsIn('public/align.html'),
    )));
    t('harness id union is 146', union.length === 146, 'got ' + union.length);

    const expected = new Set(union.filter((id) => DEAD.indexOf(id) === -1));
    SHELL.forEach((id) => expected.add(id));

    const gameHtml = fs.readFileSync('public/game.html', 'utf8');
    const gameIds = idsIn('public/game.html');
    const counts = {};
    gameIds.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });

    // Every DEAD id is absent.
    DEAD.forEach((id) => t('DEAD id absent from game.html: ' + id, !(id in counts), 'count ' + counts[id]));

    // Every expected manifest id is present exactly once.
    let missing = 0; let dup = 0;
    expected.forEach((id) => {
      if (!(id in counts)) { missing += 1; if (missing <= 5) console.log('    missing id: ' + id); }
      else if (counts[id] !== 1) { dup += 1; if (dup <= 5) console.log('    duplicated id: ' + id + ' x' + counts[id]); }
    });
    t('every manifest id present in game.html', missing === 0, missing + ' missing');
    t('no manifest id duplicated in game.html', dup === 0, dup + ' duplicated');

    // The shared ids collapse to exactly one occurrence.
    ['out', 'log', 'clearLog', 'whoami', 'campaignInfo', 'sceneSel'].forEach((id) => {
      t('shared id appears exactly once: ' + id, counts[id] === 1, 'count ' + counts[id]);
    });

    // Every SHELL id is present.
    SHELL.forEach((id) => t('SHELL id present: ' + id, counts[id] === 1, 'count ' + counts[id]));
    void gameHtml;
  }

  // ── 2. GM construction: no throw, is-gm, gate hidden, bar names ─────────────
  let gm;
  {
    gm = bootPage({ isGm: true, activeSceneId: 'S1' });
    await wait(120);
    t('GM: page evaluates without throwing', gm.threw.length === 0, gm.threw.join(' | '));
    t('GM: body.is-gm is set', gm.document.body.classList.contains('is-gm'));
    t('GM: gate is not shown', !gm.document.getElementById('gameGate').classList.contains('show'));
    t('GM: campName populated', gm.document.getElementById('campName').textContent === 'Test Table');
    t('GM: whoami populated', /selene/.test(gm.document.getElementById('whoami').textContent));

    // Boot order: scene boots before combat, both exactly once at load.
    t('GM: scene.boot called once at boot', gm.bootSpies.scene === 1, 'scene=' + gm.bootSpies.scene);
    t('GM: combat.boot called once at boot', gm.bootSpies.combat === 1, 'combat=' + gm.bootSpies.combat);
    t('GM: scene.boot got the campaign id', gm.bootSpies.sceneArgs[0] === CAMPAIGN_ID, String(gm.bootSpies.sceneArgs[0]));

    // Actors DEFERRED: no VTTActors.boot until Characters/Library opens.
    t('GM: actors.boot NOT called at boot (deferred)', gm.bootSpies.actors === 0, 'actors=' + gm.bootSpies.actors);

    // First Characters open → exactly one actors boot.
    gm.document.getElementById('tabChars').dispatchEvent(new gm.window.MouseEvent('click', { bubbles: true }));
    await wait(60);
    t('GM: actors.boot called once after first Characters open', gm.bootSpies.actors === 1, 'actors=' + gm.bootSpies.actors);

    // Library open → still one (latched).
    gm.document.getElementById('tabLibrary').dispatchEvent(new gm.window.MouseEvent('click', { bubbles: true }));
    await wait(40);
    t('GM: actors.boot not called again on Library open (latched)', gm.bootSpies.actors === 1, 'actors=' + gm.bootSpies.actors);
  }

  // ── 3. GM rail: all items present; ping arms/fires/disarms ─────────────────
  {
    const d = gm.document; const w = gm.window;
    ['railToken', 'railPing', 'railFog', 'railAlign', 'railScenes', 'railConsole'].forEach((id) => {
      t('GM: rail item present: ' + id, !!d.getElementById(id));
    });

    // Ping arms on click, sets aria-pressed.
    d.getElementById('railPing').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    t('GM: railPing arms (VTTGame.isPingArmed)', w.VTTGame.isPingArmed() === true);
    t('GM: railPing aria-pressed true when armed', d.getElementById('railPing').getAttribute('aria-pressed') === 'true');

    // A primary canvas pointerdown calls VTTScene.pingAt and disarms.
    const before = gm.bootSpies.pingAt;
    d.getElementById('stage-wrap').dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    t('GM: canvas pointerdown while armed calls VTTScene.pingAt', gm.bootSpies.pingAt === before + 1, 'pingAt=' + gm.bootSpies.pingAt);
    t('GM: ping disarms after the shot', w.VTTGame.isPingArmed() === false);
    t('GM: railPing aria-pressed false after firing', d.getElementById('railPing').getAttribute('aria-pressed') === 'false');

    // Esc disarms an armed ping (no dialog/popover above it).
    w.VTTGame.setPing(true);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    t('GM: Esc disarms an armed ping', w.VTTGame.isPingArmed() === false);
  }

  // ── 4. Rail popovers + Escape ordering ─────────────────────────────────────
  {
    const d = gm.document; const w = gm.window;
    // Token popover opens on rail click, closes on a second click.
    const tokBtn = d.getElementById('railToken'); const tokPop = d.getElementById('tokenPop');
    tokBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    t('GM: tokenPop shown after railToken click', !tokPop.hasAttribute('hidden'));
    t('GM: railToken aria-expanded true when open', tokBtn.getAttribute('aria-expanded') === 'true');
    // Esc closes the popover when nothing above it.
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    t('GM: Esc closes the rail popover', tokPop.hasAttribute('hidden'));
    t('GM: railToken aria-expanded false after Esc', tokBtn.getAttribute('aria-expanded') === 'false');
  }

  // ── 5. Dialogs open via recorded showModal + focus return to invoker ────────
  {
    const d = gm.document; const w = gm.window;
    const before = w.__showModalCalls;
    const invoker = d.getElementById('railScenes');
    invoker.focus();
    w.VTTGame.openScenes();
    await wait(20);
    t('GM: opening Scenes calls showModal (native dialog)', w.__showModalCalls === before + 1, 'calls=' + w.__showModalCalls);
    t('GM: scenesDialog is open', d.getElementById('scenesDialog').open === true);
    // Close it and confirm focus returns to the invoker.
    w.VTTCommon.closeDialog(d.getElementById('scenesDialog'));
    t('GM: closing Scenes returns focus to the rail invoker', d.activeElement === invoker);

    // Esc clears selection only when nothing above it: with a dialog open, the
    // shell must NOT consume Esc for the canvas (the dialog owns its own Esc).
    // We assert the shell leaves an armed ping intact while a dialog is open.
    w.VTTGame.openScenes();
    await wait(10);
    w.VTTGame.setPing(true);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    t('GM: with a dialog open, Esc does not disarm ping (dialog owns Esc)', w.VTTGame.isPingArmed() === true);
    w.VTTGame.setPing(false);
    w.VTTCommon.closeDialog(d.getElementById('scenesDialog'));
  }

  // ── 6. Sidebar collapse toggles aria-expanded ──────────────────────────────
  {
    const d = gm.document; const w = gm.window;
    const btn = d.getElementById('sidebarToggle');
    const startExpanded = btn.getAttribute('aria-expanded');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    t('GM: sidebar toggle flips aria-expanded', btn.getAttribute('aria-expanded') !== startExpanded);
    t('GM: body gets sidebar-collapsed class', d.body.classList.contains('sidebar-collapsed'));
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    t('GM: sidebar toggle restores aria-expanded', btn.getAttribute('aria-expanded') === startExpanded);
  }

  // ── 7. Tablist keyboard model (roving tabindex, arrows, Home/End) ──────────
  {
    const d = gm.document; const w = gm.window;
    const tabs = Array.prototype.slice.call(d.querySelectorAll('#sideTabs [role="tab"]'));
    t('sideTabs has three tabs', tabs.length === 3, 'got ' + tabs.length);
    // Select the first tab, then ArrowRight should move selection to the second.
    tabs[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    t('first tab selected has tabindex 0', tabs[0].getAttribute('tabindex') === '0');
    t('unselected tab has tabindex -1', tabs[1].getAttribute('tabindex') === '-1');
    tabs[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    t('ArrowRight moves selection to the next tab', tabs[1].getAttribute('aria-selected') === 'true');
    tabs[1].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    t('Home selects the first tab', tabs[0].getAttribute('aria-selected') === 'true');
    tabs[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    t('End selects the last tab', tabs[2].getAttribute('aria-selected') === 'true');
  }

  // ── 8. Connection state: disconnect → banner; reconnect → refetch ──────────
  {
    const d = gm.document; const w = gm.window;
    const sockets = w.__sockets;
    t('an observer socket was created by the shell', sockets.length >= 1);
    const sock = sockets[sockets.length - 1];   // game.js opens io() last
    // First connect: banner blank, no catch-up.
    sock._fire('connect');
    await wait(10);
    t('first connect leaves connState blank', d.getElementById('connState').textContent === '');
    // Disconnect → "Reconnecting…".
    sock._fire('disconnect', 'transport close');
    await wait(10);
    t('disconnect shows Reconnecting…', /Reconnecting/i.test(d.getElementById('connState').textContent));
    // Reconnect after a drop → re-invoke scene + combat boot (refetch the board).
    const s0 = gm.bootSpies.scene; const c0 = gm.bootSpies.combat;
    sock._fire('connect');
    await wait(60);
    t('reconnect re-invokes scene.boot (refetch)', gm.bootSpies.scene === s0 + 1, 'scene=' + gm.bootSpies.scene);
    t('reconnect re-invokes combat.boot (refetch)', gm.bootSpies.combat === c0 + 1, 'combat=' + gm.bootSpies.combat);
  }

  // ── 9. Player construction: no throw, no is-gm, rail restricted ────────────
  {
    const pl = bootPage({ isGm: false, activeSceneId: 'S1' });
    await wait(120);
    t('PLAYER: page evaluates without throwing', pl.threw.length === 0, pl.threw.join(' | '));
    t('PLAYER: body.is-gm NOT set', !pl.document.body.classList.contains('is-gm'));

    // Player sees exactly the two-icon rail; GM-only rail items are hidden via
    // CSS (.gm-only { display:none } until body.is-gm). Assert the class is
    // present on the restricted ones and #tokenPop exists.
    ['railFog', 'railAlign', 'railScenes', 'railConsole'].forEach((id) => {
      const el = pl.document.getElementById(id);
      t('PLAYER: ' + id + ' carries gm-only', !!el && el.classList.contains('gm-only'));
    });
    t('PLAYER: railToken present (not gm-only)', (function () { const e = pl.document.getElementById('railToken'); return e && !e.classList.contains('gm-only'); })());
    t('PLAYER: railPing present (not gm-only)', (function () { const e = pl.document.getElementById('railPing'); return e && !e.classList.contains('gm-only'); })());
    t('PLAYER: #tokenPop present', !!pl.document.getElementById('tokenPop'));
    t('PLAYER: drawer carries gm-only and is hidden', (function () { const e = pl.document.getElementById('drawer'); return e && e.classList.contains('gm-only') && e.hasAttribute('hidden'); })());

    // Deferred actors holds for the player too.
    t('PLAYER: actors.boot NOT called at boot', pl.bootSpies.actors === 0, 'actors=' + pl.bootSpies.actors);
    pl.document.getElementById('tabChars').dispatchEvent(new pl.window.MouseEvent('click', { bubbles: true }));
    await wait(60);
    t('PLAYER: actors.boot called once after Characters open', pl.bootSpies.actors === 1, 'actors=' + pl.bootSpies.actors);
  }

  // ── 10. The gate: 403/404 shows the gate screen and does not boot the table ─
  {
    const dom = makeDom();
    const { window } = dom;
    // Campaign fetch → 403 (closed) / 404 (not a member).
    window.fetch = async (path) => {
      const reply = (status, data) => ({ status, json: async () => data });
      if (/\/api\/auth\/me$/.test(path)) return reply(200, { user: USER });
      if (/\/api\/campaigns\/[^/]+$/.test(path)) return reply(404, { error: 'not found' });
      return reply(200, {});
    };
    installFakeIo(window);
    const threw = [];
    let sceneBoots = 0;
    for (const s of SCRIPTS) {
      try { window.eval(fs.readFileSync('public/js/' + s, 'utf8')); }
      catch (e) { threw.push(s + ': ' + e.message); }
      if (s === 'align.js' && window.VTTScene && window.VTTScene.boot) {
        const sB = window.VTTScene.boot; window.VTTScene.boot = function () { sceneBoots += 1; return sB.apply(this, arguments); };
      }
    }
    await wait(80);
    t('GATE: 404 shows the gate screen', window.document.getElementById('gameGate').classList.contains('show'));
    t('GATE: the table is not booted on 404', sceneBoots === 0, 'scene=' + sceneBoots);
    t('GATE: page still evaluates without throwing', threw.length === 0, threw.join(' | '));
  }

  // ── 11. Source probes (CSP + seams) ────────────────────────────────────────
  {
    const gameJsRaw = fs.readFileSync('public/js/game.js', 'utf8');
    const gameHtml = fs.readFileSync('public/game.html', 'utf8');

    // Strip comments before probing: the file's constraint header documents the
    // very APIs it forbids ("No innerHTML / insertAdjacentHTML / document.write"),
    // so a bare-word match would flag the documentation, not a real call.
    const gameJs = gameJsRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep the char before //, avoids eating '://' in urls)

    t('game.js contains no innerHTML', !/\.innerHTML/.test(gameJs));
    t('game.js contains no insertAdjacentHTML', !/insertAdjacentHTML/.test(gameJs));
    t('game.js contains no document.write', !/document\.write/.test(gameJs));

    // No inline <script> body and no on*= handlers in game.html.
    t('game.html has no inline <script> body', !/<script>[\s\S]*?<\/script>/.test(gameHtml.replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, '')));
    t('game.html has no on*= inline handlers', !/\son[a-z]+\s*=/.test(gameHtml.replace(/[a-z-]+="[^"]*"/g, (m) => (/^on[a-z]/.test(m) ? m : '')) ) || !/\son(click|load|error|change|input|submit|keydown|keyup|mouse[a-z]+)=/.test(gameHtml));
    t('game.html has no javascript: urls', !/javascript:/.test(gameHtml));

    // Every <script> tag carries a src (no inline scripts at all).
    const scriptTags = gameHtml.match(/<script\b[^>]*>/g) || [];
    t('every game.html <script> has a src', scriptTags.every((tg) => /\bsrc=/.test(tg)), scriptTags.filter((tg) => !/\bsrc=/.test(tg)).join(' '));

    // The four boot seams exist and export a boot; scene also exports pingAt.
    const sceneJs = fs.readFileSync('public/js/scene.js', 'utf8');
    const combatJs = fs.readFileSync('public/js/combat.js', 'utf8');
    const actorsJs = fs.readFileSync('public/js/actors.js', 'utf8');
    const alignJs = fs.readFileSync('public/js/align.js', 'utf8');
    t('scene.js exports window.VTTScene = { boot, pingAt }', /window\.VTTScene\s*=\s*\{[^}]*boot[^}]*pingAt|window\.VTTScene\s*=\s*\{[^}]*pingAt[^}]*boot/.test(sceneJs));
    t('combat.js exports window.VTTCombat = { boot }', /window\.VTTCombat\s*=\s*\{[^}]*boot/.test(combatJs));
    t('actors.js exports window.VTTActors = { boot }', /window\.VTTActors\s*=\s*\{[^}]*boot/.test(actorsJs));
    t('align.js exports window.VTTAlign = { boot }', /window\.VTTAlign\s*=\s*\{[^}]*boot/.test(alignJs));

    // The harness input wiring is guarded (an existence check around the
    // campaignId/campaign-id binding) in each seamed file.
    t('scene.js guards its campaign-id input wiring', /getElementById\('campaign-id'\)[\s\S]{0,80}if\s*\(|const\s+_cidInput\s*=\s*document\.getElementById\('campaign-id'\)/.test(sceneJs));
    t('combat.js guards its campaignId wiring', /const\s+_lc\s*=\s*document\.getElementById\('loadCampaign'\);\s*if\s*\(_lc\)/.test(combatJs) || /if\s*\(\s*document\.getElementById\('campaignId'\)/.test(combatJs));
    t('actors.js guards its campaignId wiring', /const\s+_lc\s*=\s*document\.getElementById\('loadCampaign'\);\s*if\s*\(_lc\)/.test(actorsJs) || /_hasInput/.test(actorsJs));
    t('align.js guards its own pickers (dies on the game page)', /_ownInput\s*=\s*document\.getElementById\('campaignId'\);\s*if\s*\(_ownInput\)/.test(alignJs));

    // The boot bodies were parameterised (no unconditional input read remains in
    // the loader path on the game page).
    t('scene.js boot(id) exists', /function boot\(id\)\s*\{[\s\S]{0,80}campaignId\s*=\s*id/.test(sceneJs));
    t('combat.js boot(campaignId) exists', /function boot\(campaignId\)\s*\{\s*return loadCampaign\(campaignId\)/.test(combatJs));
    t('actors.js boot(campaignId) exists', /function boot\(campaignId\)\s*\{\s*return loadCampaign\(campaignId\)/.test(actorsJs));
    t('align.js boot(campaignId, scene) exists', /function boot\(campaignId,\s*scene\)/.test(alignJs));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('SUITE CRASHED:', e && e.stack || e);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
