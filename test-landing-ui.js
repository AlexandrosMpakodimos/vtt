// Landing page UI smoke suite. jsdom only — no server, no database:
//   node test-landing-ui.js
//
// Same scope and reason as test-align-ui.js: public/js/landing.js is a client
// file with no runtime coverage from any server suite, and the class of defect
// that motivates these suites — a function deleted by an edit and still called,
// or a contract quietly broken — is invisible to `node --check` and to every
// functional suite. This one loads the REAL public/index.html + theme.js +
// landing.js and asserts the seam contracts, the element-id manifest, the
// reduced-motion parallax gate, the auth-card open/close + focus return, the
// ?reset= landing flow, the login/403/register messaging, and source-level
// probes that the CSP-critical rules still hold.

const { JSDOM } = require('jsdom');
const fs = require('fs');

// matchMedia is stubbed to report reduced-motion + no-hover, so the parallax
// gates trip and no listener is attached (the assertion below depends on this).
// Constructed before eval so theme.js/landing.js see it at load.
function makeDom(url) {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), {
    runScripts: 'outside-only',
    url: url || 'http://localhost:3000/',
  });
  const { window } = dom;

  window.matchMedia = (q) => ({
    matches: /reduce|hover: none/.test(q),
    media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  window.requestAnimationFrame = (cb) => window.setTimeout(cb, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);

  // jsdom's <dialog> has no showModal/close. Stub them so they RECORD the call
  // (a no-op that records nothing is the setPointerCapture mistake the skill
  // warns about), and reflect the open state the way the real dialog does.
  const dlg = window.document.getElementById('authCard');
  window.__showModalCalls = 0;
  window.__closeCalls = 0;
  if (dlg) {
    dlg.showModal = function () { window.__showModalCalls += 1; this.open = true; };
    dlg.close = function () { window.__closeCalls += 1; this.open = false; this.dispatchEvent(new window.Event('close')); };
  }

  return dom;
}

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Record fetch calls, house-style; default resolve is a signed-out /me.
function stubFetch(window, responder) {
  const calls = [];
  window.fetch = async (path, opts = {}) => {
    const call = { path, method: (opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const r = responder ? responder(call) : null;
    const status = r ? r.status : 401;
    const data = r ? r.data : {};
    return { status, json: async () => data };
  };
  return calls;
}

// Record whether a 'pointermove' listener is ever attached to #heroLayers.
function watchPointerListener(window) {
  const rec = { pointermove: false };
  const proto = window.EventTarget.prototype;
  const orig = proto.addEventListener;
  proto.addEventListener = function (type, ...rest) {
    if (type === 'pointermove') rec.pointermove = true;
    return orig.call(this, type, ...rest);
  };
  return rec;
}

function evalScripts(window) {
  let err = null;
  try {
    window.eval(fs.readFileSync('public/js/theme.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/common.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/landing.js', 'utf8'));
    // jsdom with runScripts:'outside-only' reports readyState 'loading' at eval
    // time, so landing.js registers a DOMContentLoaded listener and waits (in a
    // real browser its `defer` script runs after parse, DOM already ready). Fire
    // the event so init() runs, which is exactly what a deferred script receives.
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  } catch (e) { err = e; }
  return err;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── load ──────────────────────────────────────────────────────────────────
  let dom = makeDom();
  let { window } = dom;
  let { document } = window;
  const listenerRec = watchPointerListener(window);
  stubFetch(window, () => ({ status: 401, data: {} }));   // signed-out
  const loadErr = evalScripts(window);
  t('theme.js + landing.js evaluate without throwing', loadErr === null,
    loadErr && `${loadErr.name}: ${loadErr.message}`);
  if (loadErr) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  // ── element-id manifest ─────────────────────────────────────────────────────
  const MANIFEST = ('themeToggle headerLogin headerDash heroLayers ctaRow ctaSignup '
    + 'ctaLogin ctaContinue ctaLogout authCard authClose formSignup suHeading suEmail '
    + 'suUsername suPassword suStatus suSubmit suResend formLogin liHeading liEmail '
    + 'liPassword liStatus liSubmit liResend liForgot formForgot fpHeading fpEmail '
    + 'fpStatus fpSubmit formReset rpHeading rpPassword rpStatus rpSubmit about thesis license').split(/\s+/);
  for (const id of MANIFEST) t(`#${id} present`, document.getElementById(id) !== null);
  // Redesign added a top-right Sign up button; it opens the signup face.
  t('#headerSignup present', document.getElementById('headerSignup') !== null);

  // structure the parallax + card rely on
  t('#heroLayers is aria-hidden', document.getElementById('heroLayers').getAttribute('aria-hidden') === 'true');
  const layers = document.querySelectorAll('#heroLayers .layer[data-depth]');
  t('exactly three .layer[data-depth] in #heroLayers', layers.length === 3, `got ${layers.length}`);
  t('#authCard is a <dialog>', document.getElementById('authCard').tagName.toLowerCase() === 'dialog');

  // ── seam: resolveTheme ──────────────────────────────────────────────────────
  const V = window.VTTLanding || {};
  t('VTTLanding exposes resolveTheme/clampDepth/navigate',
    typeof V.resolveTheme === 'function' && typeof V.clampDepth === 'function' && typeof V.navigate === 'function');
  t("resolveTheme('dark', false) -> dark",  V.resolveTheme('dark', false) === 'dark');
  t("resolveTheme('light', true) -> light", V.resolveTheme('light', true) === 'light');
  t("resolveTheme(null, true) -> dark",     V.resolveTheme(null, true) === 'dark');
  t("resolveTheme(null, false) -> light",   V.resolveTheme(null, false) === 'light');
  t("resolveTheme('junk', true) -> dark",   V.resolveTheme('junk', true) === 'dark');

  // ── seam: clampDepth (incl. the array-coercion trap) ────────────────────────
  t("clampDepth('0.3') -> 0.3", V.clampDepth('0.3') === 0.3);
  t("clampDepth('2') -> 1",     V.clampDepth('2') === 1);
  t("clampDepth('-1') -> 0",    V.clampDepth('-1') === 0);
  t("clampDepth(undefined) -> 0", V.clampDepth(undefined) === 0);
  t("clampDepth([[2]]) -> 0",   V.clampDepth([[2]]) === 0);

  // ── parallax gate: reduced-motion => no listener, parallaxActive false ──────
  t('parallaxActive === false under reduced motion', V.parallaxActive === false);
  t('no pointermove listener attached under reduced motion', listenerRec.pointermove === false);

  // ── parallax ACTIVE path: when motion is allowed and a hover pointer exists,
  //    the pointermove listener must attach to an element that actually receives
  //    pointer events — NOT #heroLayers, which is pointer-events:none. (The
  //    original bug: listener on the layers meant the parallax never fired.) ────
  {
    const d = new JSDOM(fs.readFileSync('public/index.html', 'utf8'),
      { runScripts: 'outside-only', url: 'http://localhost:3000/' });
    const w = d.window;
    // permissive matchMedia: motion allowed, real hover pointer
    w.matchMedia = (q) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
    w.requestAnimationFrame = (cb) => w.setTimeout(cb, 0);
    // record which element the pointermove listener lands on
    let pmTarget = null;
    const proto = w.EventTarget.prototype;
    const orig = proto.addEventListener;
    proto.addEventListener = function (type, ...rest) {
      if (type === 'pointermove' && !pmTarget) pmTarget = this;
      return orig.call(this, type, ...rest);
    };
    const dlg = w.document.getElementById('authCard');
    if (dlg) { dlg.showModal = function () { this.open = true; }; dlg.close = function () { this.open = false; }; }
    w.fetch = async () => ({ status: 401, json: async () => ({}) });
    w.eval(fs.readFileSync('public/js/theme.js', 'utf8'));
    w.eval(fs.readFileSync('public/js/common.js', 'utf8'));
    w.eval(fs.readFileSync('public/js/landing.js', 'utf8'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
    t('motion allowed -> parallaxActive true', w.VTTLanding.parallaxActive === true);
    t('parallax listener attaches (pointermove seen)', pmTarget !== null);
    t('parallax listener target is NOT the pointer-events:none layers box',
      pmTarget !== w.document.getElementById('heroLayers'),
      pmTarget && pmTarget.id);
    t('parallax listener is global (window) so it tracks the mouse everywhere and never recenters',
      pmTarget === w || pmTarget === w.document || (pmTarget && pmTarget.nodeType === 9),
      pmTarget && (pmTarget.toString ? pmTarget.toString() : typeof pmTarget));
  }

  // ── signed-out default: header shows both auth buttons; the one big CTA is
  //    "Log in", not the old two-button pair (redesign) ────────────────────────
  t('signed-out: headerSignup + headerLogin visible',
    !document.getElementById('headerSignup').hasAttribute('hidden')
    && !document.getElementById('headerLogin').hasAttribute('hidden'));
  t('signed-out: ctaLogin is the visible hero CTA',
    !document.getElementById('ctaLogin').hasAttribute('hidden'));
  t('signed-out: ctaContinue + ctaLogout hidden',
    document.getElementById('ctaContinue').hasAttribute('hidden')
    && document.getElementById('ctaLogout').hasAttribute('hidden'));

  // ── auth card: open via the header Sign up button, correct face, focus, Esc ──
  const signupOpener = document.getElementById('headerSignup');
  signupOpener.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('Sign up -> showModal recorded', window.__showModalCalls === 1, `calls=${window.__showModalCalls}`);
  t('Sign up -> sign-up face visible', !document.getElementById('formSignup').hasAttribute('hidden'));
  t('Sign up -> other faces hidden',
    document.getElementById('formLogin').hasAttribute('hidden')
    && document.getElementById('formForgot').hasAttribute('hidden')
    && document.getElementById('formReset').hasAttribute('hidden'));
  t('Sign up -> focus on first field (suEmail)', document.activeElement === document.getElementById('suEmail'));
  t('aria-labelledby tracks the visible face heading',
    document.getElementById('authCard').getAttribute('aria-labelledby') === 'suHeading');

  // Esc (cancel event) closes and returns focus to the invoker.
  document.getElementById('authCard').dispatchEvent(new window.Event('cancel', { cancelable: true }));
  t('Esc/cancel -> card closed', document.getElementById('authCard').open === false);
  t('Esc/cancel -> focus back on invoker (headerSignup)', document.activeElement === signupOpener);

  // ── login: 200 -> navigate('/dashboard.html') ───────────────────────────────
  {
    const d2 = makeDom(); const w2 = d2.window; const doc2 = w2.document;
    stubFetch(w2, (call) => {
      if (/\/api\/auth\/me$/.test(call.path)) return { status: 401, data: {} };
      if (/\/api\/auth\/login$/.test(call.path)) return { status: 200, data: { user: { id: 'u1', username: 'x' } } };
      return { status: 200, data: {} };
    });
    let navUrl = null;
    evalScripts(w2);
    w2.VTTLanding.navigate = (u) => { navUrl = u; };   // stub the seam
    doc2.getElementById('liEmail').value = 'a@b.com';
    doc2.getElementById('liPassword').value = 'password-123';
    doc2.getElementById('formLogin').dispatchEvent(new w2.Event('submit', { cancelable: true, bubbles: true }));
    await wait(20);
    t("login 200 -> navigate('/dashboard.html')", navUrl === '/dashboard.html', String(navUrl));
  }

  // ── login: 403 email_verified:false -> #liResend revealed ───────────────────
  {
    const d3 = makeDom(); const w3 = d3.window; const doc3 = w3.document;
    stubFetch(w3, (call) => {
      if (/\/api\/auth\/login$/.test(call.path)) return { status: 403, data: { error: 'Please verify your email before logging in', email_verified: false } };
      return { status: 401, data: {} };
    });
    evalScripts(w3);
    doc3.getElementById('liEmail').value = 'a@b.com';
    doc3.getElementById('liPassword').value = 'password-123';
    doc3.getElementById('formLogin').dispatchEvent(new w3.Event('submit', { cancelable: true, bubbles: true }));
    await wait(20);
    t('login 403 unverified -> #liResend visible', !doc3.getElementById('liResend').hasAttribute('hidden'));
    t('login 403 -> server error rendered in #liStatus',
      doc3.getElementById('liStatus').textContent.indexOf('verify your email') !== -1,
      doc3.getElementById('liStatus').textContent);
  }

  // ── register: 201 -> message in #suStatus, #suResend revealed ───────────────
  {
    const d4 = makeDom(); const w4 = d4.window; const doc4 = w4.document;
    stubFetch(w4, (call) => {
      if (/\/api\/auth\/register$/.test(call.path)) return { status: 201, data: { message: 'Account created. Check your email.', user: {} } };
      return { status: 401, data: {} };
    });
    evalScripts(w4);
    doc4.getElementById('suEmail').value = 'a@b.com';
    doc4.getElementById('suUsername').value = 'someone';
    doc4.getElementById('suPassword').value = 'password-123';
    doc4.getElementById('formSignup').dispatchEvent(new w4.Event('submit', { cancelable: true, bubbles: true }));
    await wait(20);
    t('register 201 -> #suStatus shows server message',
      doc4.getElementById('suStatus').textContent.indexOf('Account created') !== -1,
      doc4.getElementById('suStatus').textContent);
    t('register 201 -> #suResend visible', !doc4.getElementById('suResend').hasAttribute('hidden'));
  }

  // ── register: server breach/common rejection is shown as "too weak", not raw ─
  {
    const d4b = makeDom(); const w4b = d4b.window; const doc4b = w4b.document;
    stubFetch(w4b, (call) => {
      if (/\/api\/auth\/register$/.test(call.path)) {
        return { status: 400, data: { error: 'password is too common or has appeared in a data breach' } };
      }
      return { status: 401, data: {} };
    });
    evalScripts(w4b);
    doc4b.getElementById('suEmail').value = 'a@b.com';
    doc4b.getElementById('suUsername').value = 'someone';
    doc4b.getElementById('suPassword').value = 'password';
    doc4b.getElementById('formSignup').dispatchEvent(new w4b.Event('submit', { cancelable: true, bubbles: true }));
    await wait(20);
    const shown = doc4b.getElementById('suStatus').textContent;
    t('breach error -> shown as "too weak"', /too weak/i.test(shown), shown);
    t('breach error -> does NOT expose "breach"/"data breach" to the user',
      !/breach/i.test(shown), shown);
  }

  // ── ?reset= flow: card opens on reset face, replaceState to /, POST carries token
  {
    const d5 = makeDom('http://localhost:3000/?reset=abc123'); const w5 = d5.window; const doc5 = w5.document;
    let replaced = null;
    const origReplace = w5.history.replaceState.bind(w5.history);
    w5.history.replaceState = (s, ti, url) => { replaced = url; return origReplace(s, ti, url); };
    const resetCalls = stubFetch(w5, (call) => {
      if (/\/api\/auth\/reset-password$/.test(call.path)) return { status: 200, data: { message: 'Password reset.' } };
      return { status: 401, data: {} };
    });
    evalScripts(w5);
    await wait(5);
    t('?reset= -> reset face visible', !doc5.getElementById('formReset').hasAttribute('hidden'));
    t('?reset= -> showModal recorded', w5.__showModalCalls >= 1, `calls=${w5.__showModalCalls}`);
    t("?reset= -> replaceState landed on '/'", replaced === '/', String(replaced));
    doc5.getElementById('rpPassword').value = 'brand-new-pass-1';
    doc5.getElementById('formReset').dispatchEvent(new w5.Event('submit', { cancelable: true, bubbles: true }));
    await wait(20);
    const rp = resetCalls.find((c) => /\/api\/auth\/reset-password$/.test(c.path) && c.method === 'POST');
    t('reset submit -> POST /api/auth/reset-password', !!rp);
    t('reset submit -> body carries {token:"abc123", password}',
      rp && rp.body && rp.body.token === 'abc123' && rp.body.password === 'brand-new-pass-1',
      rp && JSON.stringify(rp.body));
  }

  // ── ?verified= flow: verify-email link redirects here -> login face + message ─
  {
    const d6 = makeDom('http://localhost:3000/?verified=1'); const w6 = d6.window; const doc6 = w6.document;
    let replaced6 = null;
    const origR6 = w6.history.replaceState.bind(w6.history);
    w6.history.replaceState = (s, ti, url) => { replaced6 = url; return origR6(s, ti, url); };
    stubFetch(w6, () => ({ status: 401, data: {} }));
    evalScripts(w6);
    await wait(5);
    t('?verified=1 -> login face visible', !doc6.getElementById('formLogin').hasAttribute('hidden'));
    t('?verified=1 -> success message in #liStatus', /verified/i.test(doc6.getElementById('liStatus').textContent));
    t("?verified=1 -> replaceState landed on '/'", replaced6 === '/', String(replaced6));

    const d7 = makeDom('http://localhost:3000/?verified=invalid'); const w7 = d7.window; const doc7 = w7.document;
    stubFetch(w7, () => ({ status: 401, data: {} }));
    evalScripts(w7);
    await wait(5);
    t('?verified=invalid -> login face visible', !doc7.getElementById('formLogin').hasAttribute('hidden'));
    t('?verified=invalid -> invalid/expired message in #liStatus',
      /invalid|expired/i.test(doc7.getElementById('liStatus').textContent));
  }

  // ── source-level probes ─────────────────────────────────────────────────────
  const themeSrc = fs.readFileSync('public/js/theme.js', 'utf8');
  const landingSrc = fs.readFileSync('public/js/landing.js', 'utf8');
  const htmlSrc = fs.readFileSync('public/index.html', 'utf8');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  t('theme.js contains no innerHTML/insertAdjacentHTML/document.write (code)',
    !/innerHTML|insertAdjacentHTML|document\.write/.test(stripComments(themeSrc)));
  t('landing.js contains no innerHTML/insertAdjacentHTML/document.write (code)',
    !/innerHTML|insertAdjacentHTML|document\.write/.test(stripComments(landingSrc)));
  t('index.html has no inline <script> (every <script> has src)',
    !/<script(?![^>]*\ssrc=)[^>]*>/.test(htmlSrc));
  t('index.html has no on<event>= handler attribute', !/\son[a-z]+=/.test(htmlSrc));

  // Theme-aware hero art with crossfade. Two overlays (night on ::before, day on
  // ::after) so transparent mid/front layers don't leak the other theme through
  // clear pixels — but WITHOUT will-change on them (that promotion caused Chrome's
  // compositor to desync tiles during rapid toggles, the rectangular-band glitch).
  t('night art is on the ::before overlay (dark default)',
    /\.layer\.back::before\s*\{[^}]*layer-back-night\.jpg/.test(htmlSrc));
  t('day art is on the ::after overlay, shown in light theme',
    /\.layer\.back::after\s*\{[^}]*layer-back\.jpg/.test(htmlSrc)
    && /html\[data-theme="light"\][^{]*\.layer::after\s*\{[^}]*opacity:\s*1/.test(htmlSrc));
  t('crossfade overlays are NOT GPU-promoted (no will-change/backface)',
    !/\.layer::before,\s*\.layer::after\s*\{[^}]*will-change/.test(htmlSrc));
  t('hero art crossfades on theme change (opacity transition on the overlays)',
    /\.theme-ready\s+\.layer::before,\s*\.theme-ready\s+\.layer::after\s*\{[^}]*transition:\s*opacity/.test(htmlSrc));
  t('UI colours also transition on theme change (global .theme-ready rule)',
    /\.theme-ready\s+\*\s*\{[^}]*transition:[^}]*color/.test(htmlSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nSUITE ERROR:', e);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
