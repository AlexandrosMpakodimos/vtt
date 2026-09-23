# Application lifecycle

Configuration is validated before application imports and resource creation.
NODE_ENV may be unset (development default), development, test or production;
explicit blank/unknown values fail. Production requires BASE_URL to be an
absolute HTTPS URL with no URL credentials. The existing production database
URL/TLS policy is unchanged.
SESSION_SECRET must contain at least 32 characters after trimming and must not
be the example value; PORT, if set, must be an integer from 1 through 65535.
Storage and media remain optional. All five storage settings absent/empty keeps
storage disabled. Setting any of R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE_URL,
R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY requires the complete nonblank group;
the account/bucket must have supported host/bucket syntax and the public base
must be HTTPS without URL credentials. No storage/provider requests are made.
Whitespace-only supplied settings fail validation. Captured numeric
budget settings and media settings that can throw during import are checked
without printing their values. Email transport is unchanged.

Startup performs SELECT-only probes through both pools, checks the exact local
migration filename history and unlocked migration metadata, and selects the
required application columns with LIMIT 0. Production also probes the public
session columns. Existing production pool hooks enforce the public search path.
These checks detect missing history/tables/columns and read-permission failures;
they are not a comprehensive audit of all types, constraints, privileges or
schema drift. They do not create migration metadata, run migrations, initialize
the storage budget, or call R2 or mail. Development retains lazy session-table
creation through the session store on business requests; startup does not invoke
that path. Test database guards and the dedicated migration command are unchanged.

Checks and setup have a 20-second budget, reserving up to 10 seconds for partial
failure cleanup. An outer 30-second deadline forces exit if cleanup hangs.
The listener opens only after checks succeed. No listener is exposed during
startup. Existing immediate maintenance and hourly/five-minute intervals begin
only on successful startup. There is no overlap suppression or cadence change.

GET/HEAD and other methods on /healthz bypass sessions and all business handlers.
The endpoint sends Cache-Control: no-store and only {"status":"ready"} (200)
or {"status":"stopping"} (503 while draining). This is process lifecycle state,
not a fresh database probe or continuous database-connectivity guarantee.
Cookie-bearing health requests never invoke session SQL.

SIGTERM and SIGINT share one idempotent shutdown promise. Shutdown immediately
rejects new HTTP business requests, Engine.IO admissions and socket packets,
stops maintenance timers, and closes session pruning. Already admitted work is
tracked through returned promises, session query promises, callback middleware,
packet middleware and login/logout/recovery completion. Response finish/close is not used as
proof that an asynchronous handler has completed. Unawaited exported socket
broadcasts and initial socket session checks are tracked too.

Shutdown has explicit ordered phases: drain accepted work; close transports;
drain tracked completion/disconnect work; close both database pools. Socket.IO
owns closing the HTTP server once attached. Partial construction without
Socket.IO uses the raw HTTP closer instead, never both during normal shutdown.
Transport holds end on finish, close or next; aborted static/streaming responses
do not become stuck callback work. Returned handler promises remain independently
tracked after disconnection. Session/Passport callback middleware has a separate
completion hold; login and logout return their entire callback-chain promise.
Recovery still responds first but retains its later work in the handler promise.

The total shutdown deadline remains 25 seconds. Absolute cutoffs reserve time:
accepted drain ends by 20 seconds, transport closure by 23, completion drain by
24, and pool closure by 25. On a cutoff the process logs failure, performs
best-effort forced cleanup and exits nonzero; it does not claim successful drain.
On partial startup, accepted-work drain is skipped after 1 ms, transport closure
is limited to 1 second and completion drain to 1.5 seconds before closing pools.
The outer 30-second startup deadline still bounds all partial-startup cleanup. Expiry or
close errors exit nonzero. Forced exit can interrupt work and leave a write's
outcome unknown. The lifecycle never replays a write, reconnects and retries a
business handler, or retries a cleanup job on connection loss. Existing
serialization-conflict retries and later maintenance ticks remain unchanged.

Lifecycle logs use fixed diagnostic codes and recognized configuration key names,
never driver messages, URLs or configuration values. A session-pool error triggers the same shutdown path.
Existing domain-level logging inside unchanged services is outside this patch.

Completion instrumentation uses the locked Express 4 layer stack, Socket.IO 4
packet middleware dispatch and connect-pg-simple 10 _asyncQuery. These seams
are covered with real-library tests; review them when upgrading dependencies.
Callback business middleware must use lifecycle.middleware(...); other callbacks
that detach work must return a promise or register it with
app.get('workLifecycle').track(...). Transport events alone cannot reveal detached
application work. An explicitly tracked callback that never completes is treated
as stuck and bounded by the deadline.
