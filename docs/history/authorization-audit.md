> Historical record of the authorization audit and its original findings.
> Later sections record fixes and verification. This is not a current task list.
> See [current test guidance](../testing.md) and [deployment limitations](../deployment.md).

# Bounded audit pass — snapshot after PR #10

## Scope and evidence

Reviewed the supplied tracked snapshot, focusing on authentication/session configuration, campaign permission transitions, socket room admission and broadcast routing, route guard coverage, upload/media boundaries, and test failure reporting. This is a targeted source review, not an exhaustive line-by-line or production audit. Prior passing tests are user-reported evidence; they were not all rerun here.

## Final authorization batch

1. **Campaign owner edits/deletion/unban use stale authorization.** `src/routes/campaigns.js`: PATCH `/:id`, DELETE `/:id`, POST `/:id/members/:userId/unban` act after middleware without a current-owner check protected against transfer. The controlled test uses actual middleware/handlers and changes ownership before handler entry. Normal controls pass; stale requests still change state. Local result: 11 passed, 7 failed. Scope of fix: these campaign administration routes, including resolving visibility/password updates against current campaign state.
2. **Pending room admission can undo eviction.** `src/socket.js`: campaign join and lobby subscribe can use an authorization result captured before eviction, then enter rooms afterward. Actual handlers with a simulated adapter/database reproduce both cases. Local result: 2 passed, 2 failed. Scope of fix: coordinate in-flight admission with eviction and validate the final room state. Cross-process invalidation is not established by these tests.
3. **Closing a campaign does not revoke existing game subscriptions.** PATCH `is_open:false` broadcasts lobby state but leaves game rooms intact; broadcasts to an active scene can still target those rooms. Source finding; a new HTTP/socket test checks actual passive token/chat delivery. This test has been syntax checked but requires the user's isolated server. Scope of fix if reproduced: remove non-owner game subscriptions while keeping appropriate lobby access, and cover overlapping room admission.

## Other observations and explicit limits

- Several other game routes authorize through middleware before asynchronous work. Their complete set of in-flight permission transitions has not been proven atomic. The narrow campaign fixes must not be described as solving all application authorization races.
- `/api/auth/change-password` has no dedicated rate limiter in the reviewed route mounts; authenticated password-hashing load needs a separate bound before an exposed production deployment. Existing authentication limits are process-local.
- No `trust proxy` configuration was found. Secure production cookies and client-IP rate limiting must be checked against the actual TLS/proxy topology. Do not blindly trust all proxies.
- Immediate socket eviction/revocation uses local process socket state. Multi-server deployment needs a separate propagation design and verification.
- Media URLs are short-lived bearer capabilities; source explicitly permits visibility changes to take effect only after token expiry. This is not immediate revocation. Media-token minting checks campaign membership but does not apply the campaign open gate; confirm whether closing the table is intended to block new media-token issuance too.
- Some standalone adversarial scripts exit zero with findings. The central runner checks printed failure counts as well as exit codes; use the central security suite for final closeout.
- Live R2 behavior, SMTP delivery, TLS/cookie behavior in production, proxy topology, dependency vulnerability advisories, realistic load, multi-process behavior, and backup restoration were not validated in this pass.

## Stopping point

Run these three probes in one batch. Consolidate fixes for the reproduced findings in this final authorization batch, rerun targeted checks, then run the existing unit/database/security suites once and perform a short browser smoke check. Close the bounded pass with remaining limitations recorded; do not call the application fully audited or certified.

## Consolidated patch status

The user reproduced all three groups: owner boundaries 11 passed/7 failed, pending admission 2 passed/2 failed, and closed broadcasts 3 passed/4 failed.

The consolidated patch:
- Locks the campaign and rechecks current ownership for edit/unban; resolves edit visibility and password rules against the locked current row.
- Makes deletion conditional on current ownership and live state in the same SQL update.
- Invalidates pending admission using per-socket generations during eviction, deletion, and closure. These generations are process-local. An unrelated concurrent admission on the same socket may need a retry.
- Removes non-owner game subscriptions on close, retaining lobby subscriptions. A later explicit rejoin is required after reopening. Transferring a closed campaign also removes the former owner's game subscription.
- Registers the new regressions in the test runner.

Local controlled checks after the patch: owner boundaries 18 passed; admission/eviction/deletion/closure 7 passed. Existing permission races 24 passed and ownership checks 38 passed. Live closed-broadcast and complete regression results remain pending on the user's isolated environment. This report is not a production-readiness certificate.

## Final automated verification

The consolidated patch passed the full isolated regression run:
- Unit: 30 suites, 1,973 assertions.
- Database/integration: 30 suites, 1,314 assertions.
- Security: 9 suites, 485 assertions.
- Total: 69 suites, 3,772 assertions, zero failures.

These results supersede the pending automated-verification status above.
Production, live R2, multi-server, load, and backup-restoration limitations remain.
