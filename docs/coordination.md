# Server coordination

Status: review candidate. Do not deploy until the direct PostgreSQL + Redis test,
application database/security regressions, and owner review have passed.

## Configuration

Production startup requires `COORDINATION_URL`. Use the internal connection URL
of the dedicated Render Key Value instance in the same workspace and region as
the web service. Keep external access disabled. Set `COORDINATION_PREFIX` only
when deliberately isolating a separate application; the default is `vtt:coord:v1`.
All instances of this application must use the same prefix and PostgreSQL database.
Do not share this Key Value instance with unrelated applications or untrusted clients.
Never commit a connection URL or print it in diagnostics.

Render settings for the planned zero-cost deployment: Free (25 MB / 50 backend
connections), noeviction, persistence Off. The application uses two Redis client
connections per process and caps registry participants at eight. These bounds are
not a load-capacity claim. A sustained load test remains required.

Development/test without a URL retains the original single-process socket path.
Tests with a URL reject non-loopback Redis hosts. Production has no local-only
fallback. Existing database guards, migrations, Worker package and media storage
behavior are unchanged.

Connection setup (TCP, TLS and `AUTH`) is bounded at 10 seconds per process
start, separately from the 2.5-second bound on every command, heartbeat and
registry refresh. The first IP.GR deployment reaches Render's external TLS
endpoint (IP allowlist) rather than the internal URL above. From that host,
`AUTH` took 3.2–4.2 seconds per new connection, while TCP and TLS took under
40 ms and commands on an open connection about 9 ms. A single shared bound made
startup fail intermittently. Because running processes never reconnect, the
longer bound applies only at startup; failure detection in use is unchanged.
Both coordination and the HTTP rate-limit backend connect sequentially inside the
existing 20-second startup check deadline.

## Transport and authorization

The dedicated Pub/Sub channel transports room, scene, owner, player and explicit
recipient events. It is not a durable event log and does not implement an official
Socket.IO adapter. Delivery selects local sockets on every receiving server.
Each recipient's current session, campaign and membership are checked against
PostgreSQL. Shared row locks cover the final synchronous socket enqueue; the
existing campaign mutations lock the campaign row exclusively and session
revocation deletes the session row. Thus an ordinary concurrent revocation and
authorization check are ordered at the database, rather than trusting arrival
order of Redis control messages. Already-enqueued network bytes cannot be recalled.

Ownership and active-scene filtering are evaluated again at delivery. Whisper
recipient sets are explicit and never implicitly include the owner. SQL or lock
errors stop coordination rather than allowing a partially checked delivery.
Lock waits are capped at 1.5 seconds; statements at 2.5 seconds. Contention can
therefore disconnect a server and require clients to reload.

Eviction/revocation controls proactively update each server's local rooms and
invalidate pending joins. Session IDs travel as SHA-256 digests in controls.
PostgreSQL remains authoritative even if a control has not arrived yet.

Presence is an eventual distinct-user union of per-process room snapshots.
Redis server time expires missing processes after eight seconds; a two-second
heartbeat refreshes the registry. No PostgreSQL heartbeat runs while membership
is unchanged. Presence can briefly overcount after process failure; it is never
used for authorization. Membership changes during a broadcast can also leave a
presence snapshot stale until the next refresh.

All four browser socket clients use WebSocket-only connections. Coordinated
servers reject HTTP polling, avoiding its cross-instance sticky-session
requirement. Networks that block WebSockets will not have a polling fallback.

## Failure and recovery

There is no automatic Redis reconnection or offline command replay in a running
process. Subscription/command failure, self-heartbeat timeout, namespace epoch
reset, queue overflow, or publication failure closes browser transports and
initiates bounded nonzero process shutdown. `/healthz` becomes unavailable through
the existing lifecycle. The hosting platform must restart the process; the browser
then reconnects, reauthorizes, rejoins and reloads current application snapshots.
This restart behavior still needs a live Render rehearsal.

Heartbeat checks exercise the actual subscription path. A network failure that
has not yet been detected can lose transient events; reconnect recovery reloads
persisted state, not transient pings. During a failure window the delivery-time
PostgreSQL checks remain necessary. Pub/Sub provides neither durable replay nor
exactly-once delivery across crashes. A database commit followed by publication
failure may have succeeded even if the caller receives an error. Clients must
refresh state before retrying a mutation blindly.

Redis memory is bounded by short-lived registry data (64 KiB per process), with
at most eight processes, rather than stored event history. Individual messages
are capped at 1 MiB; incoming and publishing backlogs at 2 MiB; incoming message
count at 128; queued presence refreshes at 64. Hitting a limit fails closed.
`noeviction` makes memory pressure a visible write failure; it does not guarantee
availability or durability. Free Key Value resets lose its contents.

Shutdown stops coordination and waits for its queued delivery and heartbeat work
before the database pools close. Broadcasts during shutdown can fail and require
a client refresh. Local mode retains the previous delivery behavior.

## Validation

`npm test` includes mocked transport/configuration/authorization tests and tests
using two real loopback WebSocket servers with mocked SQL and Redis boundaries.
These are not PostgreSQL lock or Redis Lua integration evidence.

The direct integration suite starts two separate Node processes, actual Socket.IO
handlers and Redis clients. It creates a unique `coord_test_*` schema in the
unchanged guarded `vtt_test` database using `vtt_test_runner`. It uses synthetic
sessions and a synthetic handshake; it does not exercise Passport's real HTTP
login flow or start `src/server.js`. Only its own schema and three prefixed Redis
keys are removed in independent bounded teardown. It never flushes a database,
changes Redis configuration, or touches the storage ledger.

With local PostgreSQL test configuration already set up and a local Redis/Valkey
server available, run from the repository root:

```sh
NODE_ENV=test SKIP_HIBP=1 TEST_COORDINATION_URL=redis://127.0.0.1:6379/0 \
  node tests/integration/test-coordination-processes.js
```

This suite is direct-only, not included in the shared DB runner. A missing local
configuration fails rather than skips. Never substitute the Render URL. After it
passes, run the existing guarded application DB/security suites and Worker
integration. Those existing suites normally run with COORDINATION_URL unset.

Still required: real Redis/Lua and PostgreSQL test execution, live Render restart
and overlapping-deploy rehearsal, behavior at actual Redis memory exhaustion,
TLS/private-network configuration, and representative load testing. Process-local
rate limiters and media caches have not been made shared by this patch. Production
email delivery and other deployment prerequisites remain separate work.

Sources consulted 2026-09-23:
- https://render.com/docs/key-value
- https://render.com/docs/free
- https://socket.io/docs/v4/using-multiple-nodes/
- https://socket.io/docs/v4/redis-streams-adapter/
- https://github.com/redis/node-redis

The official Streams adapter was considered but not used: retaining/replaying
packets alone does not reauthorize private delivery. This implementation instead
uses ephemeral Pub/Sub plus delivery-time authorization and restart/resnapshot.
