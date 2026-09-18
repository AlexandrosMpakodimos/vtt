# Permission, transaction, and socket invariants

These contracts describe the audited paths in the current source and must
survive the bounded refactor. They are not a claim that every asynchronous
authorization race in every route has been proven atomic.

## Campaign transitions

Middleware can reject an unauthorized request early, but its campaign/member
snapshot is not sufficient authority for a later protected mutation. Preserve
the fresh checks and atomic boundaries below in the operation that writes.

| Operation | Current atomic boundary | Important result/effect contract |
| --- | --- | --- |
| Create | Serializable live-ownership count, campaign insert, owner-membership insert | Ownership cap; no partial creation |
| Join | Serializable membership reread, capacity count and membership write on each attempt | Banned is refused; already-active succeeds before capacity rejection; recognized color collision can drop color |
| Restore | Serializable transaction; lock campaign, check owner/deleted state/recovery window, count live ownership, restore | Same ownership cap as create; 30-day recovery window |
| Transfer | Serializable transaction; campaign lock, current-owner check, recipient-membership lock/check, recipient ownership count, update | Recipient active; owner membership remains active; closed transfer evicts non-owner game access after commit |
| Leave | Campaign lock before caller-membership lock and update | Current owner cannot leave; successful commit precedes eviction |
| Kick / ban | Campaign lock, fresh caller authority, target-membership lock/update | Former-owner moderation refused; successful commit precedes eviction |
| PATCH | Campaign lock and fresh owner check; resolve visibility/password against that row | Closing evicts non-owner game sockets, then sends lobby state |
| DELETE | One update conditional on campaign ID, current owner, and live state | Zero changed rows returns refusal and emits no eviction |
| Unban | Campaign lock and fresh owner check before membership lookup/update | Banned becomes left, not active; target must rejoin normally |

Join's campaign/password precheck is outside its membership retry transaction.
Do not describe that transaction as refreshing every campaign policy field.
Remaining authorization timing questions are recorded in the deployment backlog.

Preserve campaign-before-membership lock ordering shared by transfer and
membership removal. Helpers used inside a transaction must use its `trx` for
protected queries; do not silently start a separate transaction.

Creation, join, and ownership operations allow six attempts with bounded
exponential backoff/jitter for the existing retryable failures. Exhaustion keeps
HTTP 409, `Retry-After: 1`, `retryable: true`, and the operation-specific code:
`campaign_create_busy`, `campaign_join_busy`, or `campaign_ownership_busy`.
Join's additional uniqueness recovery is limited to
`campaign_members_pkey` and `campaign_members_campaign_color_unique` under its
existing conditions. Do not turn all database errors into retryable conflicts.
Other helpers such as `atomicCap.js` and storage accounting have their own
policies; this pass does not normalize them.

PostgreSQL requires retries of the complete transaction after serialization
failure and cautions against indiscriminate uniqueness retries. Its lock-order
guidance supports the existing coordination. See [serialization failures](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
Knex's [transaction contract](https://knexjs.org/guide/transactions.html) governs
connection ownership and rollback. The exact statuses and retry bounds above
are application contracts, not requirements imposed by those libraries.

## Responses and effects

- Preserve existing status codes, error text/codes, response keys, event names,
  payloads, recipient filtering, and ordering; do not normalize them in a refactor.
- Public user/campaign responses exclude password hashes. Private campaigns are
  intentionally searchable/listed and password-gated; client settings support is
  intentional.
- Campaign mutation success effects follow successful writes/commits. Retryable
  callbacks must not emit events or revoke sockets. Refused/rolled-back writes
  must not emit success effects. Post-commit delivery is not a durable outbox.
- Preserve game-resource disclosure distinctions: hidden tokens are withheld,
  NPC/unknown-item fields are projected, and whispers reach their named users
  plus sender, not automatically the GM. Fog is a presentation feature.

## Sessions and account recovery: leave implementation unchanged

Authentication and campaign membership are separate checks. The handshake user
is a snapshot; it does not establish continuing session validity.

`socketSessions.attach()` registers the SID synchronously before asynchronous
store validation. Store validity is checked at connection and for incoming
packets. Revocation disconnects exact SIDs locally. Password change keeps the
current session; password reset revokes all affected sessions. Logout captures
the old SID before Passport regeneration and preserves its current callback
ordering; do not rewrite it into the campaign transaction pattern.

Login locks the current user, rechecks the verified account state, and coordinates
`req.login()` persistence through response `finish`, with `close`/error cleanup.
This deliberate response-inside-coordination exception must survive. An HTTP 200
alone does not establish that a usable authenticated session survived a race.
Express-session documents [automatic saving at response end](https://expressjs.com/en/resources/middleware/session/#sessionsavecallback).

Password reset/change and email-change recovery coordinate on the user row,
recheck current state under lock, and invalidate relevant tokens. Preserve
post-commit password-session disconnection and email sending after issuance
transactions. Do not shorten lock lifetimes or move persistence for stylistic
consistency.

## Room lifecycle

- `campaign:<id>` is the game room; `lobby:<id>` is a dashboard subscription.
  Presence counts distinct users in the game room, not sockets or lobby viewers.
- Leave/kick/ban removes the affected user's game and lobby subscriptions across
  tabs. Deletion removes both room types. Closure removes non-owner game access
  but retains lobby subscriptions. Closed transfer retains current-owner access.
- Reopening does not restore subscriptions automatically; players re-enter.
- Each admission captures a per-socket generation. Eviction invalidates pending
  work even for sockets not yet in a room. Check before and after asynchronous
  join; undo stale joins and partially completed lobby subscription.
- Preserve conservative generation invalidation, even when an unrelated pending
  admission must retry. Optimizing its granularity is separate work.
- Capture rooms during `disconnecting`, then update presence after removal in
  `disconnect`. Socket.IO documents this [room lifecycle](https://socket.io/docs/v4/rooms/).
- Immediate revocation, generations, and socket maps are process-local. Cached
  content cannot be recalled; distributed coordination is not established.

## Regression map

Names below are existing root-level suites; use the isolated wrapper for
database/server-backed suites as described in [testing](testing.md).

| Contract | Existing representative coverage |
| --- | --- |
| Mutation commit timing, effects, public response shapes | `test-campaign-mutation-contracts.js` (controlled operation/HTTP-handler imports) |
| Creation/join retry behavior | `test-campaign-create-retry.js`, `test-campaign-join-retry.js`, `break-campaigns.js` |
| Shared ownership cap | `test-campaign-ownership.js`, `test-campaign-ownership-races.js` |
| Transfer versus leave/moderation | `test-campaign-permission-races.js`, `test-campaign-permission-races-db.js` |
| PATCH/DELETE/unban owner boundaries | `test-final-owner-boundaries.js` |
| Admission, access transitions, closure | `test-final-room-admission.js`, `test-campaign-access-transitions.js`, `test-final-closed-broadcasts.js`, `test-lobby.js` |
| Login persistence/revocation | `test-login-session-races.js`, `test-login-session-races-db.js`, `test-auth-session-revocation.js`, `test-session-invalidation.js`, `test-socket-sessions.js` |
| Account recovery | `test-account-recovery.js`, `test-email-recovery-transactions.js` |
| Event consistency | `test-events.js` plus live HTTP/socket suites |

Controlled tests and PostgreSQL integration tests are complementary: fake locks
do not prove database isolation, and concurrent request launch order does not
force a particular database schedule. Preserve both forms of coverage.
