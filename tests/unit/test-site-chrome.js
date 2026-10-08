const { rootPath } = require('../helpers/paths');
const { formFieldProblems } = require('../helpers/formfields');
// Site chrome (Fix 7). jsdom only, no server, no database:
//   node tests/unit/test-site-chrome.js
//
// 1. The privacy page header: the landing's theme toggle, and account buttons
//    that follow the session (signed out: Sign up + Log in; signed in:
//    Dashboard), driven by the REAL privacy.html + theme.js + common.js + privacy.js.
// 2. The landing's deep links /#signup and /#login open the matching form for a
//    signed-out visitor only (REAL index.html + landing.js).
// 3. The account dialog's bin uses the app's standard delete-button style.
// 4. The header light-up rule: present, both states (hover + focus-visible),
//    tokens only, the focus ring untouched, and every top-right control on the
//    four pages is one the rule selects.
// 5. The theme toggle has no colour transition (the Safari fix).
// 6. Follow-ups: one toggle icon on all four pages, the privacy page's theme
//    crossfade, and the wordmark light-up on every linked wordmark.

const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(rootPath(p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function stubMatchMedia(window) {
  window.matchMedia = (q) => ({
    matches: /reduce|hover: none/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.requestAnimationFrame = (cb) => window.setTimeout(cb, 0);
}

// /api/auth/me answers: 'out' (401), 'in' (200 with a user), 'error' (rejects).
function stubFetch(window, me) {
  const calls = [];
  window.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET' });
    if (me === 'error') throw new TypeError('network');
    if (/\/api\/auth\/me$/.test(path) && me === 'in') {
      return { status: 200, json: async () => ({ user: { id: 'u1', username: 'Aerin' } }) };
    }
    return { status: 401, json: async () => ({}) };
  };
  return calls;
}

async function loadPrivacy(me) {
  const dom = new JSDOM(read('client/privacy.html'), { runScripts: 'outside-only', url: 'http://localhost:3000/privacy.html' });
  const { window } = dom;
  stubMatchMedia(window);
  const calls = stubFetch(window, me);
  window.eval(read('client/js/shared/theme.js'));
  window.eval(read('client/js/shared/common.js'));
  window.eval(read('client/js/pages/privacy.js'));
  // jsdom fires DOMContentLoaded itself after parsing, as a browser does for a
  // deferred script; dispatching it here as well would run init() twice.
  await wait(30);
  return { window, document: window.document, calls };
}

async function loadLanding(url, me) {
  const dom = new JSDOM(read('client/index.html'), { runScripts: 'outside-only', url });
  const { window } = dom;
  stubMatchMedia(window);
  const dlg = window.document.getElementById('authCard');
  window.__showModalCalls = 0;
  dlg.showModal = function () { window.__showModalCalls += 1; this.open = true; };
  dlg.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  stubFetch(window, me);
  window.eval(read('client/js/shared/theme.js'));
  window.eval(read('client/js/shared/common.js'));
  window.eval(read('client/js/pages/landing.js'));
  // jsdom fires DOMContentLoaded itself after parsing, as a browser does for a
  // deferred script; dispatching it here as well would run init() twice.
  await wait(30);
  return { window, document: window.document };
}

const visible = (el) => !!el && !el.hasAttribute('hidden');

(async () => {
  // ── 1. Privacy header ──────────────────────────────────────────────────────
  const pvSrc = read('client/privacy.html');
  const pvJs = read('client/js/pages/privacy.js');
  const landingHtml = read('client/index.html');

  {
    const { window, document, calls } = await loadPrivacy('out');
    const $ = (id) => document.getElementById(id);
    const actions = document.querySelector('header.site-header > .header-actions');
    t('privacy: the header has a .header-actions group (as the landing)', !!actions);
    t('privacy: the toggle, Sign up, Log in and Dashboard sit in that group, in the landing\'s order',
      actions && ['themeToggle', 'headerSignup', 'headerLogin', 'headerDash'].every((id, i) => actions.children[i] && actions.children[i].id === id));
    t('privacy: the session is checked with GET /api/auth/me (as the landing)',
      calls.some((c) => c.path === '/api/auth/me' && c.method === 'GET'));
    t('privacy signed out: Sign up and Log in are shown', visible($('headerSignup')) && visible($('headerLogin')));
    t('privacy signed out: Dashboard is hidden', !visible($('headerDash')));
    t('privacy: Sign up opens the landing\'s sign-up form (/#signup)', $('headerSignup').getAttribute('href') === '/#signup' && $('headerSignup').textContent.trim() === 'Sign up');
    t('privacy: Log in opens the landing\'s log-in form (/#login)', $('headerLogin').getAttribute('href') === '/#login' && $('headerLogin').textContent.trim() === 'Log in');
    t('privacy: the account controls use the landing\'s button classes (btn secondary)',
      ['headerSignup', 'headerLogin', 'headerDash'].every((id) => $(id).classList.contains('btn') && $(id).classList.contains('secondary')));

    // Same toggle markup as the landing: element, classes, aria-label, glyph.
    const ld = new JSDOM(landingHtml).window.document;
    const a = ld.getElementById('themeToggle'); const b = $('themeToggle');
    t('privacy: the theme toggle has the landing\'s markup (button, classes, label, icon)',
      b && b.tagName === a.tagName && b.className === a.className && b.getAttribute('type') === 'button'
      && b.querySelector('svg').outerHTML.replace(/\s+/g, ' ') === a.querySelector('svg').outerHTML.replace(/\s+/g, ' '));
    // Same behaviour: VTTCommon.initTheme flips data-theme, stores it, relabels.
    const before = document.documentElement.getAttribute('data-theme');
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const after = document.documentElement.getAttribute('data-theme');
    t('privacy: pressing the toggle switches the theme and stores it',
      before && after && before !== after && window.localStorage.getItem('vtt.theme') === after, `${before} -> ${after}`);
    t('privacy: the toggle\'s label states the next action',
      b.getAttribute('aria-label') === (after === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'));
    const ff = formFieldProblems(document);
    t('privacy: form-field rules hold (ids, accessible names, labels)', ff.length === 0, ff.join(' | '));
  }
  {
    const { document } = await loadPrivacy('in');
    const $ = (id) => document.getElementById(id);
    t('privacy signed in: Dashboard is shown and goes to the dashboard (same label as the landing)',
      visible($('headerDash')) && $('headerDash').getAttribute('href') === '/dashboard.html' && $('headerDash').textContent.trim() === 'Dashboard'
      && new JSDOM(landingHtml).window.document.getElementById('headerDash').textContent.trim() === 'Dashboard');
    t('privacy signed in: Sign up and Log in are hidden', !visible($('headerSignup')) && !visible($('headerLogin')));
  }
  {
    const { document } = await loadPrivacy('error');
    const $ = (id) => document.getElementById(id);
    t('privacy: a failed session check shows the signed-out buttons',
      visible($('headerSignup')) && visible($('headerLogin')) && !visible($('headerDash')));
  }
  {
    // With no script at all, the page still offers working links (signed-out
    // markup is the default, as on the landing).
    const d = new JSDOM(pvSrc).window.document;
    t('privacy: the markup defaults to the signed-out buttons (Dashboard hidden)',
      !d.getElementById('headerSignup').hasAttribute('hidden') && !d.getElementById('headerLogin').hasAttribute('hidden')
      && d.getElementById('headerDash').hasAttribute('hidden'));
    const scripts = [...d.querySelectorAll('script')];
    t('privacy: every script is an external file (CSP: no inline script)', scripts.length > 0 && scripts.every((s) => s.getAttribute('src') && !s.textContent.trim()));
    t('privacy: the page loads theme.js, common.js and privacy.js',
      ['/js/shared/theme.js', '/js/shared/common.js', '/js/pages/privacy.js'].every((src) => scripts.some((s) => s.getAttribute('src') === src)));
    t('privacy: no on<event>= attribute', !/\son[a-z]+=/.test(pvSrc));
    t('privacy.js: no innerHTML / insertAdjacentHTML / document.write', !/innerHTML|insertAdjacentHTML|document\.write/.test(stripComments(pvJs)));
    t('privacy.js stays small (under 60 lines)', pvJs.split('\n').length < 60, `${pvJs.split('\n').length} lines`);
    const pvCss = read('client/css/privacy.css');
    t('privacy.css: [hidden] beats .btn display', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(pvCss));
    t('privacy.css: the landing\'s .btn.secondary recipe (rule-gold border, accent text)',
      /\.btn\.secondary\s*\{[^}]*border-color:\s*var\(--rule\)[^}]*color:\s*var\(--accent\)/.test(pvCss));
  }

  // ── 2. Landing deep links ──────────────────────────────────────────────────
  {
    const { window, document } = await loadLanding('http://localhost:3000/#signup', 'out');
    t('deep link /#signup (signed out): the auth card opens', window.__showModalCalls === 1, `calls=${window.__showModalCalls}`);
    t('deep link /#signup: on the sign-up form',
      visible(document.getElementById('formSignup')) && !visible(document.getElementById('formLogin'))
      && document.getElementById('authCard').getAttribute('aria-labelledby') === 'suHeading');
    t('deep link /#signup: the fragment is removed from the address bar', window.location.hash === '' && window.location.pathname === '/');
  }
  {
    const { window, document } = await loadLanding('http://localhost:3000/#login', 'out');
    t('deep link /#login (signed out): the card opens on the log-in form',
      window.__showModalCalls === 1 && visible(document.getElementById('formLogin')) && !visible(document.getElementById('formSignup'))
      && document.getElementById('authCard').getAttribute('aria-labelledby') === 'liHeading');
    t('deep link /#login: the fragment is removed', window.location.hash === '');
  }
  {
    const { window, document } = await loadLanding('http://localhost:3000/#login', 'in');
    t('deep link /#login while signed in: no form opens, the Continue button shows',
      window.__showModalCalls === 0 && visible(document.getElementById('ctaContinue')));
  }
  {
    const { window } = await loadLanding('http://localhost:3000/#about', 'out');
    t('other fragments (#about, the skip link) open nothing and are kept',
      window.__showModalCalls === 0 && window.location.hash === '#about');
  }
  {
    const { window } = await loadLanding('http://localhost:3000/', 'out');
    t('no fragment: the card stays closed', window.__showModalCalls === 0);
  }
  {
    const { window, document } = await loadLanding('http://localhost:3000/?reset=tok#login', 'out');
    t('an e-mail link (?reset=) wins over a deep link: reset face, opened once',
      window.__showModalCalls === 1 && visible(document.getElementById('formReset')) && !visible(document.getElementById('formLogin')));
  }

  // ── 3. The account dialog's bin ────────────────────────────────────────────
  {
    const dashHtml = read('client/dashboard.html');
    const d = new JSDOM(dashHtml).window.document;
    const bin = d.getElementById('pfDeleteBtn');
    const actorsSrc = read('client/js/game/actors.js');
    const gameTrash = (actorsSrc.match(/className = '(btn small danger) (?:char|image|inv)-trash'/) || [])[1];
    t('bin: the game page\'s direct-trash buttons are "btn small danger"', gameTrash === 'btn small danger');
    t('bin: the account dialog\'s bin uses the same classes', bin && gameTrash && gameTrash.split(' ').every((c) => bin.classList.contains(c)),
      bin && bin.className);
    t('bin: keeps its accessible name, tooltip and dialog popup',
      bin.getAttribute('aria-label') === 'Delete account' && bin.getAttribute('title') === 'Delete account' && bin.getAttribute('aria-haspopup') === 'dialog');
    t('bin: keeps the trash glyph, hidden from assistive tech', !!bin.querySelector('svg[aria-hidden="true"]') && bin.textContent.trim() === '');
    const dashCss = read('client/css/dashboard.css');
    t('bin: the dashboard\'s .btn.danger has the danger border', /\.btn\.danger\s*\{[^}]*border-color:\s*var\(--danger\)/.test(dashCss));
    t('bin: ...and a danger fill on hover', /\.btn\.danger:hover\s*\{[^}]*background:\s*var\(--danger\)/.test(dashCss));
    const binRules = stripComments(dashCss).match(/[^}]*idcard-bin[^{]*\{[^}]*\}/g) || [];
    t('bin: its own rules set only size (no colour override of the danger style)',
      binRules.length > 0 && binRules.every((r) => !/(^|[\s;{])(color|background|border-color)\s*:/.test(r.split('{')[1])), binRules.join(' '));
    t('bin: still 36 px square (keeps its place on the row)', /\.btn\.idcard-bin\s*\{[^}]*min-height:\s*36px;\s*min-width:\s*36px/.test(dashCss));
  }

  // ── 4. Header light-up ─────────────────────────────────────────────────────
  const tokens = read('client/css/tokens.css');
  const tk = stripComments(tokens);
  const SCOPE = ':is(.site-header .header-actions, #topBar .bar-right) > .btn';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  {
    const rest = tk.match(new RegExp(esc(SCOPE) + '\\s*\\{([^}]*)\\}'));
    const lit = tk.match(new RegExp(esc(SCOPE) + ':is\\(:hover, :focus-visible\\)\\s*\\{([^}]*)\\}'));
    t('light-up: the rule exists in tokens.css (shared by all four pages)', !!rest && !!lit);
    t('light-up: at rest the controls are --accent (the wordmark\'s rest colour)', rest && /color:\s*var\(--accent\)/.test(rest[1]));
    t('light-up: hover AND keyboard focus show --text (the wordmark\'s hover colour)', lit && /-webkit-text-fill-color:\s*var\(--text\)/.test(lit[1]));
    t('light-up: no gold fill or glow on hover (they would put --text on gold)',
      lit && /background-color:\s*transparent/.test(lit[1]) && /box-shadow:\s*none/.test(lit[1]));
    t('light-up: no transition is declared for it (instant, like the wordmark)', lit && !/transition/.test(lit[1]));
    t('light-up: the theme toggle lights through color, to --text',
      /:is\(\.site-header, #topBar\) #themeToggle:is\(:hover, :focus-visible\)\s*\{\s*color:\s*var\(--text\);\s*\}/.test(tk));
    t('light-up: the sidebar toggle\'s bars light to --text',
      /#sidebarToggle:is\(:hover, :focus-visible\) \.bars,[\s\S]*?\{\s*background-color:\s*var\(--text\);\s*\}/.test(tk));
    const block = tokens.slice(tokens.indexOf('Header navigation light-up'), tokens.indexOf('/* Scrollbars'));
    const blockCode = stripComments('/*' + block);
    t('light-up: tokens only, no raw colour', !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(blockCode), blockCode);
    t('light-up: the focus ring is untouched (no outline in the new rules; global ring still there)',
      !/outline/.test(blockCode) && /:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\);\s*outline-offset:\s*2px;/.test(tk));
    // Privacy's wordmark is the reference: accent at rest, --text on hover.
    const pvCss = stripComments(read('client/css/privacy.css'));
    t('reference: the privacy wordmark is --accent and its link hover is --text',
      /\.wordmark\s*\{[^}]*color:\s*var\(--accent\)/.test(pvCss) && /a:hover\s*\{\s*color:\s*var\(--text\);\s*\}/.test(pvCss));
  }
  {
    // Every top-right navigation control on each page is a direct .btn child of
    // the selected container, so the rule reaches all of them.
    const pages = {
      landing: ['client/index.html', '.site-header .header-actions', ['themeToggle', 'headerSignup', 'headerLogin', 'headerDash']],
      privacy: ['client/privacy.html', '.site-header .header-actions', ['themeToggle', 'headerSignup', 'headerLogin', 'headerDash']],
      dashboard: ['client/dashboard.html', '.site-header .header-actions', ['themeToggle', 'profileBtn']],
      game: ['client/game.html', '#topBar .bar-right', ['themeToggle', 'sidebarToggle']],
    };
    for (const [name, [file, container, ids]] of Object.entries(pages)) {
      const src = read(file);
      const d = new JSDOM(src).window.document;
      const box = d.querySelector(container);
      const controls = box ? [...box.querySelectorAll('button, a')] : [];
      t(`light-up (${name}): the page links tokens.css`, /<link[^>]+href="\/css\/tokens\.css"/.test(src));
      t(`light-up (${name}): its top-right controls are ${ids.join(', ')}`,
        controls.length === ids.length && ids.every((id) => controls.some((c) => c.id === id)), controls.map((c) => c.id).join(','));
      t(`light-up (${name}): each is a .btn directly in ${container} (selected by the rule)`,
        controls.every((c) => c.parentElement === box && c.classList.contains('btn')));
    }
  }

  // ── 5. The theme toggle's transition (Safari) ──────────────────────────────
  {
    t('toggle: no transition on the toggle, its svg or the svg\'s shapes',
      /:is\(\.site-header, #topBar\) #themeToggle,\s*:is\(\.site-header, #topBar\) #themeToggle svg,\s*:is\(\.site-header, #topBar\) #themeToggle svg \*\s*\{\s*transition:\s*none;\s*\}/.test(tk));
    // Nothing else loses its crossfade: the global rules are still there.
    for (const f of ['client/css/landing.css', 'client/css/dashboard.css']) {
      const css = read(f);
      t(`toggle: ${f} keeps the .theme-ready * colour crossfade`, /\.theme-ready \*\s*\{\s*transition: background-color 0\.7s ease, color 0\.7s ease, border-color 0\.7s ease;/.test(css));
    }
    t('toggle: game.css keeps the .theme-ready .fx crossfade',
      /\.theme-ready \.fx\s*\{\s*transition: background-color 0\.5s ease, color 0\.5s ease, border-color 0\.5s ease;/.test(read('client/css/game.css')));
  }

  // ── 6. Follow-ups (2026-10-08) ─────────────────────────────────────────────
  {
    // The theme toggle draws the same sun on every page (the landing's): the
    // dashboard and game drew a smaller one (r 4.5, rays 2..22, thinner stroke).
    const svgOf = (file) => {
      const s = new JSDOM(read(file)).window.document.querySelector('#themeToggle svg');
      return s ? s.outerHTML.replace(/>\s+</g, '><').replace(/\s+/g, ' ') : '';
    };
    const ref = svgOf('client/index.html');
    for (const f of ['client/privacy.html', 'client/dashboard.html', 'client/game.html']) {
      t(`toggle icon: ${f} draws the landing's sun`, ref && svgOf(f) === ref, svgOf(f));
    }
    // All four pages size it with the same recipe: 20 px icon, 0.55rem padding,
    // 44 px minimum (measured 44 x 44 in Chromium on all four).
    for (const f of ['client/css/landing.css', 'client/css/privacy.css', 'client/css/dashboard.css']) {
      const css = read(f);
      t(`toggle size: ${f} has .btn.icon 0.55rem padding and a 20 px icon`,
        /\.btn\.icon\s*\{\s*padding:\s*0\.55rem;\s*\}/.test(css) && /\.btn\.icon svg\s*\{\s*width:\s*20px;\s*height:\s*20px;\s*\}/.test(css));
    }
  }
  {
    // The privacy page crossfades the theme like the landing: same rule, and the
    // class is added only after the first paint (two frames in).
    const pvCss = stripComments(read('client/css/privacy.css'));
    t('privacy crossfade: privacy.css has the landing\'s .theme-ready * rule',
      /\.theme-ready \*\s*\{\s*transition: background-color 0\.7s ease, color 0\.7s ease, border-color 0\.7s ease;/.test(pvCss));
    const dom = new JSDOM(read('client/privacy.html'), { runScripts: 'outside-only', url: 'http://localhost:3000/privacy.html' });
    const w = dom.window;
    stubMatchMedia(w);
    const frames = [];
    w.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    stubFetch(w, 'out');
    w.eval(read('client/js/shared/theme.js'));
    w.eval(read('client/js/shared/common.js'));
    w.eval(read('client/js/pages/privacy.js'));
    await wait(30);
    const html = w.document.documentElement;
    t('privacy crossfade: off for the first paint (the stored theme applies at once)', !html.classList.contains('theme-ready'));
    frames.shift()();
    t('privacy crossfade: still off after one frame', !html.classList.contains('theme-ready'));
    frames.shift()();
    t('privacy crossfade: on from the second frame, so a toggle animates', html.classList.contains('theme-ready'));
    t('privacy crossfade: the toggle itself keeps no colour transition (the Safari rule covers .site-header)',
      /:is\(\.site-header, #topBar\) #themeToggle svg \*\s*\{\s*transition:\s*none;/.test(tk));
  }
  {
    // Every wordmark that is a link lights up like the privacy page's: --accent
    // at rest, --text at once on hover and focus, via text-fill (not `color`,
    // which carries the crossfade). The landing's wordmark is not a link.
    const rest = tk.match(/a\.wordmark\s*\{([^}]*)\}/);
    const lit = tk.match(/a\.wordmark:is\(:hover, :focus-visible\)\s*\{([^}]*)\}/);
    t('wordmark: shared rule in tokens.css, --accent at rest', !!rest && /color:\s*var\(--accent\)/.test(rest[1]));
    t('wordmark: hover and keyboard focus show --text through text-fill, with no transition',
      !!lit && /-webkit-text-fill-color:\s*var\(--text\)/.test(lit[1]) && /color:\s*var\(--accent\)/.test(lit[1]) && !/transition/.test(lit[1]));
    const links = {
      'client/privacy.html': ['.site-header > a.wordmark', '/'],
      'client/dashboard.html': ['.site-header > a.wordmark', '/'],
      'client/game.html': ['#topBar a.wordmark#barBack', '/dashboard.html'],
    };
    for (const [f, [sel, href]] of Object.entries(links)) {
      const el = new JSDOM(read(f)).window.document.querySelector(sel);
      t(`wordmark: ${f}'s top-left title is an a.wordmark (selected by the rule)`, !!el && el.getAttribute('href') === href, sel);
    }
    t('wordmark: the landing\'s wordmark is plain text (nothing to hover)',
      new JSDOM(landingHtml).window.document.querySelector('.site-header > .wordmark').tagName === 'SPAN');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nSUITE ERROR:', e);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
