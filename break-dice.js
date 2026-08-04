// Adversarial audit of the dice/chat surface as it stands after the M6 work.
//   Usage: SKIP_HIBP=1 node break-dice.js   (server on npm run dev:test)
//
// break-combat.js audited combat and chat as M5 shipped them. This suite exists
// because TWO things changed underneath it afterwards, and neither was covered:
//
//   1. The dice grammar gained multiple groups (the 2026-08-03 amendment). The
//      parser stopped being a single anchored regex and became a CONSUMING LOOP,
//      which is a different and much more interesting thing to attack: a loop
//      whose branches can fail to shorten the input hangs the event loop for
//      every connected client, not just the caller.
//   2. roll_data gained a `groups` key that a browser feeds to a physics engine.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API4 Unrestricted Resource Consumption — the parser loop, dice bounds,
//        payload size, and sustained request cost
//   API3 BOPLA — forged roll_data; the server must compute, never accept
//   API8 Security Misconfiguration — CSP not weakened by the 3D layer
//
// Assertions are on measured outcomes, never on literals guessed in advance.
// Timing probes assert a RATIO against a measured baseline rather than an
// absolute millisecond figure, so they mean the same thing on a fast laptop and
// a loaded CI box.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

let pass = 0; let fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  DEFENDED  ${name}`); } else {
    fail += 1; results.push(`  VULNERABLE  ${name}  ${detail}`); findings.push(name);
  }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data, headers: res.headers };
    },
  };
}

async function mk(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  a.id = l.data.user.id;
  return a;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

(async () => {
  const gm = await mk('gm');
  const player = await mk('pl');
  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Dice audit', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const M = `/api/campaigns/${camp.id}/messages`;

  ok('setup: campaign created', !!camp);

  // ================= API4: the parser is a LOOP now ========================
  // A consuming loop whose branches can match the empty string never terminates,
  // and it does so inside the request handler — wedging the event loop for every
  // connected socket, not just this caller. Every input below is designed to
  // find a branch that consumes nothing.
  const nonTerminating = [
    '', ' ', '+', '-', 'd', 'dd', '+d', 'd+', '1d', '++', '--', '+-', '-+',
    '+'.repeat(60), '-'.repeat(60), 'd'.repeat(60), '1'.repeat(60),
    '1d6' + '+'.repeat(50), '+1d6'.repeat(20), '1d6'.repeat(20),
    '1d6+', '1d6-', '1d6+-1', '1d6++1', '1d-6', '1d+6',
    '.5d6', '1.5d6', '1d6.5', '1e3d6', '1d6e3', '0x10d6',
    '\u00A01d6', '1d6\u0000', '1d6\n1d4', '1d6\t+1d4', '1d6 1d4',
  ];
  let worstMs = 0; let worstIn = ''; let anyFiveHundred = false;
  for (const formula of nonTerminating) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const r = await player.req('POST', M, { formula });
    const ms = Date.now() - t0;
    if (ms > worstMs) { worstMs = ms; worstIn = formula; }
    if (r.status >= 500) anyFiveHundred = true;
  }
  ok('parser loop: no input hung the request', worstMs < 2000,
    `slowest ${worstMs}ms on ${JSON.stringify(worstIn)}`);
  ok('parser loop: no input produced a 500', !anyFiveHundred);
  note('parser loop timing', `${nonTerminating.length} adversarial formulas, slowest ${worstMs}ms`);

  // The server must still be alive and answering after all of that.
  const alive = await player.req('GET', M);
  ok('the server survived the parser fuzz', alive.status === 200, `got ${alive.status}`);

  // ================= API4: ReDoS ===========================================
  // A catastrophic-backtracking regex shows up as cost growing FASTER than the
  // input. Measured as a ratio against a baseline so it means the same thing on
  // any machine.
  const timeFor = async (formula, n = 5) => {
    const xs = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await player.req('POST', M, { formula });
      xs.push(Date.now() - t0);
    }
    return median(xs);
  };
  const baseline = await timeFor('1d6');
  const long = await timeFor('9'.repeat(63));
  const nested = await timeFor('1d6' + '+1d6'.repeat(15));
  ok('ReDoS: a 63-char digit run costs no more than ~5x a trivial roll',
    long <= Math.max(baseline * 5, baseline + 250), `baseline ${baseline}ms vs ${long}ms`);
  ok('ReDoS: 16 chained groups cost no more than ~5x',
    nested <= Math.max(baseline * 5, baseline + 250), `baseline ${baseline}ms vs ${nested}ms`);
  note('parser cost', `baseline ${baseline}ms · long ${long}ms · nested ${nested}ms`);

  // ================= API4: the bounds actually bind ========================
  const bounds = [
    ['101d6', 'more than MAX_DICE in one group'],
    ['60d6+60d6', 'MAX_DICE exceeded ACROSS groups, not within one'],
    ['1d1001', 'more than MAX_SIDES'],
    ['999999d999999', 'the classic dice bomb'],
    [Array.from({ length: 11 }, () => '1d6').join('+'), 'more than MAX_GROUPS'],
    ['2d6+99999', 'modifier past its bound'],
    ['1d6'.padEnd(80, '+1d6'), 'formula past MAX_FORMULA_LENGTH'],
    ['0d6', 'zero dice'],
    ['2d0', 'a zero-sided die'],
  ];
  for (const [formula, label] of bounds) {
    // eslint-disable-next-line no-await-in-loop
    const r = await player.req('POST', M, { formula });
    ok(`bound: ${label} refused`, r.status === 400, `got ${r.status}`);
  }
  const atBound = await player.req('POST', M, { formula: '100d1000' });
  ok('control: the worst LEGAL roll is still accepted', atBound.status === 201, `got ${atBound.status}`);
  ok('...and its stored payload stays small',
    JSON.stringify(atBound.data.message.roll_data).length < 4096,
    `${JSON.stringify(atBound.data.message.roll_data).length} bytes`);
  ok('...with exactly MAX_DICE results',
    atBound.data.message.roll_data.results.length === 100,
    `${atBound.data.message.roll_data.results.length}`);

  // ================= API4: sustained cost =================================
  // One client rolling the worst legal formula in a tight loop must not price
  // out everyone else. Measured against the same trivial baseline.
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => player.req('POST', M, { formula: '100d1000' })));
  const burst = Date.now() - t0;
  const after = await timeFor('1d6');
  ok('sustained load: the server still answers normally afterwards',
    after <= Math.max(baseline * 6, baseline + 400), `baseline ${baseline}ms vs ${after}ms after burst`);
  note('worst-case burst', `20 x 100d1000 in ${burst}ms`);

  // ================= API3 BOPLA: the server computes the roll ==============
  // break-combat.js probes this for a single group. The amendment added
  // `groups`, which is a NEW field a client might try to supply.
  const forged = await player.req('POST', M, {
    formula: '2d6',
    roll_data: { formula: '2d6', results: [6, 6], total: 12, groups: [{ count: 2, sides: 6, results: [6, 6] }] },
    groups: [{ count: 99, sides: 1000, results: Array.from({ length: 99 }, () => 1000) }],
    results: [6, 6],
    total: 9999,
  });
  const rd = forged.data && forged.data.message && forged.data.message.roll_data;
  ok('forged roll_data is ignored entirely', forged.status === 201 && !!rd);
  ok('...results are the server\'s, inside the die\'s range',
    rd && rd.results.length === 2 && rd.results.every((x) => x >= 1 && x <= 6),
    JSON.stringify(rd));
  ok('...total is recomputed, not accepted',
    rd && rd.total === rd.results.reduce((a, b) => a + b, 0), JSON.stringify(rd));
  ok('...a forged `groups` does not survive',
    rd && rd.groups.length === 1 && rd.groups[0].sides === 6, JSON.stringify(rd && rd.groups));
  // [FIXED 2026-08-03] This line previously read
  //     ok('...and the stored row matches what was returned', (async () => true)());
  // which is a probe that CAN NEVER FAIL — the second argument is a Promise, and
  // a Promise is always truthy. It reported DEFENDED on its first run and would
  // have gone on doing so through any regression. Caught by scanning every suite
  // for conditions that are literals, bare Promises or assignments.
  //
  // A probe that always passes is worse than no probe: it occupies a line in the
  // report and buys nothing, which is exactly the failure mode the standing rule
  // "a probe that cannot run must FAIL, not skip" exists to prevent. Replaced
  // with a real comparison of the response against the persisted row.
  const stored = await knex('messages').where({ id: forged.data.message.id }).first();
  ok('DB check: the persisted roll_data is byte-identical to the response',
    !!stored && JSON.stringify(stored.roll_data) === JSON.stringify(rd),
    `db=${JSON.stringify(stored && stored.roll_data)} vs api=${JSON.stringify(rd)}`);
  ok('DB check: the forged total never reached the database',
    !!stored && stored.roll_data.total !== 9999,
    JSON.stringify(stored && stored.roll_data));

  // A roll with no formula at all must not fabricate roll_data.
  const noFormula = await player.req('POST', M, {
    content: 'hi', roll_data: { formula: '1d20', results: [20], total: 20 },
  });
  ok('a plain message cannot smuggle roll_data in',
    noFormula.status === 201 && !noFormula.data.message.roll_data,
    JSON.stringify(noFormula.data && noFormula.data.message.roll_data));

  // ================= type confusion on the new field =======================
  const confusions = [
    ['formula', ['2d6']], ['formula', { d: 6 }], ['formula', 26], ['formula', true],
    ['formula', null], ['groups', 'x'], ['whisper_to', 'not-an-array'],
  ];
  for (const [field, value] of confusions) {
    const body = { content: 'x', [field]: value };
    // eslint-disable-next-line no-await-in-loop
    const r = await player.req('POST', M, body);
    ok(`type confusion: ${field}=${JSON.stringify(value)} -> 4xx or ignored, never 500`,
      r.status < 500, `got ${r.status}`);
  }

  // ================= canonical form: no injection into the log =============
  // The stored formula is echoed to every client and fed to a notation parser
  // in the browser. It must be the server's canonical string, never the
  // caller's, or a crafted formula becomes a payload other people render.
  const inj = await player.req('POST', M, { formula: '  2D6 + 3  ' });
  ok('the stored formula is canonicalised, not echoed',
    inj.status === 201 && inj.data.message.roll_data.formula === '2d6+3',
    JSON.stringify(inj.data && inj.data.message.roll_data.formula));
  const injAt = await player.req('POST', M, { formula: '2d6@6,6' });
  ok('an @ in the formula is REFUSED, not stored',
    injAt.status === 400, `got ${injAt.status} — @ is the predetermined-result operator client-side`);

  // ================= API8: the 3D layer did not weaken the CSP =============
  const page = await fetch(`${BASE}/combat.html`, { headers: { Cookie: gm.cookie } });
  const csp = page.headers.get('content-security-policy') || '';
  ok('a CSP header is present on the harness page', csp.length > 0);
  ok('script-src is still self-only (no CDN was added for the dice)',
    /script-src[^;]*'self'/.test(csp) && !/script-src[^;]*https:/.test(csp), csp);
  ok('no wasm-unsafe-eval was needed (the ThreeJS fork avoids AmmoJS)',
    !/wasm-unsafe-eval/.test(csp));
  ok('no unsafe-eval anywhere', !/'unsafe-eval'/.test(csp));
  ok('no worker-src widening was needed', !/worker-src[^;]*blob:/.test(csp));
  note('CSP', csp.slice(0, 220));

  // The vendored bundle must be served as a static asset, not executed anywhere.
  const vendor = await fetch(`${BASE}/vendor/dice/dice-box-threejs.es.js`);
  ok('the vendored library is served same-origin', vendor.status === 200, `got ${vendor.status}`);
  ok('...and its MIT LICENSE ships with it (thesis deposit)',
    (await fetch(`${BASE}/vendor/dice/LICENSE`)).status === 200);

  // ================= whispered rolls stay whispered ========================
  // The dice animate from message:created, so a whisper leaking would leak the
  // animation too. Re-probed here because the roll path changed.
  const secret = await gm.req('POST', M, {
    formula: '1d20', content: 'secret ambush check', whisper_to: [gm.id],
  });
  ok('a GM blind roll is accepted', secret.status === 201);
  const plHist = (await player.req('GET', M)).data.messages || [];
  ok('a blind roll never reaches the player over HTTP',
    !plHist.some((m) => m.id === secret.data.message.id));
  ok('...and its result is not in anything the player can read',
    !plHist.some((m) => m.content === 'secret ambush check'));

  console.log(results.join('\n'));
  console.log(`\n${pass} defended, ${fail} vulnerable`);
  if (findings.length) console.log('FINDINGS:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  console.log(results.join('\n'));
  await knex.destroy();
  process.exit(1);
});
