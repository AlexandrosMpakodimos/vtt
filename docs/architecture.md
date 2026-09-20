# Architecture and bounded refactoring

This describes the completed bounded refactoring: the documentation PR, campaign
operations (PR #13), and the coordinated socket lifecycle (PR #14).

## Current responsibilities

| Area | Current responsibility and coupling |
| --- | --- |
| `src/server.js` | Compose Express, sessions, Passport, Socket.IO, routes, error handling, cleanup timers, and listening |
| `src/db/`, `knexfile.js` | Database access and migrations; dedicated test-environment restrictions |
| `src/middleware/` | Authentication, campaign read/access guards, CSRF origin checks, rate limiting |
| `src/routes/campaigns.js` | Existing mounts/guards and production dependency wiring; retains reads and color/archive handlers |
| `src/routes/campaignMutations.js` | Importable mutation HTTP handlers: status/headers, public responses, media rewriting, post-commit effects |
| `src/services/campaigns/` | Mutation operations own validation/transactions/retries; presentation functions retain allow-listed responses; shared recovery-window constant |
| `src/middleware/campaignAuthFactory.js` | Existing campaign guard bodies behind an explicit DB dependency; `campaignAuth.js` preserves existing exports with the production DB |
| `src/routes/scenes.js` | Scenes, tokens, fog, shaping, and movement policy; imports actor/combat helpers |
| `src/routes/actors.js` | Actors, actor-scoped inventory and spellbooks, disclosure/write policies; imports item helpers |
| Other resource routers | Item/spell catalogues, combat, chat, assets, and media delivery |
| `src/socket.js` | Connection/session enforcement and lifecycle wiring, existing broadcasts, token movement and pings; imports scene-route helpers |
| `src/socket/roomLifecycle.js` | Admission generations, room admission/leave, eviction, shared user/socket tracking, distinct-user presence and disconnect coordination |
| `src/services/socketSessions.js` | Live session-store checks and exact-SID disconnection for this process |
| Other `src/services/` modules | Validators, scene access, atomic caps, dice/password/email helpers, media/storage, budget, cleanup, and reconciliation |
| `public/` | Served HTML/CSS/JavaScript, including local vendored dice assets |
| `tests/unit/`, `tests/integration/`, `tests/security/` | Suites registered in order by `tests/suites.js` and executed by root `run-tests.js` |
| `scripts/` | Test isolation wrapper/server and maintenance/development utilities |

Campaign routes mount authentication once before the nested resource routers.
Resource guards resolve campaign/member state. HTTP handles structural writes;
Socket.IO also handles token movement and transient pings. Mutations call the
`campaignSockets` object installed on the Express app to update connected clients.
See [invariants](invariants.md) for the important differences between early
middleware authorization and transaction-protected authority checks.

The database has a Knex pool and a separate `pg` pool for sessions. Importing
`src/server.js` starts listening and schedules cleanup work. It is not currently
an inert application factory.

## Frontend composition

`public/game.html` composes scene, combat, actor, alignment, sheet, and shared UI
scripts. `public/js/game.js` supplies the shell and reconnect catch-up behavior.
Several components expose `window.VTT*` APIs; some use IIFEs to prevent collisions
between names originally used on separate pages. The dice renderer is a browser
ES module importing the vendored renderer. Preserve script order and existing
entry points when changing this area.

Standalone scene/actor/combat pages also support existing JSDOM suites. Shared
helpers exist in `common.js`, sheets, image picking/framing, and closed notices,
but page modules still duplicate some request/UI logic. Large modules and
embedded styles are maintenance debt, not a requirement for a framework change.

## Bounded refactoring plan

1. **Documentation and necessary organization (merged).** Record actual architecture,
   commands, invariants, and deployment backlog. Correct demonstrably stale
   comments. That PR moved no tests and left paths, runner registration, package
   scripts, and executable code unchanged. Do not
   introduce a manifest or compatibility mechanism without a current use.
2. **Campaign operations and affected tests (merged in PR #13).** Create, join,
   leave, owner PATCH/DELETE, restore, transfer, kick/ban, and unban use plain
   CommonJS operations. Authority checks, locks, writes, and retries stay together.
   HTTP handlers preserve responses and existing post-commit socket ordering.
   Five controlled suites import these production factories instead of slicing
   source. The two middleware/transfer tests also import the unchanged campaign
   guard bodies through a DB-injected factory. A focused contract suite controls
   commit completion/failure and checks effects and response shaping. Real
   PostgreSQL suites and all existing scenarios remain intact.
3. **Coordinated socket lifecycle (merged in PR #14).** Keep admission cancellation, eviction,
   tracking, and presence coordination under one owner. Preserve `src/socket.js`
   as the entry point and its existing exports. Keep `socketSessions.js` focused
   on session validity. Add a controlled delayed-`join()` regression. Extract
   broadcasts only if doing so stays within this scope; token/ping and broad
   scene/actor/combat extraction are not completion requirements.

`src/services/campaigns/operations.js` and `presentation.js` now exist.
`createCampaignOperations` takes explicit database/password/ID-validation/limit
dependencies; delay, randomness, and clock can be controlled without global
patching. It takes caller IDs rather than middleware snapshots. Expected
refusals return status/error data; unexpected errors reject. It never receives
`req`/`res` or emits socket effects. `createCampaignMutationHandlers` is the same
HTTP adapter factory used by the real router and controlled tests.

`createRoomLifecycle({ io, knex, isActiveMember })` owns the room lifecycle in
`src/socket/roomLifecycle.js`. The entry point attaches it only after the existing
user and session gates. Admission and eviction share its generation state, and
broadcasts use its existing `socketsByUser` map. Disconnect captures game rooms
before leaving and updates presence afterward. Broadcast implementations and
token/ping handlers stay in the entry point. Existing exports and aliases remain.
The admission suite imports this production factory; no VM loader or compatibility
shim is needed. The event scanner includes the relocated lifecycle emitters.
Those extraction PRs moved no tests and needed no runner or npm command changes.
The later test-organization pass below preserves their assertions and interfaces.

Authentication implementation is unchanged throughout this pass. No framework
migration, TypeScript conversion, dependency upgrade, generic repository layer,
global configuration rewrite, or new test framework is required. Deployment
fixes and media-policy decisions stay in [the separate backlog](deployment.md).

## Repository layout: paths kept on purpose

These paths look unusual but have recorded reasons. Revisit them only with new
evidence.

- **`tests/`.** The owner-requested organization groups the existing 71 files
  into unit, integration and security directories. `tests/suites.js` retains the
  exact 31/30/9 registered order and separately maps the unregistered media test.
  The runner and isolated wrapper share its exact-basename mapping; no per-test
  root stubs or discovery rules are used. `tests/helpers/paths.js` anchors reads
  and scans to this repository. Inline fixtures remain in place; no fixtures
  directory or new test framework is needed.
- **`tests/integration/test-login-session-races-db.js`.** This existing small
  wrapper sets PostgreSQL mode before importing the implementation now located
  in `tests/unit/test-login-session-races.js`. Each suite still runs in a separate
  child process; the cross-group import avoids duplicating the race scenarios.
- **`public/scene.html`, `combat.html`, `actors.html`, `align.html`.** Standalone
  dev-harness pages no longer linked from the app UI. Eight suites load them
  through JSDOM, `test-game-ui.js` compares their element IDs with `game.html`,
  and `break-dice.js` fetches `/combat.html`. Whether to serve them in production
  is a separate deployment decision.
- **`public/vendor/dice/`.** Vendored `dice-box-threejs` with its MIT license;
  textures load by name at runtime. Four texture files are not named literally in
  the bundle or `dice3d.js`. Whether the library ever requests them is
  unconfirmed, and they are small (about 79 KB), so they stay with the upstream
  tree.
- **`src/db/seeds/`.** Configured in `knexfile.js`; no seed files are tracked.
  An empty local directory may exist and does not need removal.
- **`tests/integration/test-media-integration.js`.** Present but unregistered; see [testing](testing.md).
- **Untracked local files.** Backups, repair scripts, and diagnostics are not part
  of the repository, and their owner decides whether to archive or remove them.
  Ignore rules only prevent accidental staging; they do not mean a file was
  reviewed.

## Completion and verification

Status: complete. The audit and the three planned refactoring PRs are done;
recorded results are in [testing](testing.md), and deployment limitations
remain in [the backlog](deployment.md).

Use affected checks while implementing each extraction. Preserve transaction,
HTTP, socket, and test-isolation contracts. At the endpoint, run the registered
full regression once and repeat the independent GM/player open/close/reopen
browser check. New focused assertions may change the total; preserve scenarios
rather than treating the historical count as a permanent target.

Stop after these bounded PRs meet their criteria. Do not require moving every
test, removing every cross-router import, or restructuring the frontend before
finishing. If a behavior issue is found, record its scope separately instead of
silently adding it to a refactoring diff.

This small-change approach follows [Google's review guidance](https://google.github.io/eng-practices/review/developer/small-cls.html).
Socket.IO's [application-structure examples](https://socket.io/docs/v4/server-application-structure/)
are optional suggestions, not a required architecture.
