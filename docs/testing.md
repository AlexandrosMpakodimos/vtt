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
currently register 31 / 31 / 9 suites. The recorded run above predates
`test-media-proxy-gate.js`, the one database/integration suite added since. All
original suite entries retain their relative order.

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

## Media gate suite (host and proxy modes)

`tests/integration/test-media-proxy-gate.js` is the last entry in `DB`. It drives
the real media router over real HTTP with real Postgres fixtures and a stubbed
object read, once in host mode and once with `MEDIA_PROXY_SECRET` set. It starts
its own loopback listeners and does not use the isolated test server. It covers
proxy authentication (including refusal of a duplicated `X-Media-Proxy-Auth`
header in any capitalisation), the unchanged token, asset, metering and cache
behaviour, and secret validation. Its fixtures carry ownership markers: campaign
names starting `__vtt_media_proxy_gate_test__` and user emails ending
`@media-proxy-gate.invalid`. One check creates unmarked look-alike rows to prove
the marker cleanup is narrow. It does so inside a database transaction that is
always rolled back, so an exception, a lost connection or a killed process leaves
none of them behind. Teardown removes and verifies everything the suite created by
recorded id, not only rows that carry the markers.

Owner verification on macOS with PostgreSQL 17 passed: 71 suites,
4,008 assertions, zero failures (104.1 seconds). The new media proxy gate
suite also passed standalone with 73 assertions. The manual host-mode
diagnostic passed 10 assertions; its byte read returned the expected 502
without R2, so it does not establish live storage delivery.

**Interruption recovery.** A killed run leaves the marked rows it had committed;
the look-alike block leaves nothing. Starting the suite again removes only rows
carrying its markers, but that cannot protect earlier suites in the next full run:
`test-assets.js`, for example, refuses to start while stored test assets remain.
After an interruption, run this suite once by itself, with the isolated server
running, before the next full run:

```
node scripts/test-local.js test-media-proxy-gate.js
```

Alternatively, against `vtt_test` with the test role, remove only its rows:

```sql
BEGIN;
DELETE FROM assets WHERE campaign_id IN (SELECT id FROM campaigns WHERE starts_with(name, '__vtt_media_proxy_gate_test__')) OR user_id IN (SELECT id FROM users WHERE email LIKE '%@media-proxy-gate.invalid');
DELETE FROM campaign_members WHERE campaign_id IN (SELECT id FROM campaigns WHERE starts_with(name, '__vtt_media_proxy_gate_test__'));
DELETE FROM campaigns WHERE starts_with(name, '__vtt_media_proxy_gate_test__');
DELETE FROM users WHERE email LIKE '%@media-proxy-gate.invalid';
COMMIT;
```

Neither route touches unmarked rows or loosens the preconditions of other
suites. An interrupted run can also leave the budget ledger row with the counters
this suite set; the budget suites reset that row themselves before using it.

## Media proxy Worker package

`workers/media-proxy/` is a separate package with its own manifest, lockfile and
dependency (Miniflare, which brings workerd). Its tests are not registered in
`tests/suites.js`, are not part of `npm test`, `npm run test:db`, `npm run test:sec`
or `npm run test:all`, and do not change the app's dependency tree.

| Command, from `workers/media-proxy/` | What it runs | Needs |
| --- | --- | --- |
| `npm test` | Unit and runtime tests | `npm ci` in that directory only |
| `npm run test:unit` | The Worker handler in Node with an injected mock upstream | Same |
| `npm run test:runtime` | The same Worker on workerd (through Miniflare) with the upstream mocked at the network boundary | Same |
| `npm run test:integration` | The Worker, in Node and in workerd, forwarding over loopback to the app's real media router; then four failure checks that re-run the same file as child processes with a fault | `npm ci` here and at the repository root; the isolated test database |

Three kinds of evidence are kept apart:

| Kind | Tests | What is real | What is not |
| --- | --- | --- | --- |
| Mocked | Unit and runtime | The Worker code | The upstream: every answer is scripted |
| Local integration | `test:integration` | The Worker code, the app's media router with the merged proxy gate, Postgres fixtures | Object storage (stubbed with a read counter), every secret (synthetic), and the network (the HTTPS upstream is mapped to a loopback listener) |
| Deployment evidence | None yet | | Nothing has run on Render or Cloudflare. TLS, Host and header forwarding, a sleeping service, bandwidth, edge behaviour and platform logging are unverified. |

The integration check forces `NODE_ENV=test` before any app module loads, so the
knexfile allows only the dedicated `vtt_test` database and `vtt_test_runner` role
and never falls back to `DATABASE_URL`. A missing test configuration fails the run;
it never skips. It does not use the isolated test server.

Its fixtures carry ownership markers: campaign names starting
`__vtt_media_worker_integration__` and user emails ending
`@media-worker-integration.invalid`. Setup records what it has actually created,
step by step. Teardown closes exactly those resources, guards every database
operation on its own, and always restores local state (environment, console
methods, module-cache entries, installed storage stubs) even if setup or the
database cleanup failed. It removes this run's rows by marker and by recorded id,
restores the budget ledger row, and closes the listener, the workerd instances and
the database pool. A setup failure stays the reported failure. An ordinary test
after the suite asserts that teardown cleaned up completely, because a failing
after-hook alone does not fail the runner's summary or exit code.

Four failure checks re-run the same file as a child process, without the runner's
forced exit, and read a teardown report that the child prints: a real
configuration rejection before Knex is assigned (no test URL and an empty home
directory), an injected failure after the pool exists, an injected failure after
the listener and fixtures exist, and an injected failure in the database cleanup.
Each child must exit nonzero by itself, report that local state was restored and
that everything it created was closed, and keep the original failure visible. The
injections are set only by these checks through `VTT_WORKER_INTEGRATION_*`
variables, and are refused outside a child run.

If a run is interrupted, its committed rows remain and would make the registered
`test-assets.js` refuse to start. Run `npm run test:integration` once by itself, or
remove only its rows:

```sql
BEGIN;
DELETE FROM assets WHERE campaign_id IN (SELECT id FROM campaigns WHERE starts_with(name, '__vtt_media_worker_integration__')) OR user_id IN (SELECT id FROM users WHERE email LIKE '%@media-worker-integration.invalid');
DELETE FROM campaign_members WHERE campaign_id IN (SELECT id FROM campaigns WHERE starts_with(name, '__vtt_media_worker_integration__'));
DELETE FROM campaigns WHERE starts_with(name, '__vtt_media_worker_integration__');
DELETE FROM users WHERE email LIKE '%@media-worker-integration.invalid';
COMMIT;
```

Owner verification on macOS with PostgreSQL 17 passed. Before dependency
remediation, the application regression passed 71 suites and 4,008 assertions
with zero failures (215.3 seconds). After applying the Worker dependency
overrides, a clean npm ci, npm audit (zero vulnerabilities), npm ls --all,
and the Sharp load/PNG round-trip check passed. Worker unit/runtime tests
passed 87 of 87, and Worker-to-router integration passed 30 of 30, including
teardown and partial-setup failure checks. Integration uses local PostgreSQL
and stubbed storage; these results do not establish live Cloudflare, Render
or R2 delivery.

`npm audit` in `workers/media-proxy/` reports no advisories. That depends on
`overrides` in the package manifest, which raise two exact pins inside Miniflare
4.20260730.0 (`sharp` 0.35.4 and `undici` 7.29.0), because no stable Miniflare
release pins fixed versions yet. The package README records what was checked and
when the overrides can be removed.

Two workerd behaviours found by the integration check are worth knowing. The
runtime adds `Cache-Control: no-cache`, `Pragma: no-cache` and `cf-worker` to the
Worker's outbound request (from `cache: 'no-store'` and its own identification),
beyond the header allowlist the Worker code sets. And a streamed GET reaches the
client without `Content-Length` in workerd; the Worker never sends a wrong one.
Neither weakens the reviewed contract. Whether the real edge behaves the same is a
deployment-only check.

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

## Production database profile / session ownership follow-up

Locked-source verification: connect-pg-simple 10.0.0, pg 8.21.0, pg-pool 3.14.0,
Knex 3.2.10, Tarn 3.0.2; URL parsers 2.6.2 (Knex) and 2.13.0 (nested under pg).
Use npm ci; do not update the lockfile to run these tests. The package archives
were checked against package-lock integrity values during review.

Offline:

```
node tests/unit/test-production-db-config.js
node tests/unit/test-production-migrate-command.js
node tests/unit/test-auth-session-revocation.js
node tests/unit/test-socket-sessions.js
```

The profile suite uses actual installed Knex/Tarn and pg-pool with fake network
clients to verify hooks block acquisition until success and reject before use.
It checks driver TLS options without a network connection. It is not a real TLS
handshake or Neon pooler test. Production config has no local-test bypass.

Real migration and session behavior uses the existing isolated local database
and server setup documented above, then:

```
node scripts/test-local.js test-session-store-migration.js
```

This suite runs under NODE_ENV=test with the original vtt_test/vtt_test_runner
URL and role-privilege guard. It creates random db_review_* schemas, runs the real
migration chain and locked session store on synthetic rows, and removes only its
own schemas in finally. The session pool also awaits the existing test identity
check. Fixtures cover fresh creation, populated adoption, unchanged history,
concurrent migration locking, repeat no-op, incompatible schema rollback,
equivalent index adoption, session CRUD/touch and refusal of destructive down.
The test must fail, not skip, if the guarded database is unavailable. Do not run
it against any existing user database or supply a production URL.

Required evidence before merge: offline suites pass; real guarded migration/store
suite passes; historical migration hashes, root lockfile and Worker package tree
remain unchanged. A source/syntax check is not a substitute for database evidence.

### Revised teardown and rejection fixtures

The database suite reports success only after teardown. Each store close, pool
end, Knex destroy, fixture-schema drop and final administrator destroy is attempted
independently with a three-second deadline. The original test/setup error remains
primary; cleanup failures are collected by resource label. Any failure yields a
nonzero exit. A final bounded termination prevents failed driver cleanup from
holding the test process open. A failed schema drop can leave that invocation's
synthetic schema; review the failure and do not run broad cleanup automatically.

After the original local identity/privilege check passes, the suite launches its
own guarded child invocations to inject partial setup failure, store cleanup
failure, combined setup/cleanup failure, a stalled close, and multiple cleanup
failures. It verifies nonzero normal termination, no success line or unhandled
rejection, preservation of the primary failure, all cleanup attempts, and removal
of the child-created schema. There is no production/local bypass or alternate
connection environment. Run the normal isolated suite command; no manual injection
flags are needed.

Populated rejection fixtures cover timestamp mismatch, bounded sid, extra/nullable
columns, missing/wrong/composite/deferrable primary keys, check/unique constraints,
additional unique indexes, user triggers, enabled/forced RLS, inheritance parents
and children, partition parents and children, and conflicting expiry-index names.
Every failed adoption checks both rows and schema catalog snapshots (columns,
relations, constraints, indexes, triggers, policies, inheritance and functions).
A transaction-local marker table must also disappear, demonstrating rollback.
Touch uses a substantially later TTL and asserts the stored expiry increased;
retaining only the session payload is not sufficient evidence.

### Owner verification: database configuration and session migration

Owner verification on macOS with PostgreSQL 17 passed:
- Unit: 33 suites, 2,204 assertions, zero failures.
- Database/integration: 32 suites, 1,491 assertions, zero failures.
- Security: 9 suites, 486 assertions, zero failures.
- Combined application groups: 74 suites, 4,181 assertions, zero failures.
- Session-store migration suite: 104 assertions, passing standalone and within
  the database group.
- Worker-to-router integration: 30 tests, zero failures.

These are local isolated-database results. No production migration, live TLS
handshake, Neon pooler validation or deployment was performed.
