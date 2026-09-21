# Architecture and repository layout

## Backend

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Express/HTTP composition, sessions, Passport, route mounts, Socket.IO and maintenance scheduling |
| `src/db/`, `knexfile.js` | Database pools, ordered migrations and test-target restrictions |
| `src/middleware/` | Authentication, campaign access, CSRF and rate limits |
| `src/routes/` | HTTP resource handlers and response shaping |
| `src/routes/campaignMutations.js` | Campaign mutation HTTP adapters and post-commit effects |
| `src/services/campaigns/` | Campaign transactions, retries, presentation and constants |
| `src/services/` | Shared validation, password/email, storage/media and accounting behavior |
| `src/socket.js` | Session-enforced connection wiring, broadcasts, movement and pings |
| `src/socket/roomLifecycle.js` | Admission generations, eviction, tracking and presence |
| `scripts/` | Test launchers and storage/development utilities |

Campaign routes mount authentication before nested resources. Middleware checks
are not a substitute for fresh authority checks inside protected transactions;
see [invariants](invariants.md). Campaign operations own transactions and retries;
HTTP adapters own responses and effects after successful commits.

The Knex pool and the session `pg` pool are separate. Importing `src/server.js`
starts listening and schedules maintenance: it is not an inert app factory.
Socket admission and eviction share generation state under one lifecycle owner.
Session revocation and room state are process-local.

All 23 migrations remain part of constructing/upgrading the current schema.
There are no maintained seed files or seed command. Test fixtures use the existing
isolated test setup rather than a seed directory.

## Browser

The public application has three pages: `index.html` (landing/authentication),
`dashboard.html` (campaigns) and `game.html` (tabletop).

| Path | Contents |
| --- | --- |
| `public/css/` | Theme tokens, page styles and shared character/inventory/spell styles |
| `public/js/pages/` | Landing, dashboard and game-shell entry points |
| `public/js/game/` | Scene, actors, combat/chat/dice, alignment and the dice renderer adapter |
| `public/js/sheets/` | Character editing/creation, item and spell forms |
| `public/js/ui/` | Image picking/framing and closed-campaign notices |
| `public/js/shared/` | Common helpers and the early theme script |
| `public/assets/` | Referenced artwork |
| `public/vendor/dice/` | Vendored dice renderer, textures and upstream license |

Most browser files are classic scripts, exposing `window.VTT*` interfaces.
The dice adapter is an ES module with an absolute vendor import and asset path.
HTML preserves script order and module/defer attributes. The theme script runs
before paint. Page CSS is external but retains its original cascade position;
shared styles are not reordered or deduplicated merely for neatness.

`sheet.js` edits an existing character; `actorsheet.js` creates one. Similarly,
`imageframe.js` renders stored framing while `frametool.js` supplies the editor.
These pairs are different responsibilities, not obsolete copies.

## Tests and historical material

`tests/suites.js` explicitly registers 31 unit, 30 integration and 9 security
suites. `run-tests.js` remains at the root; `scripts/test-local.js` supplies the
isolated environment. Filesystem reads use `tests/helpers/paths.js`.

`tests/fixtures/pages/` preserves the scene, actor, combat and alignment DOM
fixtures used by JSDOM and the game-page ID contract. These are non-served test
documents, not alternate application entry points. The retired auth console has
no fixture consumers. The dice CSP regression requests the real `game.html`.

`tests/integration/test-media-integration.js` remains a separately selected,
unregistered diagnostic; it is not part of the 70-suite run. Its loose media
response checks still require review before registration.

Current guides live directly in `docs/`; historical audit evidence lives in
`docs/history/`. Local source snapshots and database-repair evidence belong in a
private archive outside the checkout, not alongside current source. Preserve
unique untracked material before removing its working copy.

## Remaining boundaries to improve

Scene and actor routers still combine several responsibilities, and some routers
and socket handlers import helpers from other routers. Future extraction should
move shared policy/queries behind clear services while preserving transaction
and disclosure contracts. Folder moves alone would not resolve those couplings.

Maintenance scheduling and an inert application factory should be coordinated
with the [deployment work](deployment.md), not changed independently in parallel.
Do not consolidate similar client API helpers without preserving their different
closed-campaign handling and error behavior.

Legacy image references, historical dice formats, unknown character/spell fields
and the existing upload-mode switch still support data or behavior. Their removal
requires a migration/usage decision, not a filename cleanup. Complete upstream
dice assets and their license remain intact.
