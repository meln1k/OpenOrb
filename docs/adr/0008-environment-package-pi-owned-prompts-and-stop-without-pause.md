# Environment providers in their own package; Pi owns prompts; Stop aborts

**Status:** Accepted; refines ADRs 0002, 0005, 0006, and 0007

Agent Environment Providers live in `@openorb/environments` behind one `EnvironmentProvider`
interface. The Session Durable Object opens whichever provider its placement names, from a registry
the gateway wires in `app/cells/session/environments.ts`. It relays traffic addressed to the
environment without knowing its kind: HTTP requests, hibernatable WebSockets, and control-plane
notices such as the runner's Environment Link and the Runners object's environment updates. Every
placement field other than `provider` is opaque to the Session. A sandbox vendor is therefore one
more implementation and one registry entry, with no change to the Session. Implementations are
bundled into the Worker and chosen by name at runtime, not imported dynamically, because the gateway
ships as a single Worker bundle. Providers declare only what the Session acts on: how credentials
reach the guest, and whether it runs Git. The persistence and hibernatable-link capabilities of ADRs
0006 and 0007 are dropped, since nothing consulted them.

Pi owns every prompt from admission: the Session submits it to Pi at once, and Pi's durable queue,
request-ID deduplication, and Abort apply to it. A prompt to a stopped Session also queues a start
of its environment. Runs wait only for queued environment operations (setup, start, and stop) to
settle: Pi builds the guest `ExecutionEnv` for each model request and tool call through the Harness
`env` option, which resolves once no operation is queued. Setup is never a precondition. A run
proceeds after a failed setup, so the agent can repair a running environment, and its guest tools
fail immediately where compute is not running. Pi cannot hold an admitted prompt itself: submitting
input to an idle conversation starts its run in the same commit. This replaces both a readiness gate
that wrapped every `ExecutionEnv` operation and a list of waiting prompts that the Session kept
beside Pi's own queue, which an Abort could miss. As a result, a model-only answer no longer runs
while setup is in progress.

Clone, setup, and resume outcomes are transcript entries rather than a separate live log stream.
Viewers see each command's redacted output, its end kept when long; a failure's entry also carries a
message for the model, which Pi places at the run's next boundary, so the agent learns what to
repair without the Session composing prompts. A command that succeeded costs the model nothing.

Stop Session queues the stop of compute, then aborts agent work and queued prompts. A prompt
admitted after the abort runs after the stop, on compute started again for it. Pi Durable has no
pause: a recoverable pause meant closing and reopening the harness behind a persistent paused state
that every scheduling decision had to respect. The conversation is durable, so the next prompt
continues it. As a result, an unfinished run is not resumed by Wake. A run that an earlier Stop
paused is aborted when its Session next opens.

The guest `ExecutionEnv` is upstream `@earendil-works/pi-env`'s `RemoteExecutionEnv`, unmodified,
replacing ADR 0005's vendored copy, whose Node built-ins and path handling now run in the Worker
runtime. Upstream's `Connection` can still only spawn the daemon as a process, so `@openorb/pi-env`
keeps only the transport: a `LinkConnection` subclass that carries frames over the Environment Link
and pings only while requests are in flight, and the runner's relay.

A runner keeps no journal. Each environment stores only its definition, written once at creation,
beside its Persistent Root Disk, whose initialization is idempotent. A runner restart leaves no VM,
so every environment it restores is stopped. The explicit `restart-environment` recovery mode that
gated a start after an interrupted Stop is gone: guest sync cannot be proved either way, and a start
over the preserved disk is the only recovery it offered. A start after a failed boot or stop first
releases the failed VM.

The runner dials a Session's Environment Link whenever that environment runs, and redials it while
compute keeps running, so the Session never requests one. This removes the attach procedure and its
one-time nonce. The link authenticates with the runner token, which must name the runner of the
Session's placement in its Workspace. The Session addresses control by that placement too: the
Runners object keeps no index of which runner hosts which Session, only, per connected runner, the
Sessions to notify when it becomes unreachable or is revoked. A runner reports one snapshot of its
environments' states, then their changes, with no revisions, Workspace identifiers, or creation
facts the gateway never used.

`@openorb/protocol` holds only what crosses the runner boundary: identities, capacity, environment
payloads and states, and enrollment. The Session view, its events and issues, the Git Snapshot, and
media types belong to the gateway. Values the Session Durable Object produces for browser pages are
plain types it neither re-encodes for Durable Object RPC nor re-validates in the browser. The Git
Snapshot keeps one Effect schema in the gateway, because it is derived from guest output and
persisted.
