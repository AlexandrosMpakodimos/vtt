const { rootPath } = require('../helpers/paths');
// The early session check on the signed-in pages (client/js/shared/authgate.js).
//
// Found in the production QA pass: a signed-out visitor opening a dashboard or
// game URL saw the empty page layout for a moment before being sent to the
// log-in page. The pages start hidden (html.auth-pending), but their own
// session check waited for DOMContentLoaded, which the deferred scripts and the
// 3D dice module delay, so the 4 s fallback revealed the layout first.
// authgate.js asks for the session from <head>, before any of that.
//
// These probes run the real file against a stubbed fetch, and check that both
// pages load it synchronously from <head>, ahead of every deferred script.
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  PASS  ' + name); } else { fail += 1; console.log('  FAIL  ' + name + '  ' + detail); }
}

const SRC = fs.readFileSync(rootPath('client/js/shared/authgate.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 20));

// Runs authgate.js on a hidden page whose fetch answers with `answer`
// (a status number, 'reject', or 'missing' for a browser without fetch).
async function run(answer) {
  const dom = new JSDOM('<!doctype html><html class="auth-pending"><head></head><body>secret</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:3000/game.html?id=C' });
  const w = dom.window;
  const calls = [];
  if (answer === 'missing') {
    w.fetch = undefined;
  } else {
    w.fetch = (url, opts) => {
      calls.push({ url, opts });
      if (answer === 'reject') return Promise.reject(new Error('offline'));
      return Promise.resolve({ status: answer, ok: answer >= 200 && answer < 300 });
    };
  }
  // jsdom cannot navigate, so the script sees a window whose location records
  // where it would go; fetch and the document are the page's own.
  w.__go = [];
  w.__win = { fetch: w.fetch, location: { replace(u) { w.__go.push(u); } } };
  let threw = null;
  try { w.eval('(function (window) {\n' + SRC + '\n}(window.__win));'); } catch (e) { threw = e; }
  await tick();
  const go = w.__go || [];
  return { calls, go, hidden: w.document.documentElement.classList.contains('auth-pending'), threw };
}

(async () => {
  // --- signed out -------------------------------------------------------------
  let r = await run(401);
  check('it asks for the session once, from /api/auth/me', r.calls.length === 1 && r.calls[0].url === '/api/auth/me', JSON.stringify(r.calls));
  check('...with the session cookie (same-origin credentials)', r.calls[0] && r.calls[0].opts.credentials === 'same-origin');
  check('signed out (401): it goes straight to the log-in page', r.go.length === 1 && r.go[0] === '/', JSON.stringify(r.go));
  check('...and the page is never shown', r.hidden === true);

  // --- signed in --------------------------------------------------------------
  r = await run(200);
  check('signed in (200): the page is shown', r.hidden === false);
  check('...and nothing navigates', r.go.length === 0, JSON.stringify(r.go));

  // --- anything else is left to the page scripts and the fallback --------------
  for (const answer of [500, 503, 'reject', 'missing']) {
    r = await run(answer);
    check(`${answer}: the page stays hidden for the page scripts to decide`, r.hidden === true && r.go.length === 0,
      JSON.stringify({ hidden: r.hidden, go: r.go }));
    check(`${answer}: no exception escapes`, r.threw === null, r.threw && r.threw.message);
  }

  // --- both signed-in pages load it early ---------------------------------------
  for (const page of ['dashboard.html', 'game.html']) {
    const html = fs.readFileSync(rootPath('client/' + page), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    const tag = head.match(/<script[^>]*src="\/js\/shared\/authgate\.js"[^>]*><\/script>/);
    check(`${page}: starts hidden (html.auth-pending)`, /<html[^>]*class="[^"]*auth-pending/.test(html));
    check(`${page}: loads authgate.js from <head>`, !!tag);
    check(`${page}: ...as a plain script (no defer, async or module)`, tag && !/\b(defer|async)\b|type="module"/.test(tag[0]), tag && tag[0]);
    check(`${page}: ...after theme.js, so the theme is set before anything is shown`,
      tag && head.indexOf(tag[0]) > head.indexOf('/js/shared/theme.js'));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
