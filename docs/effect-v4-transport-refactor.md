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
   transcript. Completed conversation events are always re-derived from it. In-memory streams carry
   notifications and best-effort live deltas, not a second authoritative history.
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
runtime in application code. Six transport/event ownership files alone total 1,960 lines:

| Current owner                                                       | Lines | Concerns combined in the owner                                                                              |
| ------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| `packages/gateway/app/runner-connection-gateway.ts`                 |   919 | Upgrade, auth, parsing, timers, manifest assembly, routes, command correlation, replay correlation, cleanup |
| `packages/gateway/app/provision-command-owner.ts`                   |   122 | Pending map, timeout, reservations, settlement                                                              |
| `packages/gateway/app/session-route-owner.ts`                       |   165 | Routes, snapshots, listeners, fanout, disconnect cleanup                                                    |
| `packages/gateway/app/actions/api/sessions/session-event-stream.ts` |   100 | Queue, overflow policy, timer, abort wiring, Web stream bridge                                              |
| `packages/runner/src/connection.ts`                                 |   390 | WebSocket lifecycle, auth, reconnect, heartbeat, manifests, dispatch, replay responses                      |
| `packages/runner/src/session-event-relay.ts`                        |   264 | Serialization, connection handoff gate, cursor state, replay/live sequencing, publication                   |

The 842-line `SessionProvisioner` then has a second set of job maps, disposable stacks, callback
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
prompt commands, cancellation, terminal streams, or preview channels in the same style would grow
more pending maps and cleanup paths.

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
5. Failure or timeout closes the candidate scope. Authentication/version rejection is not retried
   until runner configuration changes; transient DNS, connect, close, and ping failures are.

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
  WatchSession,
);
```

Later prompt, abort, status, diff, archive, delete, and data-channel preparation procedures join the
same group. They are domain procedures, not generic `Command`/`CommandResult` envelopes.

Effect RPC request IDs are transport correlation only. Stable domain identifiers remain in payloads
where an operation needs idempotency across disconnects, restarts, or retries. Examples include a
session ID for provisioning and `clientRequestId` for future prompt delivery.

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

### `WatchSession`

Each browser EventSource causes the gateway to invoke one `WatchSession({ sessionId, afterCursor })`
stream on the routed runner connection. The gateway no longer requests a replay through one
correlation map and separately subscribes to live gateway fanout.

The runner's `SessionEvents` service exposes three deliberately different sources:

1. **Conversation history:** Project completed conversation state from Pi JSONL after the cursor. Pi
   JSONL remains the source of truth.
2. **Current lifecycle state:** Read the current runner metadata when the stream starts and after a
   coalesced state-change notification. This recovers the latest state without a generic event log.
3. **Ephemeral events:** Token deltas and transient progress use a bounded/sliding `PubSub`. They
   may be dropped without invalidating durable history.

Durable conversation publication should be a wake-up signal, not the durable payload:

- subscribe to a capacity-one sliding history-change `PubSub` first;
- read and project Pi JSONL after the current cursor;
- publish a notification only after the corresponding durable projection is observable; and
- after each notification, read again from the new cursor.

A capacity-one sliding notification is sufficient because notifications carry no state. Every
subscriber retains the latest wake-up even if another subscriber is slow. If ten updates coalesce
into one wake-up, the next Pi JSONL read still returns all ten durable events. A disconnect causes a
fresh initial read. This is simpler and safer than attempting to make an in-memory event queue
lossless.

If `afterCursor` is zero or no longer valid for the active Pi branch, emit `conversation.reset` then
the complete active projection. Otherwise emit only later cursor-bearing events. The cursor contract
remains runner-owned and independent of RPC request IDs.

The current implementation's fine-grained provisioning stages and provisioning output are ephemeral.
Effect cannot make them durable. The accepted design must choose explicitly between:

- keeping them documented as best-effort; or
- deriving current stage from runner metadata and replaying output from the ordinary runner log
  files already allowed by `MVP.md`.

Do not add a unified OpenOrb event log or a second normalized conversation transcript to solve this.

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
bounded RPC client queue. Cancelling the Web `ReadableStream` interrupts its fiber; closing the RPC
stream sends a remote interrupt; the runner releases that subscriber's PubSub queues and file
readers.

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
change; effects such as catalog reconciliation and scope closure happen at explicit boundaries.

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

| Flow                            | Authoritative state                                                    | Automatic retry                                      | Disconnect/overflow behavior                                        |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Identification/auth/version     | Gateway runner record + protocol constants                             | Never after rejection/mismatch                       | Close candidate; operator must fix identity/version                 |
| Physical runner connection      | Current scoped socket                                                  | Transient open/close only, exponential capped jitter | New connection scope; old scope finalizes                           |
| Runner snapshot/routes          | Runner store + gateway tombstones/catalog                              | Full stream restarts on reconnect                    | Gateway commits only complete reconciled snapshot                   |
| Capacity/status                 | Current runner observation                                             | Re-established with connection                       | Inactivity closes connection; no stale live state                   |
| Provision acceptance            | Runner-local session metadata                                          | No blind side-effect retry                           | Response may be ambiguous; same session ID is reconciled/idempotent |
| Completed conversation          | Pi JSONL active projection                                             | Browser reconnect asks after cursor                  | Never silently drop; close and replay from cursor                   |
| Current lifecycle state         | Runner metadata                                                        | Re-read on each watch/reconnect                      | Coalesced notifications are safe because state is reread            |
| Token deltas/transient progress | Memory only                                                            | No                                                   | Bounded/sliding drop is allowed                                     |
| Provisioning logs               | Best-effort today, or ordinary runner log file after explicit decision | Only if file-backed                                  | Must not be described as durable while memory-only                  |
| Future prompt command           | Runner journal + `clientRequestId` + Pi reconciliation                 | Only where domain classifies safe                    | Ambiguous Pi handoff remains `delivery-uncertain`                   |
| Future terminal/preview bytes   | Endpoint stream, no durable replay by default                          | Reopen/reset explicitly                              | Byte credits and bounded queues; never block control                |

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
| `PendingSessionEventReplay` and replay-result messages                     | One `WatchSession(afterCursor)` stream                                            |
| Gateway live session listener fanout                                       | Direct per-browser runner RPC stream; registry retains only routes/snapshots      |
| Runner `SessionEventRelay` attachment and Promise gates                    | `SessionEvents` history projection, coalesced change PubSub, ephemeral PubSub     |
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
6. One unary RPC and one infinite streaming RPC work in the inverted logical direction.
7. Stream cancellation reaches the runner finalizer.
8. Forced disconnect settles pending effects and permits a clean reconnect.
9. Frame limits, JSON Schema failures, ping timeout, and exact close codes are observed.
10. `deno compile` still produces the standalone Linux runner without a Node runtime requirement.

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

Do not add Bun/npm scripts, a package.json, or Vitest. The repository remains Deno-only.

### Work package 2: atomic runner and gateway replacement

- Replace `SessionProvisioner` ownership with the process-scoped `SessionSupervisor` and replace
  `SessionEventRelay` with `SessionEvents`; do not adapt either service back to old messages.
- Wrap existing `RunnerSessionStore` and Gondolin Promise APIs once at their leaf Effect services;
  use the existing Pi factory directly at the scoped session boundary.
- Install the runner RPC server over `OutboundSocketServer` and implement `IdentifyRunner`,
  `WatchRunner`, `ProvisionSession`, and `WatchSession` directly from the new services.
- Move gateway HTTP ownership to `DenoHttpServer`, mount runner upgrade as an Effect HTTP handler,
  and pass all remaining requests to Remix with `HttpEffect.fromWebHandler`.
- Replace `RunnerConnectionGateway`, `ProvisionCommandOwner`, and `SessionRouteOwner` with the one
  `RunnerRegistry` and the accepted-socket RPC client.
- Replace the replay command plus gateway fanout path with direct per-browser `WatchSession`
  streams, then replace the manual SSE channel with `Stream.toReadableStreamEffect`.
- Remove tuple `Result` from the transport, registry, event, and provisioning core. Delete
  `@openorb/result` only if no unrelated users remain.

### Work package 3: deletion and whole-system verification

Before the cutover is considered reviewable:

- delete version 1 envelopes, parsers, dispatch switches, manifest chunks, heartbeat messages,
  provision responses, replay commands/results, pending maps, relay attachment gates, gateway live
  fanout, the old reconnect loop, and the manual SSE channel;
- search for and reject any old/new switch, compatibility branch, or dead transport owner;
- update `MVP.md` protocol wording to describe only the new path; and
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
- reset for zero, expired, and ahead-of-history cursors;
- no duplicate cursor-bearing event across replay/live boundaries;
- slow browser drops token deltas without blocking Pi;
- durable pressure/gap terminates SSE and resumes from `Last-Event-ID`;
- multiple browsers have independent cancellation/backpressure; and
- runner disconnect closes streams without leaving subscribers or routes.

### Real integration and security tests

- actual Deno WebSocket between runner and gateway;
- enrollment/authentication, invalid token, revocation, reconnect, and gateway restart;
- disconnect before and after provision's durable acceptance boundary;
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
  `IdentifyRunner` admission, stream acknowledgement, cancellation, frame size, and eager-frame
  handling.
- Review Effect source and rerun the API contract tests after every v4 RC upgrade.
- Evaluate the Effect language service separately. Do not introduce Node package tooling solely for
  editor diagnostics in this Deno project.

## Risks and mitigations

### Effect v4/RPC is release-candidate software

**Risk:** API churn or behavior changes during upgrades.

**Mitigation:** exact pins, direct use of exported unstable APIs, source-based review, and the API
contract suite. Accept compile-guided rewrites across runner and gateway when upgrading. Do not pay
a permanent abstraction cost to avoid occasional pre-production rewrites.

### The role inversion depends on a small adapter

**Risk:** Public `SocketServer` lifecycle semantics may not fit an outbound reconnect loop cleanly.

**Mitigation:** prove it before migration. The adapter should only offer the outbound Deno socket to
the supplied handler in a child scope and apply the connection retry schedule. If it starts
implementing authentication, RPC framing, client IDs, or correlation, revise the role arrangement
before the atomic cutover.

### Effect can hide distributed ambiguity if used carelessly

**Risk:** `Effect.retry` makes a non-idempotent call look safe.

**Mitigation:** retry only connection establishment and explicitly classified domain operations.
Keep stable command IDs, journals, Pi reconciliation, and `delivery-uncertain` semantics outside the
transport library.

### A scope can own too much

**Risk:** Closing a WebSocket cancels provisioning or a running Pi session.

**Mitigation:** enforce the documented process/connection/request scope hierarchy. Include a test
that disconnects immediately after durable acceptance and observes the process-owned job continue.

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
3. Browser cancellation demonstrably interrupts and finalizes the matching runner stream.
4. Replacing a connection closes one scope and stale fibers cannot update live registry state.
5. Disconnecting a connection does not cancel process-owned session work.
6. Completed conversation events are recovered only from Pi JSONL and survive notification loss.
7. Slow consumers cannot block Pi or runner control; durable events are replayed rather than
   silently dropped.
8. Authentication/protocol failures do not retry, while transient connection failures use one
   deterministic capped-jitter schedule.
9. Existing catalog, ownership, tombstone, Pi isolation, Git isolation, and secret-redaction tests
   remain green.
10. The old dispatch envelopes, provision owner, replay owner, relay attachment gate, and manual SSE
    channel are deleted.
11. There is no compatibility protocol, old/new feature flag, dual event path, or unstable-API
    insulation wrapper.

As a guardrail, the six current transport/event ownership files total 1,960 lines. The replacement
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
