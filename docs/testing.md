# Tests and isolation

## Verification records

The owner-reported full macOS run immediately before frontend organization:

| Group | Suites | Assertions |
| --- | --- | --- |
| Unit | 31 | 2,134 |
| Database/integration | 30 | 1,314 |
| Adversarial | 9 | 485 |
| Total | 70 | 3,933 |

That run had zero failures. The current organization adds one landing-stylesheet
link check and one successful-game-page-response check to the existing suites.
Expected totals are 2,135 unit + 1,314 integration + 486 adversarial = 3,935.
The integration/security and browser results for this change must be recorded
when actually run; these expected counts are not a claimed full-run result.
Earlier audit results remain [historical evidence](history/authorization-audit.md).

The authoritative registration and order are the `UNIT`, `DB`, and `SEC` arrays
in `tests/suites.js`. They are explicit lists, not automatic discovery, and
currently register 31 / 30 / 9 suites, matching the recorded run. All original
suite entries retain their relative order.

Suites live in `tests/unit/`, `tests/integration/`, and `tests/security/`.
The root `run-tests.js` remains the runner; npm commands are unchanged.
`tests/helpers/paths.js` resolves filesystem reads from the repository location,
not the caller's working directory. Inline fixtures remain in their suites.

`tests/integration/test-media-integration.js` is manual-only and separately
mapped, never registered in `UNIT`, `DB`, `SEC`, or `all`. Explicit invocation is
`node scripts/test-local.js test-media-integration.js` after starting the isolated
server. Its conditional checks and acceptance of 200/502/429 on one media path
remain unchanged; this is not proof of successful byte delivery. Prerequisite
review and runner inclusion need a separate decision. Do not count it among the
70 recorded suites or silently add it to the baseline.

## Existing isolated environment

`knexfile.js` in test mode uses `TEST_DATABASE_URL`, or reads that key from the
existing private `~/vtt-test-config.env`. It never falls back to `DATABASE_URL`.
The target must be a loopback PostgreSQL server, database `vtt_test`, and role
`vtt_test_runner`, with a password and no URL query/fragment. Pool initialization
checks database/role identity and rejects superuser, createdb, createrole, or
bypassrls privileges. Do not request or share the connection value for review.

Reuse the working test database and role. This guide does not create or reset
them. If an isolated schema needs migrations, use its explicit test environment:

```sh
NODE_ENV=test npm run migrate
```

The test wrapper validates the dedicated configuration, sets the repository as
working directory, and passes an allow-listed environment. It supplies local
test-only secrets, JSON email, raised test limits, strict uploads, and the exact
base URL. Real R2 access is disabled in test mode; the test server injects the
isolated memory backend. It must not be replaced with live storage for these runs.

## Commands

From the repository root, start the isolated server in a dedicated terminal:

```sh
npm run dev:test
```

In another terminal, select only the affected group or suite:

```sh
node scripts/test-local.js check
npm test
npm run test:db
npm run test:sec
node scripts/test-local.js test-campaigns.js
```

These are alternatives to choose as needed, not a requirement to run every line
after every edit. The wrapper selects exact known `test-NAME.js` or
`break-NAME.js` basenames through `tests/suites.js`; the familiar single-suite
commands remain valid after relocation. Unknown names, inherited object-property
names and paths (including traversal) are refused. A single-suite wrapper
invocation verifies the test server even for a unit filename; unit suites can
instead run directly without that server, for example:

```sh
node tests/unit/test-events.js
```

Runner and wrapper children use the repository root as their working directory.
Launcher paths and test filesystem reads are resolved from module locations, so
invoking an absolute launcher or unit-suite path from another directory works.
Individual wrapper runs retain standalone exit/report behavior; use the central
registered security group for closeout, as described below.

The isolated server is plain Node, not nodemon. Restart it after executable
server changes; an identity check does not prove it loaded the latest source.
`EADDRINUSE` means the old process still owns the port. Stop the known server in
its terminal; do not kill arbitrary Node processes.

Use exactly `http://127.0.0.1:3001` in the browser. `localhost:3001` is a different
origin and is not the configured test origin. Do not disable CSRF to work around
an origin mismatch.

When a concrete release gate requires the full run, with the current isolated server running:

```sh
npm run test:all
```

Then repeat the independent GM/player browser check: open delivers updates,
close stops new player game updates while retaining lobby state, and reopening
plus explicit player re-entry restores game updates. Use isolated fixtures.

## Runner contracts

- Keep child-process suite isolation, explicit root `cwd`, and the existing group order.
  Database/security suites run sequentially because shared fixtures and exact
  cap assertions can interfere. Concurrency inside a race suite is intentional.
- Missing files, crashes, nonzero exits, and reported assertion/security failures
  must fail. The runner parses the last result summary and also checks exit
  status; some standalone adversarial scripts do not reliably fail by exit
  status alone. Use the central runner for security closeout.
- The runner's campaign-search preflight establishes HTTP reachability, not
  database health: unauthenticated requests can stop at the auth guard. The
  wrapper's `/__test/identity` check queries PostgreSQL and verifies environment,
  database, role, memory storage, and strict upload mode before DB/security work.
- The unit group needs no external server/database. Some tests create their own
  loopback HTTP server. Do not equate "unit" with "no network socket ever opened".

## Frontend organization

JSDOM fixture pages live under `tests/fixtures/pages/` and are not served by
Express. The production page DOM and linked assets remain under `public/`.
The event scanner recursively covers JavaScript under `public/js/`, including
all page, game, sheet, UI and shared directories. It does not scan vendored code.
CSS source assertions read the linked stylesheet rather than requiring embedded
styles in the HTML. Browser checks still matter: JSDOM does not prove rendering.

After frontend path/style changes, check landing/login, light/dark themes,
dashboard dialogs, game layout, character/item/spell forms, image framing and
dice. For socket-affecting changes, check independent GM/player open, close and
explicit re-entry behavior. Use the isolated environment for automated suites.

Controlled operation/lifecycle tests supplement real HTTP/PostgreSQL coverage;
they do not prove database isolation or real network scheduling on their own.
