# Effect v4 transport and stream refactor proposal

**Status:** Proposed. This document does not override `MVP.md` or `MASTER_PLAN.md` until the
architecture is accepted.

## Decision in one sentence

Adopt an exactly pinned Effect v4 runtime for the runner/gateway transport and orchestration core,
keep the runner's one physically outbound WebSocket, but make the gateway the logical Effect RPC
client and the runner the logical Effect RPC server; express commands as typed RPC effects and
runner/browser feeds as scoped streams.

This is a replacement of the current transport architecture, not a local cleanup of its message
handlers.

## Executive recommendation

Proceed with the refactor as one stop-the-world cutover, starting with the isolated API proof
described below. The target has five defining properties:

1. **Physical topology stays secure.** The runner still initiates the only MVP WebSocket. There is
   no inbound listener on the runner.
2. **Logical RPC roles are inverted.** After authentication, the gateway calls typed procedures
   hosted by the runner. Runner-originated state is returned through gateway-initiated streaming
   procedures. The physical WebSocket initiator does not need to be the RPC client.
3. **One scope owns one lifetime.** A connection attempt owns its socket, status stream, RPC calls,
   heartbeat supervision, and finalizers. Replacing or closing it interrupts all of those resources
   exactly once. Process-owned session jobs are deliberately outside the connection scope.
4. **Durable and live data are not confused.** Pi JSONL remains the only durable conversation
   transcript. Completed conversation events are projected only after their Pi entries are
   observable, then directly live-tailed with cursors. JSONL is re-read for initial replay and gap
   recovery, not after every append; the in-memory tail is not a second authoritative history.
5. **Effect replaces machinery, not domain rules.** Effect supplies typed errors, scopes,
   interruption, schedules, queues, streams, RPC correlation, and stream acknowledgements. OpenOrb
   still owns authentication, application-version validation, idempotency, reconciliation, replay
   cursors, tombstones, and ambiguous command outcomes.

Do not put Effect in the browser. Native `EventSource` remains the correct browser client. Do not
rewrite ordinary PostgreSQL CRUD merely to make the entire repository effectful.

## Research basis

The investigation started with the requested
[Effect Solutions quick start](https://www.effect.solutions/quick-start). The `effect-solutions` CLI
was installed at version 0.5.3 and queried for:

- project setup and TypeScript configuration;
- Effect basics;
- services and layers;
- data modeling;
- typed error handling; and
- testing.

Effect Solutions is a useful field manual, but describes itself as neither exhaustive nor
encyclopedic. Some guidance can lag the v4 API. The current Effect source was therefore cloned as
the authoritative, queryable reference at commit
[`4d89bb8ffb4cf567a1d11072246b6161ce638712`](https://github.com/Effect-TS/effect/tree/4d89bb8ffb4cf567a1d11072246b6161ce638712).
At that commit:

- `effect` is `4.0.0-rc.111`;
- `@effect/platform-deno` is `4.0.0-rc.111`;
- socket, RPC, and HTTP modules used here are under `effect/unstable/*`; and
- v4 is still a release candidate. Exact pins are required for reproducible builds, but OpenOrb
  explicitly accepts direct use of unstable APIs and compile-guided rewrites when they change.

The relevant capabilities verified in current source are:

- `Context.Service`, `Layer.effect`, and `Layer.scoped` for explicit service graphs;
- `Schema.Error` and the `Effect` error channel for serializable domain failures;
- `Scope`, `Effect.acquireRelease`, and structured fibers for deterministic cleanup;
- `Queue`, `PubSub`, `Stream`, `SynchronizedRef`, `FiberMap`, and `Schedule` for concurrency;
- schema-defined unary and server-streaming RPC, per-request correlation, interruption, stream chunk
  acknowledgement, ping/pong, headers, and schema validation;
- `DenoRuntime.runMain` for the runner and gateway composition roots;
- `DenoSocket.layerWebSocket` for the runner's outbound WebSocket;
- `DenoHttpServer.layer` and the active `HttpServerRequest.upgrade` effect for an Effect-owned
  gateway HTTP server and accepted WebSocket;
- `HttpEffect.fromWebHandler` for mounting the existing Remix Web handler as the gateway fallback;
  and
- `Stream.toReadableStreamEffect` for a pull-driven Web `ReadableStream` whose cancellation
  interrupts the stream fiber and runs finalizers.

The research also established limits that materially affect this design:

- Effect RPC does not provide durable deduplication, exactly-once execution, authentication
  semantics, protocol negotiation, replay cursors, command journals, or ambiguous-handoff rules.
- Standard Effect RPC is asymmetric. Building a general reverse-RPC or duplex adapter would add the
  very machinery this refactor should remove.
- RPC streaming acknowledgements bound server production against a bounded client queue, but native
  WebSocket `send()` still has no true awaitable byte-drain signal.
- `@effect/platform-deno` has a TCP/TLS `DenoSocketServer`, but no outbound-WebSocket implementation
  of RPC's `SocketServer.SocketServer` contract. There is also no direct public
  `RpcServer.fromSocket` helper. A small integration service must repeatedly offer the runner's
  `DenoSocket` `Socket.Socket` to `RpcServer.layerProtocolSocketServer`. It must own only scope and
  reconnect scheduling. This exists to supply missing runtime behavior, not to hide an unstable API.

## Why the current structure is difficult

The current code correctly handles many necessary edge cases, but implements an ad hoc effect
runtime in application code. Eight transport/event ownership files alone total 2,425 lines:

| Current owner                                                       | Lines | Concerns combined in the owner                                                                              |
| ------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| `packages/gateway/app/runner-connection-gateway.ts`                 | 1,189 | Upgrade, auth, parsing, timers, manifest assembly, routes, command correlation, replay correlation, cleanup |
| `packages/gateway/app/provision-command-owner.ts`                   |   122 | Pending map, timeout, reservations, settlement                                                              |
| `packages/gateway/app/prompt-command-owner.ts`                      |    75 | Prompt acknowledgement, timeout, uncertainty, and disconnect settlement                                     |
| `packages/gateway/app/abort-command-owner.ts`                       |    75 | Abort acknowledgement, timeout, uncertainty, and disconnect settlement                                      |
| `packages/gateway/app/session-route-owner.ts`                       |   182 | Routes, snapshots, listeners, fanout, disconnect cleanup                                                    |
| `packages/gateway/app/actions/api/sessions/session-event-stream.ts` |   100 | Queue, overflow policy, timer, abort wiring, Web stream bridge                                              |
| `packages/runner/src/connection.ts`                                 |   418 | WebSocket lifecycle, auth, reconnect, heartbeat, manifests, dispatch, replay responses                      |
| `packages/runner/src/session-event-relay.ts`                        |   264 | Serialization, connection handoff gate, cursor state, replay/live sequencing, publication                   |

The 1,257-line `SessionProvisioner` then has a second set of job maps, disposable stacks, callback
adapters, tuple results, event publication, and runtime ownership. The protocol package separately
defines the correlation envelopes and parsers required by the manual dispatchers.

The problem is not that these rules are unnecessary. It is that the same infrastructure concerns are
reimplemented at every level:

- Promise chains serialize socket messages and per-session operations.
- Maps correlate commands and replay requests with responses.
- `setTimeout` and `setInterval` model deadlines and liveness.
- `DisposableStack`, abort listeners, and close callbacks model scopes.
- The custom tuple `Result` is unpacked at nearly every asynchronous boundary.
- Replay and live handoff is coordinated independently on the runner and gateway.
- A browser cancellation must manually propagate through a channel, listener subscription, replay
  object, route owner, socket command, and runner relay.

That multiplication makes the system harder to reason about than its actual domain rules. Adding
more session commands, terminal streams, or preview channels in the same style would grow more
pending maps and cleanup paths.

## Alternatives considered

### Keep the wire protocol and use only Effect primitives

This would improve cleanup and error handling, but retain OpenOrb-owned request IDs, pending maps,
response dispatch, stream framing, stream cancellation, and replay-result messages. Reject it as a
cutover target; it must not survive as a compatibility transport.

### Make the runner the conventional RPC client

This matches the physical connection direction, but gateway-to-runner commands then need a
long-lived command stream plus a reverse result procedure. Correlation and asymmetric command
settlement remain application concerns. Session replay has the same problem.

### Build generic bidirectional RPC over Effect RPC

Effect's MCP implementation demonstrates that reverse clients can be built, but doing so would
create custom protocol machinery larger than the domain requires. Reject this option because of the
added behavior and concepts, not because the APIs are unstable.

### Chosen: invert logical roles

Every meaningful interaction can begin logically at the gateway:

- ask the runner for its initial and ongoing state;
- ask it to provision or operate a session; and
- ask it to watch a session after a cursor.

The runner's state changes and session events are streaming responses to those gateway requests.
This uses ordinary unary and server-streaming RPC without a reverse protocol.

## Target architecture

```text
Browser
  native EventSource
        |
        | HTTPS / SSE
        v
+------------------------------ Gateway process -------------------------------+
| Remix controller                                                             |
|   -> RunnerRegistry service                                                   |
|      -> Effect RPC client per authenticated runner connection                 |
|         -> WatchRunner() stream                                               |
|         -> ProvisionSession() effect                                          |
|         -> PromptSession() / AbortSession() effects                           |
|         -> WatchSession(afterCursor) stream                                   |
|                                                                               |
| DenoHttpServer owns HTTP/upgrade. Each accepted connection has one Scope.     |
+--------------------------------------|-----------------------------------------+
                                       |
             one authenticated JSON WebSocket, physically opened outbound
                                       |
+--------------------------------------|-----------------------------------------+
| Runner process                                                                |
| DenoSocket -> tiny OutboundSocketServer -> Effect RPC -> RunnerApi handlers   |
|                                                  |                            |
|                              +-------------------+-------------------+        |
|                              |                                       |        |
|                     SessionSupervisor                         SessionEvents    |
|                     process-owned FiberMap                    scoped streams   |
|                              |                                /      |         |
|                       Gondolin + Pi                    Pi JSONL   live PubSub   |
|                                                          durable   ephemeral   |
|                                                                               |
| A connection Scope never owns a running session job.                          |
+-------------------------------------------------------------------------------+
```

### Scope hierarchy

The lifetime hierarchy is an architectural invariant, not an implementation detail:

```text
Runner process scope
|-- SessionSupervisor
|   `-- process-owned session job fibers and VM resources
`-- RunnerConnectionSupervisor
    `-- connection-attempt scope
        |-- DenoSocket and RPC server attachment
        `-- RPC request scopes
            |-- WatchRunner stream
            `-- WatchSession streams

Gateway process scope
`-- RunnerRegistry
    `-- one connection scope per runner generation
        |-- DenoHttpServer accepted Socket and RPC client
        |-- WatchRunner consumer
        `-- in-flight RPC effects/streams

SSE request/body scope
`-- WatchSession client stream; browser cancellation interrupts this scope
```

Disconnecting a runner must cancel network requests and watchers. It must not cancel a provisioned
session, a running Pi prompt, or VM cleanup that has already transferred to the process-owned
`SessionSupervisor`.

## Protocol design

### Effect-owned Deno edges

Use `@effect/platform-deno` instead of keeping native WebSocket lifecycle adapters:

- The gateway starts under `DenoRuntime.runMain`, serves through `DenoHttpServer.layer`, handles the
  runner route with an Effect HTTP handler, and obtains `Socket.Socket` from the active
  `HttpServerRequest.upgrade` effect. `DenoHttpServer` installs an eager-frame buffer before the
  upgrade response completes, so an immediate runner frame is not lost.
- All other requests fall through `HttpEffect.fromWebHandler` to the existing Remix `router.fetch`.
  This changes HTTP server ownership, not the browser routing framework.
- The runner starts under `DenoRuntime.runMain` and obtains its outbound `Socket.Socket` from
  `DenoSocket.layerWebSocket`.

Neither process should call `new WebSocket`, `Deno.upgradeWebSocket`, or attach native socket event
listeners in application transport code. Both peers apply one size-limiting `Socket.make` decorator
before RPC decoding because Effect's whole-frame JSON serializer does not impose OpenOrb's frame
limit by itself.

One custom transport adapter remains on the runner. Effect RPC servers consume a
`SocketServer.SocketServer`, while `DenoSocket.layerWebSocket` supplies one outbound
`Socket.Socket`. `OutboundSocketServer` bridges only that interface mismatch and applies the one
reconnect schedule. It does not parse frames, buffer messages, authenticate peers, correlate calls,
or implement RPC. If it grows beyond that responsibility, the API proof has invalidated the design.

The runner socket decorator also reports one transport-only terminal signal to the connection
attempt. The gateway uses private WebSocket close code `4401` for permanent runner rejection. This
includes invalid credentials, claimed-ID mismatch, revocation, and application protocol mismatch.
The close reason is one fixed, non-sensitive message. Detailed rejection information remains only in
safe gateway logs.

The decorator records code `4401` in an attempt-scoped `Deferred` before Effect RPC consumes the
`SocketCloseError`. When the RPC handler ends, `OutboundSocketServer` reads that signal. Code `4401`
stops the reconnect schedule and returns a runner startup error. The operator must fix or re-enroll
the runner and restart the process. Observing this one close code is socket lifetime management. It
does not move authentication policy into the adapter.

All other close outcomes remain transient unless another policy in this document says otherwise.
This includes bootstrap timeout code `4408`, DNS failure, connect failure, abnormal close, and ping
timeout. These outcomes use the one capped reconnect schedule.

### Authentication as the first RPC

Do not add a custom pre-RPC authentication protocol. Make `IdentifyRunner` the only procedure the
gateway may invoke on a candidate connection:

1. The gateway upgrades the request, constructs the RPC client over the accepted Effect socket, and
   starts an authentication deadline.
2. It invokes `IdentifyRunner` before admitting the candidate to `RunnerRegistry` or calling any
   other procedure.
3. The runner returns its bearer token, claimed runner ID, runner version, application protocol
   version, and capabilities in a size-bounded response.
4. The gateway authenticates the bearer token, requires the authenticated and claimed runner IDs to
   match, checks revocation and protocol compatibility, and then starts `WatchRunner`.
5. Failure or timeout closes the candidate scope. Permanent rejection uses close code `4401` and
   stops runner reconnect. A bootstrap timeout uses close code `4408` and remains transient.

This preserves the MVP's bearer-token design without putting credentials in the URL query string or
WebSocket subprotocol, where they are more likely to enter HTTP/proxy logs. The credential must also
be redacted from RPC diagnostics, defects, spans, and logs. A future Ed25519 challenge-response can
replace the `IdentifyRunner` result without changing physical or logical socket roles.

Because the gateway is the RPC client, an unauthenticated peer cannot invoke gateway handlers. It
can only answer the gateway's bounded bootstrap request, and the gateway calls nothing else before
successful authentication. Effect owns bootstrap correlation and eager-frame handling; OpenOrb still
owns the authentication decision and application-version policy.

### Logical API

The exact declarations must be compiled in the API proof because these imports are release-candidate
APIs. The intended v4 shape is:

```ts
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

class IdentifyRunner extends Rpc.make("runner.identify", {
  success: RunnerIdentity,
  error: RunnerIdentityError,
}) {}

class WatchRunner extends Rpc.make("runner.watch", {
  success: RunnerStateEvent,
  error: RunnerWatchError,
  stream: true,
}) {}

class ProvisionSession extends Rpc.make("session.provision", {
  payload: ProvisionSessionPayload,
  success: ProvisionSessionSuccess,
  error: Schema.Union([CapacityExceeded, SessionConflict, ProvisionRejected]),
}) {}

class PromptSession extends Rpc.make("session.prompt", {
  payload: PromptSessionPayload,
  success: PromptSessionAccepted,
  error: Schema.Union([SessionNotFound, PromptRejected]),
}) {}

class AbortSession extends Rpc.make("session.abort", {
  payload: AbortSessionPayload,
  success: AbortSessionAccepted,
  error: Schema.Union([SessionNotFound, AbortRejected]),
}) {}

class WatchSession extends Rpc.make("session.watch", {
  payload: { sessionId: SessionId, afterCursor: SessionCursor },
  success: SessionEvent,
  error: Schema.Union([SessionNotFound, SessionCorrupt, HistoryReadError]),
  stream: true,
}) {}

export const RunnerApi = RpcGroup.make(
  IdentifyRunner,
  WatchRunner,
  ProvisionSession,
  PromptSession,
  AbortSession,
  WatchSession,
);
```

Later status, diff, archive, delete, and data-channel preparation procedures join the same group.
They are domain procedures, not generic `Command`/`CommandResult` envelopes.

Effect RPC request IDs are transport correlation only. Stable domain identifiers remain in payloads
and results where an operation needs identity across disconnects, restarts, or retries. These values
include the provisioning session ID, each prompt `clientRequestId`, and each Pi `runId`. A `runId`
must appear explicitly in accepted results, runner snapshots and events, and `AbortSessionPayload`.
It must never be derived from an Effect RPC request ID.

### `WatchRunner`

`WatchRunner` is started by the gateway before admitting a connection to `RunnerRegistry`. Its
stream contains:

- bounded initial session snapshot elements;
- one snapshot-complete boundary with capacity, revision, and count;
- periodic capacity/liveness observations; and
- subsequent session snapshot/removal notifications needed by the live route index.

The runner atomically subscribes to state-change notifications before taking the initial snapshot.
The gateway accumulates initial elements and commits routes only after the completion boundary and
catalog reconciliation succeed. A malformed, conflicting, or tombstoned manifest never becomes
partially live.

Use individual or small bounded groups of session snapshot elements rather than one unbounded array
response. This preserves the current protection against a giant manifest frame while allowing RPC to
own stream chunk correlation and acknowledgement.

The gateway applies a stream inactivity timeout instead of mutating a `setTimeout` handle after
every message. Effect RPC ping/pong checks socket responsiveness; `WatchRunner` observations check
that the runner's domain services are still responsive and refresh capacity.

For a replacement connection, use make-before-break admission where possible:

1. authenticate the candidate;
2. receive and reconcile its complete initial snapshot;
3. atomically install its new connection generation; then
4. close the old generation's scope.

An invalid candidate must not displace a healthy connection. A stale generation cannot update routes
after the atomic swap.

### `ProvisionSession`

`ProvisionSession` is a unary effect with a typed domain result. RPC owns in-connection request
correlation, interruption, and response decoding, so `ProvisionCommandOwner` disappears.

The handler performs only the acceptance transaction:

1. validate capacity, size, mode, and session conflicts;
2. idempotently create or prepare runner-local durable session metadata;
3. transfer the long-running job to the process-owned `SessionSupervisor`; and
4. return the durable session snapshot.

Steps 2 and 3 form one short acceptance commit. Implement that commit with
`Effect.uninterruptibleMask`. Validation and response delivery remain interruptible. The mask ends
as soon as the supervisor owns the job. It must not cover the long-running provisioning job.

The acceptance commit handles durable metadata as follows:

- New matching input creates metadata and installs one supervisor job.
- Matching metadata in the `created` state with no supervisor job installs the missing job while the
  current supervisor process is alive.
- Matching metadata with a live supervisor job or a completed durable state is already accepted. It
  does not start a second job.
- Matching metadata in the `provisioning` state with no live job indicates a process interruption
  after job start. Mark it failed and require an explicit retry. Do not restart its side effects
  automatically.
- Metadata for different immutable provisioning input returns `SessionConflict`.
- If supervisor insertion fails after metadata creation, mark the metadata as failed before leaving
  the masked section. An explicit retry then uses the normal failed-session path. If the failure
  write also fails, preserve the `created` metadata. The missing-job rule repairs that state.

Supervisor insertion is keyed by session ID and must never replace a live job. These rules make the
acceptance commit idempotent without making the provisioning side effects automatically retryable.

Before the supervisor becomes available or the runner opens RPC, it reconciles valid durable
sessions left by the previous process. `created` and `provisioning` become `error` and require an
explicit provisioning retry. `running` becomes `ready`: the owning Pi process is gone, but Pi JSONL
and the workspace remain authoritative, so the next prompt cold-continues rather than replaying an
ambiguous run. Existing `ready` and `error` states remain unchanged. Corrupt manifest entries stay
isolated, while failure to load or rewrite otherwise valid durable state fails supervisor startup
instead of advertising known-stale state.

The background provisioning job is held in a process-scoped `FiberMap` keyed by session ID. It is
not a child of the RPC request or connection. A disconnect after step 3 may lose the RPC response,
but does not stop the job.

That lost response is an ambiguous distributed outcome. Do not automatically replay the command
because Effect reported a socket error. A same-session retry must be checked idempotently against
runner metadata. The next complete runner snapshot also reconciles a successfully created session
with the gateway catalog.

The gateway's local capacity reservation remains a domain concern. Implement it as scoped state in
`RunnerRegistry` so every success, failure, timeout, disconnect, and interruption releases it once.
The runner remains authoritative and rechecks capacity.

Keep Pi's `AgentSession` as an opaque mutable resource rather than mirroring its state into Effect
services or `Ref`s. One process-owned session fiber exclusively owns it and serializes prompts;
Effect only manages scoped creation, subscription cleanup, interruption through `abort()`, and final
disposal. Keep the Pi session alive across prompts and use its JSONL transcript to reconstruct it
after a runner restart.

### `PromptSession` and `AbortSession`

`PromptSession` and `AbortSession` are unary acceptance effects. The process-owned session fiber
serializes both procedures for each session. This preserves order when Prompt and Abort arrive at
the same time.

The runner checks Pi's current state inside the serialized operation. An idle prompt calls
`session.prompt()`. A prompt during an active run calls `session.followUp()`. The gateway does not
select between these operations. Each prompt carries a stable `clientRequestId`. A newly started Pi
run receives an explicit `runId`. An accepted follow-up reports the current `runId`.

Do not retry a prompt automatically. A timeout or disconnect after Pi may have accepted the prompt
produces a `delivery-uncertain` gateway result. The next runner snapshot and Pi JSONL can show work
that became observable. They do not authorize automatic replay. Pi's accepted follow-up queue is
process-local and ephemeral. Only a delivered follow-up becomes durable in Pi JSONL.

`AbortSessionPayload` contains the exact `runId` observed by the gateway. The runner rejects an
Abort for an idle, settled, or different run. When Abort starts, the session rejects new Prompt and
Abort requests. It then clears all Pi-native queued follow-ups, calls `session.abort()`, and waits
for Pi to settle. A user-requested `aborted` stop reason returns the session to ready instead of
failed.

Do not retry Abort automatically. A timeout or disconnect produces an uncertain result because the
target run may still be stopping.

### `WatchSession`

The gateway shares one runner `WatchSession({ sessionId, afterCursor })` stream among browser
EventSources watching the same routed session from the same cursor. A different `afterCursor`
creates a separate replay cohort: reusing the first browser's cursor would skip or duplicate durable
history for reconnecting tabs. Each cohort is scoped to the accepted runner connection and uses a
bounded replaying `Stream.share` sized for 2,048 durable and 512 ephemeral events; removing the
session or replacing the connection closes its cohorts. Runner-produced live events carry the
current durable conversation cursor as a watermark. Each browser consumer independently checks both
durable cursor continuity and that watermark. A gap terminates that consumer and evicts the cohort
so its EventSource reconnect creates a fresh replay from the last delivered cursor.

The runner's `SessionEvents` service combines two deliberately different event classes in one
per-session tail:

1. **Conversation history:** Replay completed conversation state from Pi JSONL after the cursor,
   then directly tail completed events projected from persisted Pi entries. Pi JSONL remains the
   source of truth.
2. **Ephemeral events:** Token deltas, current lifecycle state, and transient progress share the
   bounded tail with durable events. They may be dropped without invalidating durable history.

The Pi adapter publishes each completed conversation payload only after the corresponding durable Pi
entry is observable. `SessionEvents` initializes the session cursor from the JSONL projection,
assigns the next cursor to each new payload, and publishes it through a 2,048-element sliding
`PubSub`. A watcher subscribes before its initial replay, filters queued duplicates by cursor, and
then consumes the direct tail without rereading JSONL after every append. Publication is serialized:
ephemeral events are rejected once subscriber lag reaches 512 queued items, reserving the remaining
capacity for durable events. Durable events are always admitted up to the 2,048-element sliding
limit and remain recoverable from JSONL if pressure displaces one. The live cursor watermark makes
that displacement observable even when no later durable event reaches the same consumer.

The bounded tail is an optimization, not durable storage. If a slow subscriber observes a cursor
gap, it rereads the missing suffix from Pi JSONL. A disconnect also causes a fresh initial read.
This keeps Pi JSONL authoritative while avoiding an increasingly expensive full-history read for
every completed message or tool event.

OpenOrb does not expose Pi branching. `SessionCursor` therefore remains a non-negative position in
the current linear Pi JSONL projection. If `afterCursor` is zero or is greater than the current
projection length, emit `conversation.reset` and then the complete projection. Otherwise, emit only
later cursor-bearing events. A future OpenOrb branching feature must define a new cursor contract
before it can change the active projection. The cursor remains independent of RPC request IDs.

The current implementation's fine-grained provisioning stages and provisioning output are ephemeral.
Keep them best-effort. Deliver them through a bounded/sliding in-memory stream. A disconnect or slow
consumer may lose them, and reconnect does not replay them. Runner metadata provides only the latest
coarse lifecycle state. Pi JSONL remains the only durable conversation source of truth. Do not add a
durable provisioning event log, a unified OpenOrb event log, or a second normalized conversation
transcript.

### Gateway SSE edge

The session event action becomes a stream transformation:

```text
RunnerRegistry.watchSession(afterCursor)
  -> filter/redact browser-visible events
  -> encode SSE records
  -> merge 15-second keepalive comments
  -> Stream.toReadableStreamEffect
  -> Response
```

`Stream.toReadableStreamEffect` captures the Effect runtime at the Remix edge. Pull demand drives a
bounded shared RPC client queue. Cancelling the Web `ReadableStream` interrupts that browser's
fiber. The runner RPC stream remains alive while another browser consumes the same cursor cohort;
cancelling the last consumer sends the remote interrupt and releases the runner subscription.

Keep the current browser `EventSource` reducer and `Last-Event-ID` behavior. On runner disconnect,
history failure, or a durable cursor gap, terminate the SSE response. `EventSource` reconnects, and
the new `WatchSession` request resumes from the last delivered durable cursor. Never silently drop a
cursor-bearing event and continue the same SSE stream.

Live token deltas may be dropped under pressure. A slow browser must not stall Pi, other browsers,
or the runner control plane.

## Process service graphs

### Runner

The runner layer graph should have concrete domain services, not a generic utility layer:

```text
DenoRuntime.runMain
`-- RunnerLive
    |-- DenoSocket
    |-- RunnerIdentity
    |-- RunnerSessionStore
    |-- RunnerCapacity
    |-- GondolinRuntimeFactory
    |-- SessionEvents
    |-- SessionSupervisor
    |-- RunnerApiHandlers
    `-- RunnerConnectionSupervisor / OutboundSocketServer
```

`SessionSupervisor` replaces `SessionProvisioner`'s manual job/runtime maps and shutdown handling:

- `FiberMap` owns one long-running job per session;
- a bounded `Semaphore` or equivalent service state owns concurrency slots;
- VM/session resources use `Effect.acquireRelease` or scoped service resources;
- store and Gondolin Promise APIs are wrapped once at leaf adapters; Pi is bridged only at its
  owning session scope;
- schema errors represent expected rejections;
- defects represent programming bugs or violated internal invariants; and
- process-scope shutdown interrupts jobs and runs VM finalizers deterministically.

Do not convert an external Promise to `Effect.tryPromise` repeatedly up the call stack. Convert it
once in the service that owns that external API, then expose an effectful contract upward.

### Gateway

The gateway keeps Remix and the existing repository ownership, but `DenoHttpServer` replaces direct
`Deno.serve` ownership. One `DenoRuntime.runMain` composition root starts after the store and
migrations are ready:

```text
GatewayLive
|-- DenoHttpServer
|-- runner authentication repository adapter
|-- session catalog reconciliation adapter
`-- RunnerRegistry
```

`RunnerRegistry` owns one `SynchronizedRef` containing immutable connection generations, route
entries, snapshots, reservations, and revocation state. A pure state transition computes each
change; effects such as catalog reconciliation and scope closure happen at explicit boundaries. The
implementation is a closure-backed `Context.Service` constructed by a Layer, not a mutable registry
class. Each admitted connection has a scoped runtime containing its RPC client and a `ScopedCache`
keyed by session and replay cursor. Cache entries own `Stream.share` cohorts, so concurrent tabs
share one upstream stream while cache invalidation or connection-scope closure releases the cohort
without application-owned watch maps or allocation semaphores.

An Effect HTTP route upgrades `/api/runners/connect` and transfers the accepted socket to
`RunnerRegistry`; all other requests pass to Remix through `HttpEffect.fromWebHandler`. The registry
forks the candidate into its process-owned connection scope before the HTTP handler returns. On
process interruption, the root scope closes all connection scopes before the PostgreSQL store.

The existing Remix `AppServices` context carries the already-constructed effectful runner service,
whose methods return effects or streams with their layer dependencies captured. Controllers execute
those effects only at the request/response edge and bridge the request `AbortSignal`; they do not
build a Layer per request. Retain `ManagedRuntime` only if the API proof demonstrates that a Remix
callback genuinely needs an open Effect environment that cannot be captured by the service. Do not
add a Promise facade that recreates abort, timeout, and error mapping for every method.

## Typed error policy

Expected failures are small schema-backed tagged errors. Suggested categories are:

| Category                     | Examples                                                                  | Policy                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Authentication/configuration | `AuthenticationRejected`, `ProtocolMismatch`, `RunnerRevoked`             | Close; no automatic retry                                            |
| Transient transport          | DNS/connect failure, abnormal close, ping timeout                         | Runner reconnect schedule                                            |
| Availability                 | `RunnerOffline`, `ConnectionReplaced`, `RequestTimeout`                   | Map to HTTP 503 or close SSE                                         |
| Domain rejection             | `CapacityExceeded`, `SessionConflict`, `RetryRejected`, `SessionNotFound` | Return an explicit user-safe result                                  |
| Durable state                | `SessionCorrupt`, `HistoryReadError`, `CatalogReconciliationError`        | Stop affected operation/connection; preserve source data             |
| Interruption                 | Browser cancelled, connection scope closed, shutdown                      | Normal cleanup, not an error log                                     |
| Defect                       | Impossible state, coding bug, unsafe callback exception                   | Trace/log, close the affected scope, never present as a domain error |

Replace `@openorb/result` tuple plumbing in the migrated transport/orchestration core. Leave
unrelated CRUD users unchanged. At a Remix or CLI edge, inspect the Effect `Exit` once and map it to
an HTTP response, process exit, or structured log.

Do not catch `unknown` at every layer and rename it. Each leaf adapter maps only the failures it can
meaningfully classify.

## Retry, delivery, and backpressure semantics

Effect centralizes these policies but does not decide them:

| Flow                            | Authoritative state                                    | Automatic retry                                      | Disconnect/overflow behavior                                        |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Identification/auth/version     | Gateway runner record + protocol constants             | Never after close code `4401`                        | Stop reconnect; operator fixes configuration and restarts runner    |
| Physical runner connection      | Current scoped socket                                  | Transient open/close only, exponential capped jitter | New connection scope; old scope finalizes                           |
| Runner snapshot/routes          | Runner store + gateway tombstones/catalog              | Full stream restarts on reconnect                    | Gateway commits only complete reconciled snapshot                   |
| Capacity/status                 | Current runner observation                             | Re-established with connection                       | Inactivity closes connection; no stale live state                   |
| Provision acceptance            | Runner-local session metadata                          | No blind side-effect retry                           | Response may be ambiguous; same session ID is reconciled/idempotent |
| Prompt/follow-up/Abort          | Pi live state + explicit `clientRequestId` and `runId` | No                                                   | Ambiguous handoff remains `delivery-uncertain`                      |
| Completed conversation          | Pi JSONL projection                                    | Browser reconnect asks after cursor                  | Never silently drop; close and replay from cursor                   |
| Current lifecycle state         | Runner metadata                                        | Re-read on each watch/reconnect                      | Coalesced notifications are safe because state is reread            |
| Token deltas/transient progress | Memory only                                            | No                                                   | Bounded/sliding drop is allowed                                     |
| Provisioning logs               | Memory only                                            | No                                                   | Bounded best-effort delivery; disconnect loses them                 |
| Future terminal/preview bytes   | Endpoint stream, no durable replay by default          | Reopen/reset explicitly                              | Byte credits and bounded queues; never block control                |

There must be exactly one owner for connection retry: the runner's outbound connection supervisor.
Disable the Effect RPC client's built-in socket retry for the gateway's already-accepted socket
(using a stopping retry policy). Retrying the same closed native socket or retrying in both layers
would create hidden loops and misleading pending requests.

For RPC server streams, set an explicit small client `streamBufferSize` and bound every event/frame.
Chunk acknowledgement provides element-level backpressure. It does not replace:

- maximum inbound/outbound frame sizes;
- maximum concurrent RPC streams per runner/user;
- bounded unary payloads;
- ephemeral drop policy; or
- the byte-credit protocol required by the future binary data plane.

## Future binary sockets and streams

The broader plan's second outbound binary WebSocket should remain a separate data plane. Do not put
terminal, preview, or file bytes through the JSON control RPC stream.

Effect still supplies the data plane's resource model:

- one `DataConnectionSupervisor` scope per physical data socket;
- a `FiberMap` keyed by logical channel ID;
- bounded `Queue`s between browser sockets, runner endpoints, and the multiplexer;
- `Channel`/`Stream` transformations for frame parsing and encoding;
- scoped cancellation and endpoint finalizers; and
- schedules for reconnecting the physical data socket independently.

OpenOrb must still define and test the binary protocol: `open`, `data`, `window-update`, `end`, and
`reset`; per-channel byte credits; fair scheduling; maximum frame/channel counts; cancellation; and
destination policy. Control remains a separate connection so saturated data traffic cannot starve
heartbeats, commands, or recovery.

Gateway browser terminal/preview WebSockets become scoped edge adapters into these logical data
channels. Their close interrupts the channel fiber and sends reset/end as appropriate.

## What is removed or replaced

| Current component                                                          | Target                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Hand-written runner message envelopes and dispatch switches                | `RunnerApi` Effect Schema/RPC declarations, beginning with `IdentifyRunner`       |
| `RunnerConnectionGateway` giant class                                      | `RunnerRegistry` domain service + Deno HTTP upgrade/admission handler             |
| `ProvisionCommandOwner`                                                    | Unary RPC effect, `Effect.timeout`, scoped reservation, runner domain idempotency |
| `PromptCommandOwner` and `AbortCommandOwner`                               | Unary RPC effects, explicit domain IDs, and transport uncertainty mapping         |
| `PendingSessionEventReplay` and replay-result messages                     | One `WatchSession(afterCursor)` stream                                            |
| Gateway live session listener fanout                                       | Scoped `Stream.share` cohorts keyed by route, session, and replay cursor          |
| Runner `SessionEventRelay` attachment and Promise gates                    | `SessionEvents` JSONL projection plus one selective 2K tail PubSub                |
| Manual SSE `Channel`, timers, abort listeners, and `ReadableStream` source | Effect stream transformations and `Stream.toReadableStreamEffect`                 |
| Reconnect loop and heartbeat interval mutation                             | Scoped connection attempt plus `Schedule`, `Stream`, timeout, and RPC ping/pong   |
| Provisioner Promise job/runtime maps                                       | Process-owned `FiberMap`, scoped VM resources, typed service errors               |
| Tuple `Result` throughout transport/orchestration                          | Effect typed error channel; one `Exit` mapping at imperative edges                |

The route index, catalog reconciliation, capacity checks, tombstones, Pi event normalization, and
security policies do not disappear. They become visible domain operations instead of branches in a
transport dispatcher.

## Stop-the-world cutover plan

Land the runner, gateway, RPC contract, event path, and SSE edge as one atomic architecture change.
The work packages below describe implementation order, not independently deployable migration
phases. The final changeset has exactly one runtime path.

Explicitly do not add:

- old/new protocol negotiation or a version 1 compatibility dispatcher;
- feature flags selecting old versus Effect transport;
- dual publication, dual reads, or dual route registries;
- an adapter that lets the old transport consume new Effect services;
- a fallback OpenOrb `ControlTransport`; or
- wrappers whose only purpose is insulating OpenOrb from `effect/unstable` API changes.

New target modules may be built before the switch, but they are not wired alongside the old runtime
path. When a target owner is connected, delete the owner it replaces in the same changeset. Keeping
every intermediate work package deployable is not a requirement; completing and verifying the
combined cutover is.

### Work package 0: isolated API proof

Before changing production paths, build a test-only vertical slice pinned to the selected v4 RC:

1. Runner opens a real loopback Deno WebSocket.
2. `DenoSocket.layerWebSocket` supplies the runner's outbound socket; the minimal
   `OutboundSocketServer` feeds it into `RpcServer.layerProtocolSocketServer` using direct unstable
   imports.
3. The active `HttpServerRequest.upgrade` effect supplies the gateway's accepted socket, which is
   used by `RpcClient.makeProtocolSocket` with retry disabled.
4. An eager `IdentifyRunner` response during asynchronous authentication is preserved without any
   native socket listener or custom preface buffer.
5. Invalid token, claimed-ID mismatch, version mismatch, and timeout close the candidate before any
   non-bootstrap procedure is called.
6. The socket decorator records close code `4401` before RPC consumes the close error, and the
   runner stops reconnecting. Bootstrap timeout code `4408` still reconnects.
7. One unary RPC and one infinite streaming RPC work in the inverted logical direction.
8. Stream cancellation reaches the runner finalizer.
9. Forced disconnect settles pending effects and permits a clean reconnect.
10. Frame limits, JSON Schema failures, ping timeout, and exact close codes are observed.
11. `deno compile` still produces the standalone Linux runner without a Node runtime requirement.

Promote this slice to a contract test or delete it when its coverage exists in integration tests. It
must never become a second production transport. If `OutboundSocketServer` cannot remain a minimal
socket/lifetime bridge, revise the role arrangement before proceeding; do not preserve the current
protocol as a fallback and do not copy Effect's private RPC implementation.

### Work package 1: target contracts and composition roots

- Add exact matching `effect` and `@effect/platform-deno` pins to the Deno import graph and
  lockfile.
- Define the complete `RunnerApi`, serializable payloads, results, and typed errors in
  `@openorb/protocol`.
- Import `effect/unstable/rpc`, `effect/unstable/socket`, and `effect/unstable/http` directly in the
  modules that own those concerns. Do not create stability wrappers or an OpenOrb mirror of their
  types.
- Add one `DenoRuntime.runMain` composition root to each process; use `DenoHttpServer` on the
  gateway and `DenoSocket` on the runner.
- Keep Remix `data-schema` at browser form/request boundaries; Effect Schema becomes the sole runner
  wire/RPC schema source.

Do not add Bun/npm runtime scripts or Vitest. The private `package.json` is required for Effect
setup scripts, Effect-aware diagnostics, and local TypeScript tooling. Deno installs and runs that
tooling. The application remains Deno-only, and `deno.json` plus `deno.lock` remain authoritative
for runtime dependencies.

### Work package 2: atomic runner and gateway replacement

- Replace `SessionProvisioner` ownership with the process-scoped `SessionSupervisor` and replace
  `SessionEventRelay` with `SessionEvents`; do not adapt either service back to old messages.
- Wrap existing `RunnerSessionStore` and Gondolin Promise APIs once at their leaf Effect services;
  use the existing Pi factory directly at the scoped session boundary.
- Install the runner RPC server over `OutboundSocketServer` and implement `IdentifyRunner`,
  `WatchRunner`, `ProvisionSession`, `PromptSession`, `AbortSession`, and `WatchSession` directly
  from the new services.
- Preserve native follow-up behavior, per-session Prompt/Abort ordering, exact-run Abort, queue
  clearing before Abort, no automatic command retry, and uncertain delivery results.
- Move gateway HTTP ownership to `DenoHttpServer`, mount runner upgrade as an Effect HTTP handler,
  and pass all remaining requests to Remix with `HttpEffect.fromWebHandler`.
- Replace `RunnerConnectionGateway`, `ProvisionCommandOwner`, `PromptCommandOwner`,
  `AbortCommandOwner`, and `SessionRouteOwner` with the one `RunnerRegistry` and the accepted-socket
  RPC client.
- Replace the replay command plus legacy gateway fanout path with cursor-correct shared
  `WatchSession` stream cohorts, then replace the manual SSE channel with
  `Stream.toReadableStreamEffect`.
- Remove tuple `Result` from the transport, registry, event, and provisioning core. Delete
  `@openorb/result` only if no unrelated users remain.

### Work package 3: deletion and whole-system verification

Before the cutover is considered reviewable:

- delete version 1 envelopes, parsers, dispatch switches, manifest chunks, heartbeat messages,
  provision/prompt/abort responses, replay commands/results, pending maps, relay attachment gates,
  gateway live fanout, the old reconnect loop, and the manual SSE channel;
- search for and reject any old/new switch, compatibility branch, or dead transport owner;
- update `MVP.md` and `MASTER_PLAN.md` protocol and gateway server wording to describe only the new
  path; and
- run the complete verification strategy below against the combined runner/gateway architecture.

### Future data plane

When terminal/preview work begins, implement the separately scoped binary data plane described
above. Reuse Effect lifecycle patterns, not the JSON RPC transport.

## Verification strategy

Continue using `deno test`. Effect Solutions recommends `@effect/vitest` for Vitest projects, but
changing this Deno repository's test runner is unrelated and unnecessary.

Use four layers of tests:

### Pure service tests

- `RpcTest.makeClient` or direct handler layers for typed RPC contracts;
- `TestClock` for authentication, heartbeat, request timeout, keepalive, and reconnect schedules;
- test Layers for store, Pi, Gondolin, capacity, and authentication services; and
- no real sleeps or arbitrary timing margins.

### Deterministic transport tests

- fake socket and single-connection `SocketServer` implementations;
- eager `IdentifyRunner` response during asynchronous authentication;
- malformed/oversized frame close behavior;
- replacement connection generations and stale-fiber mutation attempts;
- pending unary request failure on disconnect; and
- remote interruption and finalizer execution for cancelled streams.

### Event reliability tests

- Pi append before subscription, during initial read, and after live handoff;
- notification coalescing without durable event loss;
- reset for zero and ahead-of-history cursors;
- no duplicate cursor-bearing event across replay/live boundaries;
- best-effort provisioning output is bounded and is not replayed after reconnect;
- slow browser drops token deltas without blocking Pi;
- durable pressure/gap terminates SSE and resumes from `Last-Event-ID`;
- multiple browsers have independent cancellation/backpressure; and
- runner disconnect closes streams without leaving subscribers or routes.

### Real integration and security tests

- actual Deno WebSocket between runner and gateway;
- enrollment/authentication, invalid token, revocation, terminal rejection, reconnect, and gateway
  restart;
- disconnect before, during, and after provision's durable acceptance commit;
- idle prompt, native follow-up, Prompt/Abort ordering, stale-run Abort rejection, follow-up
  clearing, and uncertain non-retry behavior;
- manifest/catalog/tombstone reconciliation and anti-resurrection;
- native browser EventSource reconnect through gateway to runner Pi JSONL;
- no secrets in URLs, close reasons, spans, logs, defects, or browser events;
- hostile Pi/workspace tests remain unchanged; and
- `deno task check`, `deno task test`, and standalone runner compilation.

## Dependency and API policy

- Pin exact matching versions of `effect` and `@effect/platform-deno`; never use `^`, `~`, or
  `latest` in tracked manifests.
- Commit the Deno lockfile update.
- Use exported unstable APIs directly wherever they naturally own the behavior. Do not introduce an
  OpenOrb abstraction, type mirror, facade, or import gateway solely to reduce upgrade churn.
- When an RC changes, let type errors identify affected call sites and rewrite them directly. The
  expected maintenance strategy is a compile-guided repository update, not a compatibility layer.
- Add contract tests around the outbound `SocketServer` adapter, accepted-socket no-retry client,
  terminal close signal, `IdentifyRunner` admission, stream acknowledgement, cancellation, frame
  size, and eager-frame handling.
- Review Effect source and rerun the API contract tests after every v4 RC upgrade.
- Keep the Effect language service and local TypeScript in the private tooling-only `package.json`.
  Deno remains the package manager and authoritative TypeScript language server; use
  `deno task typecheck:effect` for Effect-specific diagnostics without moving application tooling to
  Node.js.

## Risks and mitigations

### Effect v4/RPC is release-candidate software

**Risk:** API churn or behavior changes during upgrades.

**Mitigation:** exact pins, direct use of exported unstable APIs, source-based review, and the API
contract suite. Accept compile-guided rewrites across runner and gateway when upgrading. Do not pay
a permanent abstraction cost to avoid occasional pre-production rewrites.

### The role inversion depends on a small adapter

**Risk:** Public `SocketServer` lifecycle semantics may not fit an outbound reconnect loop cleanly.

**Mitigation:** prove it before migration. The adapter should only offer the outbound Deno socket to
the supplied handler in a child scope, observe the one terminal close signal, and apply the
connection retry schedule. The socket decorator, not RPC, records that signal. If the adapter starts
implementing authentication, RPC framing, client IDs, or correlation, revise the role arrangement
before the atomic cutover.

### Effect can hide distributed ambiguity if used carelessly

**Risk:** `Effect.retry` makes a non-idempotent call look safe.

**Mitigation:** retry only connection establishment and explicitly classified domain operations.
Keep stable command and run IDs, Pi reconciliation, and `delivery-uncertain` semantics outside the
transport library. Do not add a durable prompt queue or journal.

### A scope can own too much

**Risk:** Closing a WebSocket cancels provisioning or a running Pi session.

**Mitigation:** enforce the documented process/connection/request scope hierarchy. Mask only the
short metadata-and-supervisor acceptance commit. Test interruption before, during, and after that
commit. After acceptance, the process-owned job must continue.

### RPC acknowledgement is not byte-level drain

**Risk:** many streams or large unary values can still grow native WebSocket buffers.

**Mitigation:** bounded frame schemas, per-stream buffer limits, subscription caps, small chunks,
best-effort live event dropping, and a separate byte-credit data plane.

### The codebase becomes “Effect-shaped” without becoming simpler

**Risk:** every function is wrapped in a service/layer while old pending maps and facades remain.

**Mitigation:** judge the migration by deleted lifecycle/correlation machinery. Do not add generic
effect helper packages or Promise facades. Keep pure transformations pure and keep CRUD outside the
scope.

## Non-goals

- No Effect client bundle in the browser.
- No replacement of Remix. `DenoHttpServer` replaces direct `Deno.serve` ownership specifically to
  remove custom Deno HTTP/WebSocket lifecycle adapters.
- No PostgreSQL schema expansion, Redis, message broker, or gateway event store.
- No second conversation event log beside Pi JSONL.
- No exactly-once claim for provisioning, prompts, or other distributed side effects.
- No automatic replay of ambiguous non-idempotent commands.
- No terminal/preview binary traffic on the control RPC socket.
- No repository-wide rewrite of result handling or persistence code in the first cut.

## Acceptance criteria for the refactor

The implementation should not be called complete merely because Effect is present. It is complete
when all of the following are true:

1. Runner and gateway use one schema-defined RPC API, and `IdentifyRunner` is the sole operation
   before connection admission.
2. There is no application-owned pending map for ordinary RPC request correlation or session event
   replay.
3. Cancelling the last browser in a cursor cohort demonstrably interrupts and finalizes the matching
   runner stream; cancelling one of several consumers does not.
4. Replacing a connection closes one scope and stale fibers cannot update live registry state.
5. Disconnecting a connection does not cancel process-owned session work.
6. Completed conversation events live-tail directly only after Pi persistence is observable, and
   reconnects or cursor gaps recover them from Pi JSONL.
7. Slow consumers cannot block Pi or runner control; durable events are replayed rather than
   silently dropped.
8. `PromptSession` preserves idle prompt and native follow-up behavior. `AbortSession` targets one
   exact run, clears queued follow-ups, and preserves Prompt/Abort order.
9. Prompt and Abort are never retried automatically. An ambiguous handoff reports uncertain
   delivery.
10. Authentication/protocol failures stop retry through close code `4401`. Transient connection
    failures use one deterministic capped-jitter schedule.
11. Existing catalog, ownership, tombstone, Pi isolation, Git isolation, and secret-redaction tests
    remain green.
12. The old dispatch envelopes, command owners, replay owner, relay attachment gate, and manual SSE
    channel are deleted.
13. There is no compatibility protocol, old/new feature flag, dual event path, or unstable-API
    insulation wrapper.

As a guardrail, the eight current transport/event ownership files total 2,425 lines. The replacement
should remove substantially more custom lifecycle/correlation code than it adds; a reasonable target
is a 40–60% reduction in that area, excluding schema declarations and domain reconciliation. If the
new design approaches the old size because of integration glue around Effect RPC, reconsider the RPC
role arrangement rather than preserving both architectures.

## Final recommendation

Approve the logical role inversion and isolated API proof. Assuming the proof validates current
Effect v4 APIs under Deno and standalone compilation, execute the runner, gateway, event, and SSE
replacement as one stop-the-world architecture change. This removes the most failure-prone custom
machinery without carrying a compatibility architecture, while preserving the parts Effect cannot
and should not own: OpenOrb's security boundary, durable session truth, idempotency policy, and
recovery semantics.
