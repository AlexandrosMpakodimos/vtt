// Test runner.
//
//   npm test            registered unit suites (no external server or database)
//   npm run test:db     registered database/integration suites (isolated wrapper)
//   npm run test:sec    registered adversarial suites (isolated wrapper)
//   npm run test:all    all registered groups, sequentially
//
// tests/suites.js contains the authoritative suite lists and order. See
// docs/testing.md for the recorded baseline, setup, and isolation requirements.
//
// ---------------------------------------------------------------------------
// WHY A RUNNER RATHER THAN A SHELL ONE-LINER
// ---------------------------------------------------------------------------
// `node a.js && node b.js && ...` in package.json would work and would be
// wrong in two ways this project cares about.
//
// FIRST, IT CANNOT TELL A FAILURE FROM A CRASH. A suite that dies on a missing
// fixture, an unreachable server or a stale contract exits non-zero exactly as
// a suite with a failing assertion does, and `&&` stops at the first one either
// way — so the report says "something broke" and nothing about what still runs.
// The project's standing rule is that a probe which cannot run must FAIL rather
// than skip; a runner that cannot distinguish "0 of 41 ran" from "40 of 41
// passed" silently converts the first into the second.
//
// SECOND, THE DATABASE SUITES ARE ORDER- AND STATE-SENSITIVE. Several assert an
// EXACT landing count under concurrency — 500 tokens, 200 fog regions, exactly
// one active combat — against caps that are global to a scene or a campaign.
// Running them in parallel would have them race each other's fixtures rather
// than the code under test, and the failures would look like TOCTOU defects.
// They are therefore run STRICTLY SEQUENTIALLY, and this comment exists so that
// nobody "speeds up" the runner by parallelising it.
//
// For an individual database/server-backed suite, use the isolated wrapper:
//     node scripts/test-local.js break-m6.js
// Unit suites can also run directly: node tests/unit/test-events.js.

const { spawnSync } = require('child_process');
const fs = require('fs');

const { UNIT, DB, SEC, resolveSuite } = require('./tests/suites');
const { root, rootPath } = require('./tests/helpers/paths');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Every suite ends with a count, and they do not all phrase it the same way:
//   "94 passed, 0 failed"
//   "fog validators: 39 passed, 0 failed"
//   "59 defended, 0 VULNERABLE"
//   "18 defended, 0 VULNERABILITIES"
// Parsed from the LAST match so a section header quoting a number cannot be
// mistaken for the total.
function parseTotals(output) {
  const re = /(\d+)\s+(?:passed|defended)[,\s]+(\d+)\s+(?:failed|vulnerable|vulnerabilities)/gi;
  let last = null;
  for (const m of output.matchAll(re)) last = m;
  if (!last) return null;
  return { passed: Number(last[1]), failed: Number(last[2]) };
}

// A suite that cannot start is a FAILURE, never a skip. This is the whole
// reason the runner exists: an unreachable server, a missing file or a crash
// mid-run must all be loud, and must not be reported as "0 failed".
function runOne(file) {
  const filename = rootPath(resolveSuite(file).file);
  if (!fs.existsSync(filename)) {
    return { file, ok: false, reason: 'FILE MISSING', passed: 0, failed: 0 };
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [filename], {
    cwd: root,
    env: { ...process.env, SKIP_HIBP: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  const totals = parseTotals(output);

  if (totals === null) {
    // No count printed at all: the suite died before it could report. Keep the
    // tail of the output, because that is the only diagnostic there is.
    const tail = output.trim().split('\n').slice(-6).join('\n      ');
    return { file, ok: false, reason: 'CRASHED — no result line', tail, ms, passed: 0, failed: 0 };
  }
  return {
    file,
    ok: totals.failed === 0 && r.status === 0,
    passed: totals.passed,
    failed: totals.failed,
    ms,
    // A suite can print "0 failed" and still exit non-zero if it threw after
    // reporting. Surface that rather than trusting the printed line.
    reason: totals.failed === 0 && r.status !== 0 ? `reported clean but exited ${r.status}` : null,
  };
}

// Preflight for the groups that need a server. Failing here with an explanation
// beats repeated connection-refused stack traces.
async function serverIsUp() {
  try {
    // Reachability only: an unauthenticated request can return 401 before the
    // campaign query, so this does not establish database health or isolation.
    // scripts/test-local.js first checks /__test/identity, which queries Postgres
    // and verifies the dedicated database/role, memory storage, and upload mode.
    const res = await fetch(`${BASE}/api/campaigns/search?q=preflight`);
    return res.status < 500;
  } catch {
    return false;
  }
}

function pad(s, n) { return String(s).padEnd(n); }

(async () => {
  const group = (process.argv[2] || 'unit').toLowerCase();
  const groups = {
    unit: [['no server or database', UNIT]],
    db: [['functional', DB]],
    sec: [['adversarial', SEC]],
    all: [['no server or database', UNIT], ['functional', DB], ['adversarial', SEC]],
  };
  const plan = Object.hasOwn(groups, group) ? groups[group] : null;
  if (!plan) {
    console.error(`unknown group "${group}" — expected one of: ${Object.keys(groups).join(', ')}`);
    process.exit(2);
  }

  const needsServer = group !== 'unit';
  if (needsServer && !(await serverIsUp())) {
    console.error(`\nThe server is not answering at ${BASE}.\n`);
    console.error('  terminal 1:  npm run dev:test');
    console.error('  terminal 2:  npm run test:' + (group === 'all' ? 'all' : group) + '\n');
    console.error('If Postgres is also down after a reboot:  brew services start postgresql@17\n');
    // Exit non-zero rather than running suites that will all fail the
    // same way: a preflight that cannot pass is a failure, not a skip.
    process.exit(1);
  }

  const results = [];
  const t0 = Date.now();

  for (const [label, files] of plan) {
    console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}`);
    for (const file of files) {
      const r = runOne(file);
      results.push(r);
      const status = r.ok ? 'ok  ' : 'FAIL';
      const count = r.failed || !r.ok
        ? `${r.passed} passed, ${r.failed} failed`
        : `${r.passed} passed`;
      console.log(`  ${status}  ${pad(file, 26)} ${pad(count, 24)} ${r.ms ? `${r.ms}ms` : ''}`);
      if (r.reason) console.log(`        ${r.reason}`);
      if (r.tail) console.log(`      ${r.tail}`);
    }
  }

  const passed = results.reduce((a, r) => a + r.passed, 0);
  const failed = results.reduce((a, r) => a + r.failed, 0);
  const broken = results.filter((r) => !r.ok);

  // A crashed suite contributes 0 to BOTH counts, so a headline reading
  // "0 failed" beside a crash is exactly the misreading this runner exists to
  // prevent. Crashes are counted separately and stated first.
  const crashed = results.filter((r) => r.passed === 0 && r.failed === 0 && !r.ok).length;

  console.log(`\n${'═'.repeat(60)}`);
  const parts = [`${results.length} suites`, `${passed} assertions`];
  if (failed) parts.push(`${failed} FAILED`);
  if (crashed) parts.push(`${crashed} CRASHED`);
  if (!failed && !crashed) parts.push('0 failed');
  parts.push(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(parts.join(' · '));
  if (broken.length) {
    console.log(`\n${broken.length} suite(s) did not pass:`);
    for (const r of broken) console.log(`  - ${r.file}${r.reason ? ` (${r.reason})` : ''}`);
  }
  process.exit(broken.length ? 1 : 0);
})();
