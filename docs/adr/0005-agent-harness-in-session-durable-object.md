# Host the Agent Harness in a per-Session Durable Object

**Status:** Accepted and implemented (runner protocol 27); runner-side project setup and Git
Snapshots superseded by ADR 0006; the vendored client and the recoverable pause superseded by ADR
0008

Pi Durable moves from the runner host into one gateway Session Durable Object per Session. It keeps
Harness State in that object's SQLite storage and reaches the Agent Environment only through an
Environment Link. Runners keep compute, the Persistent Root Disk, project setup/resume, Git
Snapshots, and guest network mediation, but no longer host agent work, see model credentials, or
store conversation content. This lets agent work, viewing, and published media survive runner
absence. It also lets Session load spread across Durable Objects instead of runner processes and the
single Runners object. This is a clean break: existing runner-hosted Sessions are not migrated, and
the runner protocol is not backward compatible.

This supersedes the agent placement and runner-owned Harness State in ADR 0004, and the runner-owned
media storage in ADR 0003. ADR 0004's lifecycle independence, recovery semantics, and guest-only
file and shell capabilities still hold.

## Environment Link

Agent file and shell operations use a vendored copy of `@earendil-works/pi-env`'s
`RemoteExecutionEnv` client, served by its unmodified static Environment Daemon running inside the
Gondolin guest. Untrusted paths are therefore interpreted only by guest processes, and the
environment conforms to Pi's `ExecutionEnv` contract rather than to a narrower OpenOrb adapter. The
upstream client hard-wires an SSH child-process transport and Node built-ins. Vendoring lets OpenOrb
substitute a WebSocket transport and Web APIs without forking the daemon.

The runner dials a dedicated per-Session WebSocket to the Session Durable Object, authenticated by
its runner token (ADR 0008 removed the one-time attach nonce). It relays daemon frames verbatim.
Revoking a runner closes its Environment Links. Multiplexing over the runner control socket was
rejected. It would route every tool byte through the single Runners object, let large transfers
delay all control traffic, couple every Session's in-flight tools to control-socket reconnects, and
lose WebSocket backpressure across Durable Object RPC.

The link stays open while the Agent Environment runs, and the runner redials it while compute keeps
running. The Session Durable Object accepts it as a hibernatable WebSocket and can sleep while the
agent is idle. Liveness therefore never wakes the object. The relay answers the daemon's pings
locally. Link pings use the Durable Object's automatic WebSocket response. The client sends protocol
pings only while it has requests in flight. Losing the link closes the daemon and kills the
processes it started, as upstream does. Interrupted tools report possible partial execution under
ADR 0004.

## Session ownership

The Session Durable Object owns Stop Session orchestration, including the idle timeout. It aborts
agent work before asking the runner to stop compute (ADR 0008; this ADR first paused the harness
recoverably). Provider credentials are resolved from the Workspace Durable Object inside the gateway
and are never sent to runners. Inline conversation images are served from Harness State. Published
Media is validated by the Session Durable Object and written to an R2 bucket under a Workspace- and
Session-scoped prefix. The object's SQLite storage records Published Media metadata and quota.
Browsers read media only through the authenticated gateway route, including while the runner is
offline.
