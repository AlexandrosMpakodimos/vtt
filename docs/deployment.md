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

## Database configuration and migration ownership (eacfc6e follow-up)

This patch supports a deliberately narrow production profile. These restrictions
are application decisions, not universal PostgreSQL requirements. It does not
establish deployment readiness, zero spend, or provider identity.

### Connections and schema

Production Knex and the session pool share explicit PostgreSQL fields derived
from DATABASE_URL. Knex permits 0–5 connections, sessions 0–2; migration Knex
permits 0–2. All evict idle clients after 30 seconds and establish connections
within 10 seconds. Knex acquisition is bounded at 15 seconds and Tarn creation
at 10 seconds. pg-pool uses its 10-second connectionTimeoutMillis for both
connection establishment and waiting for a pool slot. These are not SQL
execution timeouts or whole-process deadlines. Deployment overlap can double
the application connection budget.

TLS always uses rejectUnauthorized=true, normal Node trust roots and hostname
verification. Neither client receives a connectionString after validation.
Development connection handling and the isolated local test branch are unchanged.

Application queries are still generally unqualified. Therefore the application
and migration roles must each have a database-specific default search_path of
exactly public. Establish that through the separately authorized operator role
configuration; this application neither changes roles nor sends SET search_path
through the Neon transaction pooler. The effective setting must remain stable
across backends for the same role/database. The application role must not create
shadow schemas or change its search path during normal work.

Every new production Knex connection is withheld by afterCreate until the
schema assertion succeeds. Every session connection is withheld by pg-pool's
awaited onConnect hook. This is not an async event listener. The assertion checks
current_schema(), current_schemas(false), and current_setting('search_path');
it accepts only public, [public], and public (optionally quoted), respectively.
Its query has a 10-second timeout. A failed Knex assertion closes the raw client
before rejecting; the locked pg-pool closes rejected onConnect clients itself.

Production sessions explicitly target public.session. Migration history and its
lock explicitly target public.knex_migrations and public.knex_migrations_lock.
Historical migrations continue to use their existing unqualified names under the
asserted public search path. The migrator additionally rejects shadow history or
session relations. No historical table/history movement is performed.

### Exact supported production inputs

- NODE_ENV must be production. Application configuration reads DATABASE_URL;
  the migration runner reads only DIRECT_DATABASE_URL, with no fallback.
- URLs must use postgres: or postgresql:, have a nonempty user/password/database,
  a Neon DNS hostname, and an optional port 1–65535 (default 5432). Percent-encode
  credentials. Malformed escapes, controls, whitespace, fragments, multi-component
  database paths, sockets and multi-host forms are refused.
- The complete query-option allowlist is one optional sslmode=require or
  sslmode=verify-full. No parameter also means verified TLS. require is deliberately
  strengthened to full verification. Duplicates and every other option are rejected.
- In particular: ssl, sslcert, sslkey, sslrootcert, uselibpqcompat, sslnegotiation,
  channel_binding (all values), options, search_path, host, hostaddr, user, password,
  dbname, connect_timeout and pool settings are unsupported URL options.
- No defined environment key matching ^PG[A-Z0-9_]*$ is allowed, even if empty.
  This includes PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGOPTIONS,
  PGAPPNAME, PGSSLMODE and PGCONNECT_TIMEOUT.
- NODE_TLS_REJECT_UNAUTHORIZED must be absent or exactly 1. Defined
  NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR are rejected, including empty
  values. Do not use NODE_OPTIONS to alter TLS or load configuration-changing code.
- The pooled hostname must have the Neon -pooler endpoint suffix; the direct
  hostname must not. These are routing-shape checks, never identity proof.

pg 8.21.0 can prefer SCRAM channel binding with enableChannelBinding, but can
fall back to ordinary SCRAM. Consequently channel_binding=require is rejected
rather than silently weakened. If mandatory channel binding is required, stop
and review the supported profile separately; do not simply remove the requirement.

### Operator gate and release sequence

Before any production migration, independently verify in the provider's trusted
control plane that both endpoints belong to the intended project, branch and
database. Hostname syntax alone cannot prove that. From an independently trusted
operator connection, verify current_database(), current_user, current_schema(),
current_schemas(false) and current_setting('search_path') through each endpoint.
Compare existing migration history with the approved release. Database names
alone do not prove branch/project identity. Verify both roles if they differ.
No such provider/identity verification was performed while preparing this patch.

Then, from a reviewed release checkout and separately authorized migration
environment, set NODE_ENV=production and supply DIRECT_DATABASE_URL privately;
run npm run migrate:production. Do not put URLs on the command line or in logs.
Application/Worker/mail secrets are not required by this command.

The runner calls migrate.latest once with normal Knex locking, list validation
and transactions, then destroys its own pool. It never auto-unlocks, retries,
rolls back, initializes accounting or imports the server. Lock failure stops the
release pending operator review. Generic npm run migrate remains the local
development/test route; only migrate:production is supported for production.
Never attach migrations to build or application start. Render Free's lack of a
pre-deploy migration hook and release overlap remain separate deployment gates.

Only after the migration succeeds should the new production application run.
Production session auto-creation is disabled; there is no readiness coordinator
in this patch. Existing development/test auto-creation is retained.

The additive session migration creates sid varchar, sess json and expire
timestamp(6) without time zone, all non-null, with a nondeferrable sid primary
key and expiry B-tree index. It accepts existing unbounded varchar/text sid and
json/jsonb sess with the same timestamp contract. It refuses extra columns,
incompatible constraints, RLS, user triggers, partitions/inheritance and index-name
collisions. Equivalent expiry indexes are retained. Compatible rows are neither
updated nor deleted. Adoption uses an exclusive table lock in the migration
transaction; plan the separately approved maintenance window accordingly.
Its down refuses to delete a potentially adopted table; use reviewed forward
repair, not automatic rollback.

Diagnostics in this patch's configuration, Knex logger, migration runner and
session-store logger use fixed safe categories. No raw connection/driver error,
URL, SQL, binding, stack or nested cause is forwarded. Existing unrelated runtime
logs and idle-pool failure handling are not redesigned here.

Worker/media, startup/readiness, runtime outage tracking, shutdown, scheduling,
proxy trust, mail transport and root advisory remediation remain separate work.
