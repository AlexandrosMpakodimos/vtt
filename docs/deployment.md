# Configuration and deployment backlog

This is an inventory and separate backlog, not a deployment procedure or a
claim of production readiness. The repository contains a media proxy Worker in `workers/media-proxy/`, tested locally and never deployed. Public hosting and Gmail API
integration are not implemented. Keep those design proposals separate from completed work.

## Current configuration

Names below are configuration keys, not requests for their values. Keep real
credentials private. Many modules read configuration at import time; a later
refactor must preserve initialization order and isolated-test overrides.
`.env.example` currently lists only `PORT`, `DATABASE_URL`, `SESSION_SECRET`,
and `NODE_ENV`; it is not a complete production template.

| Keys | Current source behavior |
| --- | --- |
| `NODE_ENV`, `PORT` | Environment defaults to development in DB configuration; port defaults to 3000. Test server binds loopback. Production selects secure cookies/CSP behavior but has no Knex production entry yet |
| `DATABASE_URL`, `SESSION_SECRET` | Non-test database/session-pool connection and session signing; supply privately |
| `TEST_DATABASE_URL` | Dedicated local test DB only; see [testing](testing.md) |
| `BASE_URL`, `EXTRA_ALLOWED_ORIGINS` | Email-link base and CSRF origins. Email base defaults to localhost:3000. CSRF also includes local port-3000 origins in current code |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP transport outside tests; port defaults to 587, secure is enabled by the string `true` |
| `MAIL_JSON` | Test/JSON mail behavior; `1` also logs links. Test mode forces JSON transport. Outside tests configured SMTP takes precedence over JSON transport selection |
| `SKIP_HIBP` | `1` skips the external breached-password lookup after the built-in common-password check; supplied by test tooling |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Together configure live storage outside tests; absence leaves it disabled |
| `UPLOAD_MODE` | Defaults to `proxy`; `strict` disables legacy presign issuance. Isolated tests force strict mode |
| `MEDIA_HOST`, `MEDIA_ORIGIN` | Host gate and browser-facing media origin; unset host disables gateway. Default origin is HTTPS on the host; explicit origin is validated as HTTP(S), but its hostname is not checked against `MEDIA_HOST` |
| `MEDIA_TOKEN_SECRET`, `MEDIA_CACHE_BYTES` | Token key falls back to session secret; cache defaults to 64 MiB. Token lifetime is fixed at 300 seconds in source |
| `MEDIA_PROXY_SECRET` | Optional; blank or unset keeps host mode. When set, proxy mode: the media route answers only requests carrying it in exactly one `X-Media-Proxy-Auth` header (duplicates in any capitalisation are refused) and ignores Host; `MEDIA_HOST` must still be set and then names the public media origin. At least 32 characters; must differ from the media token secret and `SESSION_SECRET`. It proves a request came through the proxy and authorises no asset: tokens and asset checks still decide every read. No current deployment path sets it |
| `MAX_CAMPAIGNS_PER_USER`, `MAX_PLAYERS_PER_CAMPAIGN` | Defaults 20 owned live campaigns and 8 active members including GM |
| `R2_MAX_TOTAL_BYTES`, `R2_MAX_CLASS_A`, `R2_MAX_CLASS_B` | Application budget defaults: 8,000,000,000 bytes, 100,000 Class A operations, 2,000,000 Class B operations; not provider allowance guarantees |
| `R2_MAINT_CLASS_A`, `R2_MAINT_CLASS_B` | Maintenance reserves within the operation ceilings; defaults 2,000 and 40,000 |
| `RL_LOGIN_MAX`, `RL_REGISTER_MAX`, `RL_RESEND_MAX`, `RL_FORGOT_MAX`, `RL_RESET_MAX`, `RL_CHANGE_EMAIL_MAX` | Auth limiter maxima; defaults/windows in `src/middleware/rateLimit.js` |
| `RL_CAMPAIGN_JOIN_MAX`, `RL_CAMPAIGN_SEARCH_MAX`, `RL_CAMPAIGN_CREATE_MAX`, `RL_CONTENT_WRITE_MAX` | Campaign/content limiter maxima; isolated wrapper raises these for tests |

Storage budget limits accept non-negative integers and reject invalid values.
Other settings do not all share that validation. The table describes current
behavior rather than introducing a new global configuration contract.

The mailer's no-SMTP fallback is an Ethereal test account outside JSON/test mode;
the sender is currently `VTT <no-reply@vtt.local>`. Neither is a configured public
email delivery setup. Asset upload accounting requires an initialized budget;
the current `budgetActive()` implementation refuses unavailable/uninitialized
accounting with 503 despite older comments suggesting an inactive bypass.

## Media proxy Worker (not deployed)

`workers/media-proxy/` is a separate Cloudflare Worker package. It sits in front of
the app's `/media/:id` route so that media is served from its own hostname, and it
only translates requests and answers. The app still verifies the signed token,
checks the asset row, meters storage reads and caches. It never authorizes an
asset itself. Nothing here is a deployment procedure.

| Setting | Where | Meaning |
| --- | --- | --- |
| `UPSTREAM_ORIGIN` | Worker variable | HTTPS origin of the app. No credentials, path, port, IP literal or `localhost` |
| `MEDIA_PROXY_SECRET` | Worker secret and app environment | The same value on both sides; at least 32 characters; different from the media token secret and `SESSION_SECRET` |
| `UPSTREAM_HEADER_TIMEOUT_MS`, `UPSTREAM_TOTAL_TIMEOUT_MS`, `MAX_RESPONSE_BYTES` | Worker variables, optional | Bounded defaults 15 s, 45 s and 14 MiB |
| `MEDIA_HOST` | App environment | The Worker's public hostname, so minted URLs and the CSP point at it |

Keep Workers Logs, tracing, Logpush and Tail Workers off: the request URL carries a
live token. The Worker itself writes no logs. Real secrets never belong in
`wrangler.jsonc` or in the repository; `.dev.vars` is ignored.

## Operational scripts

| Script | Current behavior to understand before use |
| --- | --- |
| `scripts/storage-budget.js status` | Read ledger/cleanup status |
| `scripts/storage-budget.js report` | Reconciliation with `apply: false`; still contacts storage and can consume metered operations |
| `scripts/storage-budget.js init` | Reconciliation with `apply: true`; writes accounting state, so requires deliberate operator use |
| `scripts/clean-bucket.js` | Reports candidates by default; `--delete` enables deletion. Review configuration, inventory, and legacy-object safeguards first |
| `scripts/fill-campaign.js` | Development fixture utility that writes users/memberships; not an isolated regression command |

Use these scripts deliberately: normal app startup also schedules maintenance.

## Separate deployment work

| Item | Required decision or focused verification |
| --- | --- |
| Production startup | Add explicit production Knex configuration. Currently `NODE_ENV=production` fails the DB loader because only development/test entries exist. Verify migrations and startup on a disposable target |
| Hosting topology | Choose provider, TLS/proxy path, one process versus multiple workers, expected tables/sockets, and available memory/DB connections |
| TLS, cookies, origins, limits | Configure trusted proxies for the actual network path, verify secure login cookies and correct client-IP limiting, and validate application/media origins. Do not trust every proxy or disable CSRF |
| Email | Configure a valid sender and transport; verify signup/reset/change-email delivery with designated test accounts. Token fixtures do not prove SMTP delivery |
| R2/media | Verify upload, confirm, delivery, deletion, strict-mode cutover, budget initialization, cleanup, and intended public-access settings with synthetic objects |
| Password-change abuse | Add a dedicated bound for authenticated password-change hashing; current route mounts have no dedicated limiter |
| Process lifecycle | Define readiness and bounded shutdown of HTTP, sockets, cleanup timers, Knex and the separate session pool; current server has no explicit shutdown coordinator |
| Recovery/release | Verify backup restoration, migration/release rollback, and minimum error/cleanup monitoring |
| Runtime/dependencies | Review locked dependency advisories and target-runtime compatibility; use justified fixes, not a blanket upgrade bundled with refactoring |
| Media proxy Worker | Local tests are not deployment evidence. Unresolved until a deployment: Render forwarding `X-Media-Proxy-Auth` intact and its answer while asleep; real image bandwidth against the host's cap; Cloudflare log, tracing, Logpush and preview-URL settings; whether streamed responses keep `Content-Length` at the edge; the hostname Cloudflare assigns |
| Media policy | Decide whether closure denies new player media grants. Current media visibility checks active membership but not `is_open`; previously issued bearer grants can remain usable until expiry |
| Remaining authorization timing | Separately triage pre-transaction campaign policy in join and campaign authority loaded before token batch writes, plus the already recorded broader game-route timing limits. These timing questions remain separate behavioral work |
| Unregistered media suite | Review `tests/integration/test-media-integration.js` prerequisites and decide its status without silently changing the recorded regression baseline |

Immediate session revocation, room admission generations, user socket maps,
presence inspection, and rate-limit state are local to one process. A shared
Socket.IO adapter alone does not establish cross-process revocation/admission
safety. Start with one process unless requirements justify separate distributed
coordination work; this is a recommendation, not an already selected topology.

## Official guidance

- [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/) describes
  how trusted forwarded headers affect request interpretation.
- [Express-session](https://expressjs.com/en/resources/middleware/session/)
  documents secure cookies and response-end persistence.
- [Express shutdown/readiness](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown/)
  describes draining requests and releasing resources at shutdown.
- [Socket.IO multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)
  describes message forwarding and session affinity with polling;
  [rooms](https://socket.io/docs/v4/rooms/) documents local adapter maps.

These sources explain framework behavior. The specific backlog and bounded
scope are application recommendations, not mandatory directory patterns.
