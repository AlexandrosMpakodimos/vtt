# Tests and isolation

## Recorded baseline

The completed local audit recorded 30 unit suites / 1,973 assertions,
30 database/integration suites / 1,314 assertions, and 9 security suites /
485 assertions: 69 suites / 3,772 assertions with zero failures. Independent
GM/player open/close/reopen checks also passed according to the handoff.
Do not rerun that audit merely to establish context.

The authoritative registration and order are the `UNIT`, `DB`, and `SEC` arrays
in `run-tests.js`. They are explicit lists, not automatic discovery. This PR
moves no tests and changes no commands, paths, registrations, or execution logic.

`test-media-integration.js` is present but not registered. Its historical usage
comment is not the current isolated setup procedure. Its prerequisites and
runner inclusion need a separate decision; do not count it among the 69 passing
suites or silently add it to the baseline.

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
after every edit. The wrapper also accepts existing root-level `break-NAME.js`
filenames. A single-suite wrapper invocation verifies the test server even for
a unit filename; unit suites can instead run directly with Node from the root.

The isolated server is plain Node, not nodemon. Restart it after executable
server changes; an identity check does not prove it loaded the latest source.
`EADDRINUSE` means the old process still owns the port. Stop the known server in
its terminal; do not kill arbitrary Node processes.

Use exactly `http://127.0.0.1:3001` in the browser. `localhost:3001` is a different
origin and is not the configured test origin. Do not disable CSRF to work around
an origin mismatch.

At the agreed refactoring endpoint, with the current isolated server running:

```sh
npm run test:all
```

Then repeat the independent GM/player browser check: open delivers updates,
close stops new player game updates while retaining lobby state, and reopening
plus explicit player re-entry restores game updates. Use isolated fixtures.

## Runner contracts

- Keep child-process suite isolation and the existing explicit group order.
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

## Direct-testability work in the later PRs

Replace campaign source slicing with imports while retaining retry-exhaustion,
commit-failure, permission-transition, response, and post-commit-effect scenarios.
Keep controlled latches and PostgreSQL tests; do not substitute timing sleeps
or mocks asserting only query method names.

During socket extraction, retain all current admission cases and add the focused
case that delays `socket.join()` itself, invalidates admission, then completes
the join and verifies cleanup/refusal. The current admission fake delays the
authorization read but joins synchronously.

`test-events.js` scans `src/routes` and `src/socket.js`. If emitters move, update
the concrete scan paths in the same PR so the check does not lose coverage.
Whole-script JSDOM loading is distinct from backend source snippets; frontend
test restructuring and auth test extraction are outside this pass.
