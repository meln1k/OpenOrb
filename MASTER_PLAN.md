# OpenOrb Master Plan

> Living reference document for implementation. Update this document whenever a product or architectural decision changes.

## 1. Product summary

OpenOrb is an open-source, self-hostable system for running Pi coding-agent sessions on spare user-owned compute.

A user hosts one control panel, installs runners on Linux machines, and enrolls each runner with only:

```bash
openorb-runner start \
  --control-panel https://openorb.example.com \
  --enrollment-token "$OPENORB_ENROLLMENT_TOKEN"
```

The runners may be on a home network, behind NAT or CGNAT, or on cloud VMs. They never require inbound ports. Each runner creates one Gondolin micro-VM per OpenOrb session, while Pi runs on the trusted runner host and executes its tools through Gondolin.

The primary experience is a responsive web UI for starting, monitoring, reviewing, and continuing remote coding-agent sessions from desktop or mobile.

### Motto

> If you have unused compute at home, you can run an agent on it.

## 2. Product principles

1. **Easy compute enrollment.** A new runner requires the control-panel URL and an enrollment token, not model credentials, Git credentials, VPN setup, or inbound networking.
2. **Outbound-only runners.** Control, terminal, and preview traffic all use connections initiated by the runner.
3. **One session, one VM, one checkout.** This is the isolation and concurrency boundary.
4. **Trusted host, isolated guest.** The runner host is trusted. Agent-generated commands and repository setup scripts run in Gondolin.
5. **Central configuration.** Model credentials, Git credentials, project secrets, project configuration, and defaults live in the control panel.
6. **Automatic lifecycle.** VMs wake when needed and checkpoint after 15 minutes without relevant activity.
7. **Useful remotely.** Chat, tools, diffs, files, terminals, and app previews must work without SSHing into a runner.
8. **Mobile-capable.** The main workflows must be usable from a phone, not merely render on a narrow screen.
9. **Web-standard interfaces.** Use HTTP, SSE, WebSockets, Fetch APIs, and versioned runtime-validated protocol types.
10. **No premature infrastructure.** Do not require an SDN, Kubernetes, Redis, Postgres, or multi-node control plane for the MVP.

## 3. Scope

### 3.1 MVP scope

- Single-user control panel
- Local password authentication and WebAuthn/passkeys
- Multiple outbound-only Linux runners
- Reusable or one-time runner enrollment tokens
- Automatic runner selection with an optional user override before the first prompt
- Per-session CPU and memory requests
- Runner resource reporting and reservation
- One fresh repository checkout and Gondolin VM per session
- Host-side Pi SDK integration
- Central API-key model credentials and custom compatible model definitions
- Linear conversation UI
- Streaming assistant text, thinking, tool calls, and tool results
- Follow-up queue with edit, cancel, and “steer after current turn” actions
- Durable queueing while a pinned runner is offline
- Conversation-only “edit last message”; workspace changes remain
- Aggregate Git diff and changed-file view
- Read-only file browser
- Browser terminal
- Agent- and user-created HTTP previews
- Private previews and optional revocable capability links
- Managed restartable previews and live-only previews
- Central HTTPS Git credentials and SSH private keys
- Agent-initiated Git fetch, commit, and push without exposing credentials to the VM
- User-defined push branch names
- Project `.agents/setup` and `.agents/resume` hooks
- Project `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, `.pi/skills`, and `.pi/prompts`
- Batteries-included Gondolin developer image
- Shared package download caches
- Archive and explicit deletion
- Offline transcript viewing from the control-panel mirror

### 3.2 Explicit non-goals for MVP

- Multi-user or organization tenancy
- Automatic session migration between runners
- High-availability control panel
- Public stable API guarantees
- Tailscale, WireGuard, or another required SDN
- Direct browser-to-runner traffic
- Windows runner support
- First-class macOS runner support
- Containerized runner as the primary installation method
- Full Pi session-tree/branch UI
- Workspace rollback when editing a message
- Local checkout synchronization similar to `amp sync`
- Patch-download workflow
- Model-provider OAuth/subscription logins
- Automatic pull-request creation
- Arbitrary untrusted project Pi extensions
- Memory/process VM snapshots
- GPU scheduling
- Generic TCP preview forwarding

## 4. Terminology

- **Control panel:** The self-hosted Remix web application, API, scheduler, secret store, runner gateway, and preview gateway.
- **Runner:** A native Linux service running Pi, Gondolin, Git operations, and session storage.
- **Project:** Repository configuration, credentials, secrets, defaults, and policies shared by sessions.
- **Session:** One linear user-visible Pi conversation, one checkout, one pinned runner, and one Gondolin VM/checkpoint.
- **Draft session:** A session whose first prompt has not been sent. Its runner selection can still change.
- **Workspace:** The session-specific host checkout mounted at `/workspace` in Gondolin.
- **Turn:** One Pi model response plus its tool calls. One user prompt may produce multiple turns.
- **Run:** All work resulting from an accepted prompt, including retries, compaction, and queued continuations, until Pi is fully settled.
- **Lease:** A reason a VM must remain awake, such as active agent work, a terminal, provisioning, or a preview.
- **Managed preview:** A preview with a restart command that can wake and resume after VM sleep.
- **Live-only preview:** A published port without a restart command; it expires when the VM sleeps.
- **Capability link:** An unlisted, revocable preview URL that grants access without control-panel login.

## 5. Locked product decisions

| Area | Decision |
|---|---|
| Initial audience | Single user on trusted user-owned compute |
| VM mapping | One Gondolin VM per session |
| Pi placement | Pi SDK runs on the runner host |
| Tool execution | Pi read/write/edit/bash operations execute through Gondolin |
| Repository | Fresh clone per session |
| Workspace storage | Host directory mounted into Gondolin with `RealFSProvider` |
| Session placement | Auto-select runner; user may override before first prompt; immutable afterward |
| Resource scheduling | Sessions request CPU and memory; runners advertise total/reserved/free resources |
| Idle lifecycle | Stop/checkpoint after 15 minutes without relevant activity |
| Conversation | Linear UI; Pi tree remains an internal implementation detail |
| Edit last | Conversation-only rewind; do not roll back files or VM state |
| While running | New messages default to follow-up and are visibly queued; user can promote to steering |
| Offline runner | Accept and durably queue prompts until reconnect/startup |
| Model credentials | Centralized in control panel; API keys first |
| Git credentials | Centralized HTTPS tokens and SSH private keys |
| Git push | Agent may push, with credentials mediated outside the guest |
| Commit identity | Global defaults, with room for project overrides |
| Networking | Mediated HTTP/HTTPS by default; internal ranges blocked |
| Previews | Private by default; optional revocable capability access |
| Preview domain | Wildcard preview domain is acceptable |
| Preview lifecycle | Managed previews wake/restart; live-only previews expire on sleep |
| Runner OS | Native Linux first |
| Control UI | Remix 3, end-to-end TypeScript |
| Control DB | SQLite for the single-user control panel |
| Browser streaming | HTTP commands + SSE events + dedicated WebSockets for terminal/preview |
| Runner transport | Separate logical control and binary data channels, both outbound |
| Project customization | Load guidance, skills, and prompts; do not auto-run project Pi extensions |
| Guest image | Batteries-included OpenOrb Gondolin image |
| Caches | Shared package download caches enabled |
| Retention | No automatic deletion; explicit archive and delete |

## 6. High-level architecture

```text
                                      Public Internet

 Browser ───── HTTPS/SSE/WS ─────┐
                                 │
 Preview client ─ HTTPS/WS ──────┼──► Control panel
                                 │    ├── Remix 3 web application
                                 │    ├── Browser HTTP API + SSE
                                 │    ├── Authentication
                                 │    ├── SQLite + encrypted secret store
                                 │    ├── Scheduler and runner registry
                                 │    ├── Runner control gateway
                                 │    ├── Binary tunnel gateway
                                 │    └── Wildcard preview gateway
                                 │
                                 │             ▲
                                 │             │ outbound TLS/WebSockets only
                                 │             │
                                 │          Runner behind NAT
                                 │          ├── Runner identity and heartbeat
                                 │          ├── Session/workspace storage
                                 │          ├── Pi SDK runtime
                                 │          ├── Git service
                                 │          ├── Gondolin lifecycle manager
                                 │          ├── Terminal bridge
                                 │          └── Preview supervisor
                                 │                    │
                                 │                    ▼
                                 │             Gondolin VM
                                 │             ├── /workspace host VFS mount
                                 │             ├── developer toolchain
                                 │             ├── setup/resume hooks
                                 │             ├── managed dev services
                                 │             └── mediated egress/ingress
                                 └────────────────────────────────────────────
```

### 6.1 Why no SDN in MVP

Tailscale or another SDN would add node enrollment, identity, routing, ACL, and deployment complexity. OpenOrb only needs a narrow set of application streams. An outbound reverse tunnel provides those streams without exposing the runner network or requiring a public runner address.

A future `RunnerTransport` abstraction may add an optional direct or SDN-backed data path without changing session, preview, or terminal APIs.

## 7. Repository and package shape

Recommended monorepo shape:

```text
apps/
  control/                 Remix 3 control panel and gateway
  runner/                  published Linux runner CLI/service
packages/
  protocol/                shared runtime schemas and wire types
  domain/                  entities, state types, shared policy
  control-core/            scheduler, commands, events, secret broker
  runner-core/             runner orchestration and command handling
  pi-runtime/              Pi SDK adapter and normalized events
  gondolin-runtime/        VM lifecycle, tools, terminal, preview ingress
  git-service/             clone/status/diff/push and credential mediation
  test-support/            fixtures, fake runner, fake model, protocol harness
images/
  developer/               OpenOrb Gondolin image build configuration
scripts/
  install-runner.*
docs/
  protocol.md
  security.md
  operations.md
MASTER_PLAN.md
```

Use pnpm workspaces and strict TypeScript. Keep Node-specific code behind package boundaries; browser/control HTTP contracts should prefer Web APIs (`Request`, `Response`, `ReadableStream`, `Uint8Array`, Web Crypto).

## 8. Control panel

### 8.1 Technology

- Remix 3 from the `remix` package
- Pin an exact beta release; never track `next` implicitly in lockfiles
- Use Remix 3 conventions rather than Remix v2 conventions
- `app/routes.ts` is the typed URL contract
- Controllers under `app/actions`
- Middleware for auth, sessions, CSRF, database, and request context
- `remix/ui`, not React
- `remix/node-fetch-server` for normal Node HTTP handling
- Explicit Node upgrade handling for WebSockets
- `remix/data-schema` for runtime validation
- Prefer `remix/data-table/sqlite` unless an implementation spike proves it insufficient
- SQLite in WAL mode

Because Remix 3 is under active development, wrap framework-specific persistence and server adapters behind small local interfaces. An exact dependency upgrade must be an intentional implementation task with tests.

### 8.2 Server request split

```text
Node HTTP server
├── preview wildcard host          → PreviewGateway
├── normal HTTP                    → Remix Fetch handler
├── session event SSE              → Remix streaming Response
└── WebSocket upgrade
    ├── /api/runners/control       → RunnerControlGateway
    ├── /api/runners/data          → RunnerDataGateway
    ├── /api/sessions/:id/terminal→ TerminalGateway
    └── preview wildcard host      → PreviewGateway
```

Guest preview content must never be served from the control panel’s origin.

### 8.3 Single-user authentication

- First-run setup creates the single admin user.
- Passwords use Argon2id with current recommended parameters.
- Passkeys use WebAuthn and require HTTPS except for local development.
- Password remains a recovery method unless the user explicitly disables it in a later release.
- Login rotates the browser session ID.
- Cookies are `HttpOnly`, `Secure`, host-only, and `SameSite=Lax` by default.
- State-changing browser operations require CSRF protection.
- Rate-limit login, passkey challenge, capability exchange, and runner enrollment endpoints.

### 8.4 Secret encryption

Secrets include:

- Model API keys
- Git HTTPS tokens
- SSH private keys/passphrases
- Project environment secrets
- Preview capability tokens, stored hashed rather than recoverable

Use envelope-style application encryption:

- A control-panel master key is supplied through `OPENORB_MASTER_KEY` or generated into the persistent control volume on first boot.
- Store the key with filesystem mode `0600`.
- Encrypt values with AES-256-GCM, a random nonce, authenticated metadata, and a key-version field.
- Never derive the server encryption key from the login password; the service must restart unattended.
- Backups are incomplete without the SQLite database and master key.
- Secret values are never returned to the browser after creation; only metadata and a redacted hint are returned.

## 9. Runner bootstrap and identity

### 9.1 Installation target

- Linux x86-64 and ARM64
- Native service, preferably installed with a package or `curl | sh` wrapper
- Node version compatible with Gondolin (currently Node 23.6+)
- QEMU/KVM
- OpenSSH client
- systemd service

The runner package must include a `doctor` command that checks:

- Supported architecture/kernel
- Node version
- QEMU availability/version
- `/dev/kvm` access and hardware virtualization
- Available CPU, memory, and disk
- Ability to reach the control-panel URL
- Gondolin image availability
- Writable runner data directory

### 9.2 Enrollment

1. Runner generates an Ed25519 keypair locally.
2. Runner calls the enrollment endpoint with the PSK, public key, metadata, and capabilities.
3. Control panel stores the public identity and returns a stable runner ID.
4. Private key remains in the runner data directory with mode `0600`.
5. Subsequent control connections authenticate with nonce signing.
6. The shared enrollment PSK is not used as the runner’s ongoing identity.
7. The control panel can revoke one runner without rotating all enrollment tokens.

Support reusable enrollment tokens for homelab convenience and one-time tokens for safer automation.

### 9.3 Outbound connections

Each connected runner maintains two outbound WebSockets:

```text
wss://openorb.example.com/api/runners/control
wss://openorb.example.com/api/runners/data
```

- **Control:** JSON commands, acknowledgments, heartbeats, resource reports, lifecycle events, Pi events, and reconciliation.
- **Data:** Binary multiplexed streams for terminal and preview traffic.

The data connection authenticates using a short-lived channel credential issued over the authenticated control connection. It reconnects independently so bulk traffic cannot delay control recovery.

## 10. Runner storage

Recommended layout:

```text
/var/lib/openorb-runner/
  runner.json
  identity/
    ed25519.key
  runner.db
  images/
  caches/
    npm/
    pnpm/
    yarn/
    pip/
    uv/
  sessions/
    <session-id>/
      metadata.json
      workspace/
      pi/
        session.jsonl
        agent/
      vm/
        checkpoint.qcow2
      runtime/
        services/
        logs/
      spool/
        events.db
      git/
        state.json
```

The runner is authoritative for:

- Raw Pi JSONL
- Working tree and Git objects
- Full file contents
- VM checkpoint
- Guest service logs
- Local command/event idempotency journal

The control panel is authoritative for:

- Projects and configuration
- Credentials and secrets
- Runner identities and revocation
- Session metadata and pinned runner
- Pending user messages
- Normalized completed conversation/tool records
- Preview access policy and capability hashes

## 11. Domain model

### 11.1 Project

```ts
interface Project {
  id: string
  name: string
  repository: {
    url: string
    defaultRef: string
    credentialId?: string
  }
  defaults: {
    provider: string
    modelId: string
    thinkingLevel: ThinkingLevel
    cpuCount: number
    memoryMiB: number
  }
  git: {
    authorName?: string
    authorEmail?: string
    defaultBranchPattern: string
    allowAgentPush: boolean
  }
  networkPolicy: {
    mode: "mediated-https"
    allowedHosts?: string[]
    allowedInternalHosts?: string[]
  }
  idleTimeoutSeconds: number
  createdAt: string
  updatedAt: string
}
```

Global Git author defaults are required. Project values may override them later without changing the core model.

### 11.2 Runner

```ts
interface Runner {
  id: string
  name: string
  status: "online" | "offline" | "draining" | "revoked"
  platform: {
    os: "linux"
    arch: "x64" | "arm64"
    kernel: string
  }
  versions: {
    runner: string
    protocol: number
    pi: string
    gondolin: string
    node: string
    qemu: string
  }
  labels: Record<string, string>
  resources: RunnerResources
  capabilities: RunnerCapabilities
  lastHeartbeatAt?: string
}
```

### 11.3 Session

```ts
interface Session {
  id: string
  projectId: string
  runnerId?: string
  title?: string
  ref: string
  baseCommit?: string
  branchName: string
  branchPushed: boolean
  model: ModelSelection
  resources: {
    cpuCount: number
    memoryMiB: number
  }
  runtime: SessionRuntimeState
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
```

### 11.4 Orthogonal runtime state

Do not create one giant state enum. Represent independent dimensions:

```ts
interface SessionRuntimeState {
  lifecycle: "draft" | "active" | "archived" | "error"
  provisioning:
    | "pending"
    | "reserving"
    | "cloning"
    | "starting-vm"
    | "setup"
    | "ready"
    | "failed"
  runner: "unassigned" | "online" | "offline" | "revoked"
  vm:
    | "absent"
    | "starting"
    | "running"
    | "checkpointing"
    | "sleeping"
    | "failed"
  agent: "idle" | "running" | "aborting" | "failed"
  git: "clean" | "dirty" | "pushing" | "failed"
}
```

### 11.5 Preview

```ts
type PreviewConfig =
  | {
      mode: "managed"
      name: string
      port: number
      command: string
      cwd: string
      readinessPath: string
    }
  | {
      mode: "live"
      name: string
      port: number
    }

interface Preview {
  id: string
  sessionId: string
  hostname: string
  access: "private" | "capability"
  state: "starting" | "ready" | "sleeping" | "expired" | "failed"
  config: PreviewConfig
  lastActivityAt?: string
}
```

### 11.6 Queued message

```ts
type QueuedMessageState =
  | "waiting-for-runner"
  | "waiting-for-capacity"
  | "waiting-for-agent"
  | "steering"
  | "delivered"
  | "cancelled"

interface QueuedMessage {
  id: string
  sessionId: string
  clientRequestId: string
  content: ContentBlock[]
  delivery: "follow-up" | "steer"
  state: QueuedMessageState
  createdAt: string
}
```

## 12. Resource scheduling

### 12.1 Heartbeat

Runners periodically report actual allocatable capacity:

```ts
interface RunnerHeartbeat {
  observedAt: number
  resources: {
    cpu: { total: number; reserved: number; free: number }
    memoryMiB: { total: number; reserved: number; free: number }
    diskMiB: { total: number; free: number }
    runningVms: number
    sleepingSessions: number
  }
  sessions: Array<{
    sessionId: string
    vmState: SessionRuntimeState["vm"]
    cpuCount: number
    memoryMiB: number
  }>
}
```

### 12.2 Placement

1. Filter online, non-draining runners by protocol/capability compatibility.
2. Filter by requested CPU, memory, disk safety threshold, labels, and architecture requirements.
3. Honor an explicit draft runner selection if it can accept the request.
4. Otherwise score candidates by free-resource ratio and current running VM count.
5. Send `session.reserve` to the selected runner.
6. Runner re-checks local resources authoritatively.
7. Reservation expires after a short TTL if provisioning does not start.
8. On rejection, try the next candidate.
9. Once provisioning starts, persist the pinned runner permanently.

A heartbeat is advisory; reservation acceptance is authoritative.

### 12.3 Sleeping sessions

Sleeping sessions consume disk but do not reserve CPU or memory. On wake, the pinned runner must reacquire resources. If unavailable:

- Keep the prompt queued as `waiting-for-capacity`.
- Show the condition in the UI.
- Do not migrate automatically.
- Retry when subsequent heartbeats show capacity.
- For previews, show a temporary unavailable/waiting response rather than routing elsewhere.

## 13. Session lifecycle

### 13.1 Draft and first prompt

1. User chooses project, ref, model, thinking level, CPU, memory, and optional branch name.
2. Scheduler displays the currently selected automatic runner.
3. User may override the runner while drafting.
4. Sending the first prompt creates a durable queued message and starts reservation.
5. Runner assignment becomes immutable after reservation/provisioning succeeds.
6. Runner clones the repository and records the exact base commit.
7. Runner creates the local working branch.
8. Runner boots Gondolin with requested resources and mounts the workspace.
9. Runner runs `.agents/setup` once.
10. Runner creates the persistent Pi session and dispatches the first message.

Provisioning logs stream to the browser as session events.

### 13.2 Subsequent prompt

1. Control panel accepts the prompt with a unique `clientRequestId`.
2. If runner is offline, keep it in `waiting-for-runner`.
3. If VM is sleeping, request resources and resume the checkpoint.
4. Recreate transient Gondolin policy, mounts, ingress, and secret placeholders.
5. Run `.agents/resume`.
6. Open Pi’s existing JSONL session.
7. Dispatch the message.
8. Stream normalized Pi events.
9. When Pi is fully settled, update Git status/diff summary.
10. If no active lease remains, start the idle timer.

### 13.3 Message while running

- Default to Pi follow-up delivery.
- Render the message as a queued UI element immediately.
- Permit editing and cancellation until delivery.
- “Steer after turn” promotes it to Pi’s steering queue.
- Preserve ordering among messages with the same delivery class.
- Do not send extension commands through the queue unless explicitly supported later.

### 13.4 Edit last message

Allowed only when:

- Agent is idle
- There are no already-delivered later user messages
- The target is the last visible user message

Implementation uses Pi’s internal tree/session APIs to move the active conversation path before the last prompt and append the edited prompt. The abandoned response remains in raw Pi history but is hidden from the linear OpenOrb UI.

**Workspace and VM changes are not reverted.** The UI must say that the retry runs on the current workspace.

### 13.5 Idle and sleep

A session starts a configurable 15-minute timer when no lease is active.

Lease types:

- `provisioning`
- `agent`
- `terminal`
- `managed-preview`
- `live-preview`
- `maintenance`

Relevant activity resets the timer:

- Prompt/steering work
- Terminal input/output
- Preview HTTP requests
- Preview WebSocket traffic
- Setup/resume work

At timeout:

1. Stop accepting new live-only preview streams.
2. Mark live-only previews expired.
3. Stop managed services cleanly with a short deadline.
4. Close terminal sessions.
5. Flush guest filesystems.
6. Create a disk checkpoint; this consumes/stops the current Gondolin VM.
7. Persist checkpoint metadata and set VM state to `sleeping`.

Gondolin checkpoints are disk-only. Processes and RAM do not survive.

### 13.6 Archive and delete

Archive:

- Stop/checkpoint the VM.
- Expire preview access.
- Hide the session from the active list.
- Retain transcript, checkout, Pi JSONL, checkpoint, and logs.

Delete:

- Require explicit confirmation.
- Revoke preview capability links.
- Remove control-panel transcript/tool/session records.
- Send idempotent deletion to the runner when online.
- Runner removes checkout, Pi JSONL, checkpoint, logs, and spooled events.
- If runner is offline, retain a deletion tombstone until acknowledged.

## 14. Pi integration

### 14.1 SDK usage

Use `@earendil-works/pi-coding-agent` directly rather than spawning RPC mode.

The adapter owns:

- `ModelRuntime`
- Persistent `SessionManager`
- `AgentSession`/runtime creation
- Event subscription
- Prompt, follow-up, steering, abort, model, and thinking operations
- Compaction/retry state
- Session disposal and restoration

Use runtime API keys (`ModelRuntime.setRuntimeApiKey`) so provider credentials remain in runner memory and are never written to a Pi `auth.json`.

### 14.2 Tool replacement

Replace Pi’s built-in tools with Gondolin-backed operations, following Gondolin’s existing Pi example:

- `read`
- `write`
- `edit`
- `bash`
- Any enabled grep/find/list helpers
- User shell commands

All paths map from the host session workspace to `/workspace` and reject escapes.

### 14.3 Resource loading

Load:

```text
AGENTS.md
CLAUDE.md
.agents/skills/**
.pi/skills/**
.pi/prompts/**
```

Do not automatically load:

```text
.pi/extensions/**
```

A custom or filtered Pi resource loader must enforce this. Project-local executable extensions would run on the trusted runner host and bypass Gondolin.

A future centrally managed **Agent Profile** may contain trusted global skills, prompts, and host extensions distributed by the control panel.

Any scripts bundled with project skills execute only when invoked through Gondolin-backed tools.

### 14.4 Event normalization

Normalize Pi events for the browser while preserving Pi identifiers:

```ts
type SessionEvent =
  | { type: "session.state"; state: SessionRuntimeState }
  | { type: "assistant.text.delta"; messageId: string; delta: string }
  | { type: "assistant.thinking.delta"; messageId: string; delta: string }
  | { type: "assistant.message.completed"; message: AssistantMessage }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.updated"; toolCallId: string; output: ToolOutput }
  | { type: "tool.completed"; toolCallId: string; result: ToolResult }
  | { type: "queue.changed"; queued: QueuedMessage[] }
  | { type: "usage.changed"; usage: SessionUsage }
  | { type: "workspace.changed"; summary: DiffSummary }
  | { type: "preview.changed"; preview: Preview }
  | { type: "runner.changed"; runner: RunnerSummary }
```

Persist completed semantic records, not every token delta. Live deltas are relay traffic. On reconnect, reload completed state and resume the live stream.

Use Pi’s fully settled event when available. Do not sleep on a low-level `turn_end` or retryable `agent_end`.

## 15. Gondolin integration

### 15.1 VM shape

- QEMU backend first
- Requested CPU and memory passed to Gondolin/QEMU
- One VM object at a time per active session
- Session label includes OpenOrb session ID
- Root disk checkpoint stored per session
- `/workspace` uses `RealFSProvider(sessionWorkspace)`
- Cache paths use separate host-backed providers
- Runtime/service logs use a session runtime mount
- Internal ranges blocked by default
- HTTP/HTTPS mediated through host hooks
- Generic TCP denied except explicit mappings and SSH Git proxy

### 15.2 Checkpoint constraints

- Disk-only; no memory or process restoration
- Captures root disk only
- Does not capture VFS mounts
- Does not capture tmpfs-backed paths such as `/root`, `/tmp`, `/var/log`
- Requires matching Gondolin guest assets/build ID
- Resume creates a new VM object

Setup documentation must tell projects not to rely on checkpoint persistence under tmpfs-backed paths.

### 15.3 Setup hooks

- Run executable `.agents/setup` once after a fresh clone and initial boot.
- Capture stdout/stderr into session logs and stream them as provisioning events.
- Fail provisioning visibly on non-zero exit.
- Run executable `.agents/resume` on every wake before Pi continues.
- Use a bounded blocking period; surface failure rather than silently continuing.
- Hooks execute inside Gondolin from `/workspace`.

### 15.4 Developer image

Gondolin currently builds Alpine images, so the initial OpenOrb image should be a batteries-included Alpine developer environment containing at least:

- Bash and coreutils
- Git and OpenSSH
- curl/wget and CA certificates
- ripgrep, jq, file, tar, unzip, zstd
- Node.js and npm/corepack/pnpm/Yarn
- Python, pip, and uv if practical
- C/C++ build toolchain, make, pkg-config
- `gh`
- SQLite client
- Process/service supervision utility
- Common network/process debugging utilities
- `sshd` and Gondolin guest helpers

Image builds must be versioned and reproducible. Runner heartbeats report supported image build IDs. Checkpoint resume requires the matching image.

### 15.5 Shared caches

Mount download caches outside the workspace. Do not share installed project dependency directories by default.

Candidate mounts:

```text
/openorb-cache/npm
/openorb-cache/pnpm
/openorb-cache/yarn
/openorb-cache/pip
/openorb-cache/uv
```

Cache mounts improve fresh-session setup while preserving per-session checkouts and installed dependencies.

## 16. Model providers

### 16.1 MVP authentication

Support:

- API-key providers supported by Pi
- Custom OpenAI-compatible endpoints
- Custom Anthropic-compatible endpoints
- Central custom model definitions and overrides

Defer OAuth/subscription credentials because refresh-token concurrency and provider-specific login flows materially increase complexity.

### 16.2 Distribution

1. Control panel stores encrypted provider configuration.
2. Browser lists only redacted metadata.
3. On run start, control panel sends only the selected provider/model configuration to the pinned runner over the authenticated control channel.
4. Runner keeps credentials in memory.
5. Runner configures Pi `ModelRuntime` at runtime.
6. Model credentials never enter Gondolin.
7. Runner reports Pi/model catalog compatibility; the control panel hides unsupported model choices.

## 17. Git and repository handling

### 17.1 Clone

- Clone on the trusted runner host into the session workspace.
- Resolve and store the exact base commit.
- Create a session working branch.
- Default branch pattern:

```text
openorb/<sanitized-session-name>-<short-session-id>
```

- User may provide a custom branch name.
- Branch can change until its first successful push; afterward it is fixed for the session.

### 17.2 HTTPS credentials without guest exposure

For host clone/fetch operations:

- Use an ephemeral `GIT_ASKPASS` process/script.
- Do not write credentials into `.git/config`, command arguments, or global Git config.
- Remove temporary material immediately.

For Git commands inside Gondolin:

1. A guest credential helper returns generated placeholder username/token values.
2. Git encodes placeholders into HTTP authorization headers.
3. Gondolin host hooks substitute the real secret only for the configured Git host.
4. Request policy restricts host and repository URL path where feasible.
5. The guest can print only placeholders, never the real token.

### 17.3 SSH credentials without guest exposure

- SSH private key is decrypted only on the trusted runner.
- Configure Gondolin’s host-side SSH proxy with the key and known-host policy.
- Use `execPolicy` to allow only Git operations for the configured repository.
- Permit `git-upload-pack` and `git-receive-pack` for the project repository.
- Deny interactive SSH, SFTP, and unrelated repositories.

### 17.4 Commit and push

The agent may inspect history, create branches, commit, fetch, and push. System guidance says to push only when the user explicitly requests it.

The control-panel **Commit & Push** action:

1. Refreshes aggregate diff/status.
2. Preserves existing agent-created commits.
3. If dirty, creates a commit using global Git author defaults and a user-supplied/default message.
4. Pushes to the selected branch and sets upstream.
5. Records the resulting remote ref and commit IDs.

Never issue force flags from OpenOrb-owned UI/actions. Best-effort command policy should detect obvious force pushes, but true enforcement belongs in remote branch protection because raw Git protocol intent is difficult to police reliably at the HTTP/SSH transport boundary.

No patch download is part of the primary workflow.

## 18. Terminal

### 18.1 Browser side

- xterm.js integrated through a Remix 3 client entry
- Dedicated WebSocket per terminal
- Full-screen mobile terminal mode
- Input, output, resize, and signal controls
- Reconnect gives a new shell unless a future persistent terminal service is added

### 18.2 Runner/guest side

Do not hold Gondolin’s serialized `vm.exec` channel with a long-running interactive shell. Use:

1. `vm.enableSsh()` on loopback only.
2. Runner launches a local OpenSSH client under a PTY (for example, `node-pty`).
3. Terminal bytes are tunneled over the outbound runner data channel.
4. SSH forwarding and agent forwarding remain disabled.
5. Terminal activity acquires and refreshes a VM lease.

The runner itself exposes no terminal listener to the network.

## 19. Previews and portals

### 19.1 External behavior

OpenOrb previews emulate the useful behavior of Amp Portals while supporting NATed user-owned runners:

```text
Browser
  → wildcard preview gateway on control panel
  → outbound runner data tunnel
  → runner-local Gondolin ingress
  → guest loopback dev-server port
```

Unlike Amp’s managed E2B network, OpenOrb cannot route over an operator-owned internal node network. The reverse tunnel is the data path.

### 19.2 Wildcard domain

Configuration example:

```text
Control panel: app.openorb.example.com
Preview base:  *.preview.openorb.example.com
```

Each preview uses a unique hostname:

```text
p-<random-id>.preview.openorb.example.com
```

Require wildcard DNS and TLS. A path-based fallback is not a primary target because many dev servers assume they own `/`, use absolute URLs, or need stable WebSocket/HMR paths.

### 19.3 Private preview authentication

- Control-panel session cookie is host-only and never sent to preview hosts.
- Unauthenticated preview request redirects to the control panel for authorization.
- Control panel creates a short-lived, single-use authorization code.
- Preview host exchanges it for an `HttpOnly`, `Secure`, exact-host preview cookie.
- Remove codes/tokens from the visible URL via redirect.
- Gateway strips the OpenOrb preview-auth cookie before forwarding to the guest.
- Preserve unrelated application cookies used by the previewed app.
- Unique hostnames isolate preview origins from each other and from the control UI.

### 19.4 Capability access

- Generate a high-entropy token.
- Store only its hash.
- Exchange the token for an exact-host preview cookie, then redirect to a clean URL.
- Allow explicit revocation and regeneration.
- Rate-limit capability exchange and wake attempts.
- Valid capability access may wake a managed preview.

### 19.5 Managed preview

```ts
{
  mode: "managed",
  name: "Web app",
  command: "pnpm dev",
  cwd: "/workspace",
  port: 3000,
  readinessPath: "/"
}
```

- Created by the Pi `publish_preview` tool or UI.
- Runner starts the command through a guest service supervisor and returns promptly.
- Configure `vm.enableIngress()` and `vm.setIngressRoutes()`.
- HTTP and WebSocket supported.
- Keeps VM awake while active; sleeps after inactivity.
- On request while sleeping: reserve resources, resume, run `.agents/resume`, restart command, wait for readiness, and proxy.
- Use a bounded readiness timeout and return a useful failure page/log link.

### 19.6 Live-only preview

```ts
{
  mode: "live",
  name: "Port 3000",
  port: 3000
}
```

- Publishes an already-running port.
- Keeps the VM awake while active.
- Expires when the VM sleeps because the process command is unknown.
- Later requests return `410 Preview expired`.
- Manual terminal “Publish port” defaults to live-only unless the user supplies a restart command.

### 19.7 Preview gateway safety

The tunnel must not become an SSRF proxy into the runner’s host or LAN.

A preview request may target only:

- A registered preview ID
- Its owning session
- Its pinned authenticated runner
- Its registered guest port
- The runner-local Gondolin ingress handle for that VM

Never accept arbitrary runner-side hostnames or ports from a browser request.

## 20. Browser API

The browser API is internal and may evolve before a stable public API is declared. It still uses shared runtime schemas and explicit response types.

### 20.1 Authentication

```http
POST   /auth/setup
POST   /auth/login
POST   /auth/logout
POST   /auth/passkeys/register/options
POST   /auth/passkeys/register/verify
POST   /auth/passkeys/login/options
POST   /auth/passkeys/login/verify
GET    /auth/passkeys
DELETE /auth/passkeys/:credentialId
```

### 20.2 Projects

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
```

### 20.3 Model providers and credentials

```http
GET    /api/model-providers
POST   /api/model-providers
PATCH  /api/model-providers/:providerId
DELETE /api/model-providers/:providerId
POST   /api/model-providers/:providerId/test
GET    /api/models

GET    /api/git-credentials
POST   /api/git-credentials
PATCH  /api/git-credentials/:credentialId
DELETE /api/git-credentials/:credentialId
POST   /api/git-credentials/:credentialId/test
```

### 20.4 Runners

```http
GET    /api/runners
GET    /api/runners/:runnerId
PATCH  /api/runners/:runnerId
POST   /api/runners/:runnerId/drain
POST   /api/runners/:runnerId/revoke
POST   /api/runner-enrollment-tokens
GET    /api/runner-enrollment-tokens
DELETE /api/runner-enrollment-tokens/:tokenId
```

### 20.5 Sessions

```http
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:sessionId
PATCH  /api/sessions/:sessionId
POST   /api/sessions/:sessionId/archive
DELETE /api/sessions/:sessionId
```

Create draft input:

```ts
interface CreateSessionInput {
  projectId: string
  ref?: string
  runnerId?: string
  model: ModelSelection
  resources: { cpuCount: number; memoryMiB: number }
  branchName?: string
}
```

### 20.6 Conversation and queue

```http
GET    /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/abort
POST   /api/sessions/:sessionId/edit-last
GET    /api/sessions/:sessionId/queue
PATCH  /api/sessions/:sessionId/queue/:messageId
DELETE /api/sessions/:sessionId/queue/:messageId
POST   /api/sessions/:sessionId/queue/:messageId/steer
GET    /api/sessions/:sessionId/events?after=<cursor>
```

Message input:

```ts
interface SendMessageInput {
  clientRequestId: string
  content: ContentBlock[]
  delivery?: "follow-up" | "steer"
}
```

Return `202 Accepted` once the message is durably queued, not only after runner execution.

### 20.7 Workspace and Git

```http
GET  /api/sessions/:sessionId/diff
GET  /api/sessions/:sessionId/files?path=<relative-path>
GET  /api/sessions/:sessionId/file?path=<relative-path>
GET  /api/sessions/:sessionId/git/status
POST /api/sessions/:sessionId/git/commit
POST /api/sessions/:sessionId/git/push
```

All paths are relative, normalized, symlink-safe, and constrained to the session workspace.

### 20.8 Previews

```http
GET    /api/sessions/:sessionId/previews
POST   /api/sessions/:sessionId/previews
DELETE /api/sessions/:sessionId/previews/:previewId
POST   /api/sessions/:sessionId/previews/:previewId/share
DELETE /api/sessions/:sessionId/previews/:previewId/share
```

### 20.9 Terminal

```text
wss://openorb.example.com/api/sessions/:sessionId/terminal
```

```ts
type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: "SIGINT" | "SIGTERM" }
```

Use binary frames for output where practical.

## 21. SSE event delivery

```http
GET /api/sessions/:sessionId/events?after=184
Accept: text/event-stream
```

Requirements:

- Monotonic per-session durable event cursor
- Support `Last-Event-ID`
- Send periodic keepalives
- Reload completed state after cursor expiration/compaction
- Do not persist every token delta
- Coalesce high-frequency live deltas
- Persist completed messages, completed tool results, lifecycle transitions, queue transitions, previews, and usage summaries
- Browser reconnect must not duplicate completed messages

The session list may use a separate lightweight global SSE stream for runner/session status, or poll initially. Do not overload every session stream with unrelated status.

## 22. Runner control protocol

### 22.1 Versioned envelope

```ts
interface ProtocolEnvelope<T> {
  version: 1
  id: string
  type: string
  timestamp: number
  correlationId?: string
  sessionId?: string
  payload: T
}
```

Handshake includes protocol range and feature capabilities. Reject incompatible major versions with an actionable runner upgrade message.

### 22.2 Runner-to-control messages

```text
runner.hello
runner.heartbeat
runner.reconcile
runner.event.batch
runner.command.result
runner.preview.register
runner.preview.update
runner.error
```

### 22.3 Control-to-runner commands

```text
session.reserve
session.release-reservation
session.provision
session.prompt
session.steer
session.abort
session.wake
session.sleep
session.archive
session.delete
session.set-model
session.set-thinking

git.commit
git.push
workspace.refresh-status

terminal.open
terminal.resize
terminal.close

preview.create
preview.stop
preview.wake
```

### 22.4 Idempotency

- Every command has a stable ID.
- Runner persists command receipt and terminal outcome before acknowledging.
- Replayed prompt commands must not send the prompt twice.
- Replayed push commands must not push twice unintentionally.
- Control panel stores command state and retries only idempotently.
- `clientRequestId` is unique per session for user messages.
- Reconciliation resolves commands left ambiguous by disconnects.

### 22.5 Offline reconciliation

On reconnect, runner reports:

- Known sessions and local states
- Active VM IDs
- Pi session file identity and last durable event cursor
- Pending/finished command journal entries
- Git branch/head/dirty summary
- Preview/service state
- Resource usage

Control panel then:

- Marks missing runner-local sessions as errors, never silently recreates them
- Replays unacknowledged idempotent commands
- Delivers queued messages in order
- Applies deletion tombstones
- Imports missed durable event batches

## 23. Runner binary data protocol

### 23.1 Logical frame types

```ts
type TunnelFrame =
  | {
      type: "open"
      channelId: string
      kind: "preview-http" | "preview-websocket" | "terminal"
      metadata: unknown
    }
  | {
      type: "data"
      channelId: string
      sequence: number
      data: Uint8Array
    }
  | {
      type: "window-update"
      channelId: string
      availableBytes: number
    }
  | { type: "end"; channelId: string }
  | { type: "reset"; channelId: string; reason: string }
```

Define an exact compact binary encoding in `docs/protocol.md` before implementation. Keep metadata small and runtime validated.

### 23.2 Requirements

- Per-channel flow control and bounded buffers
- Fair scheduling so one preview cannot starve terminal traffic
- Channel and connection byte limits
- Request body and header limits
- Backpressure propagated to browser/HTTP streams
- Independent channel cancellation
- Connection-level ping/pong and idle detection
- Preview HTTP and WebSocket support
- No arbitrary runner network destinations
- Metrics for open channels, bytes, resets, and stalls

The control channel must remain usable even if the data channel is saturated or reconnecting.

## 24. Internal runner interfaces

```ts
interface AgentRuntime {
  start(config: AgentSessionConfig): Promise<void>
  prompt(input: AgentPrompt): Promise<void>
  followUp(input: AgentPrompt): Promise<void>
  steer(input: AgentPrompt): Promise<void>
  editLast(input: AgentPrompt): Promise<void>
  abort(): Promise<void>
  setModel(model: ModelSelection): Promise<void>
  subscribe(listener: (event: AgentEvent) => void): () => void
  dispose(): Promise<void>
}
```

```ts
interface VmManager {
  ensureRunning(reason: WakeReason): Promise<RunningVm>
  acquireLease(type: LeaseType): Promise<VmLease>
  checkpointAndStop(): Promise<void>
  getState(): SessionRuntimeState["vm"]
}
```

```ts
interface GitService {
  clone(config: CloneConfig): Promise<CloneResult>
  status(): Promise<GitStatus>
  diff(): Promise<WorkspaceDiff>
  commit(input: CommitInput): Promise<CommitResult>
  push(branch: string): Promise<PushResult>
}
```

```ts
interface PreviewManager {
  publish(config: PreviewConfig): Promise<Preview>
  openHttpStream(previewId: string, request: TunnelRequest): Promise<TunnelResponse>
  openWebSocket(previewId: string, request: TunnelRequest): Promise<TunnelStream>
  stop(previewId: string): Promise<void>
}
```

```ts
interface WorkspaceService {
  list(path: string): Promise<FileEntry[]>
  read(path: string): Promise<File>
  diff(): Promise<WorkspaceDiff>
}
```

```ts
interface RunnerTransport {
  connect(): Promise<void>
  sendControl(message: ProtocolEnvelope<unknown>): Promise<void>
  openDataChannel(input: OpenChannel): Promise<DataChannel>
  close(): Promise<void>
}
```

These boundaries allow Pi, Gondolin, Git, and transport details to be tested independently.

## 25. Control-panel persistence model

Initial SQLite tables should cover:

- `users`
- `password_credentials`
- `webauthn_credentials`
- `browser_sessions`
- `encrypted_secrets`
- `model_providers`
- `git_credentials`
- `projects`
- `project_secrets`
- `runners`
- `runner_enrollment_tokens`
- `runner_commands`
- `sessions`
- `queued_messages`
- `messages`
- `tool_calls`
- `session_events`
- `previews`
- `preview_capabilities`
- `audit_events`
- `deletion_tombstones`

Guidelines:

- UUIDv7 or another time-sortable random identifier for primary entities
- Foreign keys enabled
- WAL mode
- Explicit migrations committed to source
- Secret ciphertext separate from searchable metadata
- Unique `(session_id, client_request_id)`
- Unique durable event cursor per session
- Unique runner command ID
- Store timestamps in UTC
- Bounded retention for verbose tool updates; completed records retained with session

## 26. UI and information architecture

### 26.1 Desktop

```text
┌─────────────────┬─────────────────────────────┬─────────────────────┐
│ Sessions        │ Conversation                │ Context             │
│                 │                             │                     │
│ Project/ref     │ Streaming assistant output  │ Changes             │
│ Status          │ Thinking (collapsed)        │ Files               │
│ Runner          │ Tool calls/results          │ Terminal            │
│ Resource size   │ Queued follow-ups           │ Previews            │
│                 │ Composer + model controls   │ Session details     │
└─────────────────┴─────────────────────────────┴─────────────────────┘
```

### 26.2 Mobile

- Conversation is the primary screen.
- Session list is a drawer.
- Bottom navigation: Chat, Changes, Files, Terminal, Preview.
- Model, thinking level, CPU/memory, and draft runner selection live in a composer/settings sheet.
- Runner selector becomes read-only after first send.
- Terminal can enter dedicated full-screen mode.
- Queued follow-ups remain visible and actionable.
- Preview opens in a new tab or dedicated embedded frame depending on browser limitations.

### 26.3 Session status communication

Always distinguish:

- Waiting for runner
- Waiting for runner capacity
- Provisioning clone
- Running setup
- Waking VM
- Agent running
- Follow-up queued
- Idle, VM awake
- Sleeping
- Runner offline
- Failed with retryable/non-retryable reason

Do not collapse these into a generic spinner.

## 27. Security model

### 27.1 Trust boundaries

Trusted:

- Control panel host
- Enrolled runner host
- Single authenticated user

Untrusted or constrained:

- Model-generated commands
- Repository contents
- Setup/resume scripts
- Previewed applications
- Capability-link holders beyond their preview scope
- Browser input and runner protocol input until validated

### 27.2 Key rules

- No inbound runner ports.
- All runner traffic uses authenticated outbound TLS.
- Model credentials remain control-panel/runner-side and never enter Gondolin.
- Git credentials remain control-panel/runner-side; guest sees placeholders or an SSH proxy.
- Project secrets use Gondolin placeholder substitution scoped to allowed destinations.
- Project Pi extensions do not execute on the runner host.
- Workspace path APIs reject traversal and symlink escape.
- Preview hosts are origin-isolated from control UI and one another.
- Preview gateway strips OpenOrb auth material before guest forwarding.
- Tunnel destinations are registered guest ports only.
- Internal IP ranges and cloud metadata remain blocked by default.
- Control and runner protocol messages are runtime validated.
- Sensitive values are redacted from logs and error messages.

### 27.3 Mediated project secrets

Project secrets are centrally encrypted. When a VM needs them:

- Runner generates guest placeholder values.
- Real values remain in host memory.
- Gondolin substitutes only in supported outbound HTTP headers for configured hosts.
- Do not claim mediation works for arbitrary protocols or secrets embedded in request bodies.
- Explicitly mapped TCP does not receive HTTP secret substitution.
- SSH secrets use Gondolin’s SSH proxy, not environment injection.

## 28. Observability

### 28.1 Structured logs

Control and runner logs include:

- Component
- Runner/session/project IDs
- Command/correlation ID
- Event type
- Duration
- Error category

Never log prompts or tool output by default at infrastructure log level; those belong to session records with user-controlled retention. Never log secrets or placeholder mappings.

### 28.2 Metrics

Control panel:

- Connected runners
- Runner reconnects
- Command latency/failures
- SSE connections
- Tunnel channels/bytes/resets
- Preview wake latency
- Scheduler reservation rejection rate
- SQLite write latency

Runner:

- CPU/memory/disk total and free
- Running VMs and sleeping sessions
- VM start/resume/checkpoint duration
- Pi run duration and failures
- Setup/resume duration
- Git operation duration
- Open terminal/preview channels
- Event spool backlog

### 28.3 Audit events

Record:

- Login and passkey changes
- Secret/provider/Git credential changes
- Runner enrollment/revocation
- Session creation/archive/delete
- Preview capability creation/revocation
- Git pushes
- Agent model changes

## 29. Failure handling

### Runner disconnect

- Mark runner offline after heartbeat timeout.
- Preserve transcript and queued messages.
- Do not reassign pinned sessions.
- Private/capability previews return runner-offline status.
- Reconcile commands and events after reconnect.

### Control-panel restart

- Runner reconnects automatically with exponential backoff and jitter.
- Commands are recovered from SQLite.
- Browser SSE reconnects using cursor.
- Runner command journal prevents duplicate execution.

### VM start/resume failure

- Preserve checkpoint and diagnostics.
- Mark VM failed without deleting data.
- Surface image/backend/build-ID mismatch distinctly.
- Permit explicit retry after remediation.

### Setup/resume failure

- Stop before dispatching the prompt.
- Stream logs and show the exact failed hook.
- Permit terminal access when safe for repair.
- User may retry provisioning/resume.

### Pi/model failure

- Preserve Pi JSONL and normalized completed events.
- Surface provider errors and retry status.
- Respect Pi’s retry/compaction lifecycle before declaring the run settled.

### Tunnel failure

- Reset only the affected logical channel.
- Keep the control channel alive.
- Bound buffers and cancel upstream work on browser disconnect.

### Disk pressure

- Runner advertises disk safety threshold.
- Refuse new reservations before exhaustion.
- Never auto-delete sessions.
- Show per-session and runner disk use.
- Allow archive/delete cleanup from the UI.

## 30. Testing strategy

### 30.1 Unit tests

- Runtime protocol schema validation
- Scheduler scoring and reservation fallback
- Resource accounting
- Session state transitions
- Queue ordering/promotion/cancellation
- Path normalization and symlink escape protection
- Preview auth/capability exchange
- Secret encryption/redaction
- Git URL/repository policy
- Pi event normalization
- Binary channel flow control

### 30.2 Contract tests

- Control ↔ runner handshake across protocol versions
- Command idempotency after dropped acknowledgments
- Event batch deduplication
- Runner reconciliation
- Binary open/data/window/end/reset behavior
- SSE cursor reconnect
- Preview HTTP header/body streaming
- Preview WebSocket tunneling

### 30.3 Integration tests

Use real Pi SDK with a fake deterministic model where possible and real Gondolin/QEMU in Linux CI where available.

Scenarios:

- Enroll runner behind an outbound-only network boundary
- Clone public HTTPS repository
- Clone/push private HTTPS repository with guest-visible placeholder only
- Clone/push private SSH repository through Gondolin proxy
- Provision setup hook
- Prompt → tools → settled → sleep → wake → continue
- Follow-up queue and steering promotion
- Offline runner queue and reconnect delivery
- Edit last without workspace rollback
- Diff/file browsing while VM sleeps
- Browser terminal through data tunnel
- Managed preview wake/restart
- Live-only preview expiration
- Capability revocation
- Archive/delete with offline tombstone

### 30.4 Security tests

- Project extension cannot execute on host
- Workspace traversal and escaping symlink denied
- Preview cannot target runner LAN/loopback arbitrarily
- Control/preview cookies never reach guest
- Capability token removed from URL and stored hashed
- Placeholder secret cannot be recovered in guest
- Git credentials absent from process args, env, files, logs, and tool output
- Internal/cloud metadata addresses blocked
- Replayed enrollment/control messages rejected

### 30.5 UI tests

- Server route/controller tests first, following Remix 3 guidance
- Desktop and mobile viewport coverage
- Reconnect while assistant streams
- Queue controls
- Runner/resource selection before first send
- Runner lock after first send
- Terminal resize/input
- Preview private/capability flows
- Accessibility and keyboard navigation

## 31. Implementation milestones

Milestones are dependency-ordered, not calendar estimates. Each milestone should end in a demonstrable vertical slice.

### Milestone 0 — Foundation and contracts

- Create pnpm TypeScript monorepo.
- Pin Remix 3 beta and core dependency versions.
- Establish formatting, linting, tests, and CI.
- Define domain IDs, runtime schemas, protocol envelope, and compatibility policy.
- Add architecture decision records for trust model, outbound tunnels, SQLite, and Pi-on-host.
- Create fake runner/model test harness.

**Exit:** Control and fake runner can perform a versioned authenticated handshake in tests.

### Milestone 1 — Control-panel identity and configuration

- First-run admin setup
- Password sessions and CSRF
- Passkey registration/login
- Master-key setup and encrypted secret storage
- Model-provider CRUD/test
- Git-credential CRUD/test
- Project CRUD/defaults

**Exit:** User can log in, configure a project, model API key, and Git credential without secrets being returned by APIs.

### Milestone 2 — Runner bootstrap, heartbeat, and scheduling

- Runner CLI, data directory, `doctor`, and systemd packaging
- Enrollment tokens and Ed25519 runner identity
- Outbound control/data WebSockets
- Heartbeats, capability/version reporting
- CPU/memory/disk accounting
- Reservation handshake and draft runner selection
- Runner list/status UI

**Exit:** A NATed runner enrolls with URL+PSK, reports free resources, and accepts/rejects a session reservation.

### Milestone 3 — Workspace and Gondolin lifecycle

- Public repository host clone
- Session storage layout
- Developer image build and distribution
- Per-session VM creation with CPU/memory
- `/workspace` and cache mounts
- `.agents/setup`/`.agents/resume`
- Checkpoint/sleep/wake lifecycle
- Provisioning logs/events

**Exit:** First prompt provisioning can clone, boot, run setup, checkpoint, resume, and preserve workspace state without Pi yet.

### Milestone 4 — Pi runtime and conversation

- Host-side Pi SDK adapter
- Central model config delivery
- Filtered project resource loader
- Gondolin-backed Pi tools
- Persistent Pi JSONL
- Event normalization and runner spool
- HTTP prompt API and SSE stream
- Follow-up queue, steering, abort
- Offline runner queue/reconnect
- Model/thinking controls
- Edit-last conversation semantics

**Exit:** User can complete and continue a real streamed Pi session from desktop/mobile, including sleep/wake and offline queueing.

### Milestone 5 — Review surfaces

- Aggregate Git status/diff
- Changed-file navigation
- Read-only file browser
- Runner/control transcript reconciliation
- Offline transcript viewing
- Session archive/delete and disk reporting

**Exit:** User can inspect an agent’s complete result while its VM is sleeping and cleanly remove the session.

### Milestone 6 — Generic binary tunnel and terminal

- Binary framing and flow control
- Data-channel authentication/reconnect
- Terminal gateway
- Gondolin SSH bridge + PTY
- xterm.js desktop/mobile UI
- Lease/idle integration

**Exit:** Browser terminal works through an outbound-only runner with no runner ports exposed and does not block Pi tools.

### Milestone 7 — Private Git and push

- HTTPS placeholder credential helper and policy
- SSH host proxy credentials and repository exec policy
- Global Git author settings
- Commit & Push UI
- Agent Git fetch/commit/push
- Branch naming/upstream state
- Audit events and credential leakage tests

**Exit:** Agent and user can push a private repository branch while the real credential remains outside Gondolin.

### Milestone 8 — Previews

- Wildcard preview host routing
- Private preview authorization exchange
- Capability links and revocation
- Gondolin ingress integration
- Pi `publish_preview` tool
- Live-only previews
- Managed guest service supervisor
- Managed wake/restart/readiness
- Preview HTTP and WebSocket binary tunneling
- Activity leases and 15-minute sleep

**Exit:** A NATed home runner can expose a private dev server at an authenticated URL, sleep, and automatically restart a managed preview on access.

### Milestone 9 — Hardening and first release

- Upgrade/reconnect compatibility testing
- Installer and operations documentation
- Backup/restore documentation
- Security review and threat-model validation
- Resource limits and rate limits
- Accessibility/mobile polish
- End-to-end CI on x86-64 and ARM64 where available
- Release/versioning process for control, runner, protocol, and guest image

**Exit:** A new user can deploy the control panel, enroll a Linux runner with URL+PSK, configure credentials, and complete the documented end-to-end workflow.

## 32. MVP acceptance criteria

A release is MVP-complete when all of the following are true:

1. Control panel can be deployed persistently with HTTPS and a wildcard preview domain.
2. User can create a password account, register a passkey, and recover with password.
3. User can centrally configure a model API key, private Git credential, project, and project secrets.
4. A Linux runner behind NAT enrolls using only control-panel URL and enrollment token.
5. Runner reports free CPU/memory/disk and accepts a requested session size.
6. User can override the automatic runner before the first message and cannot move the session afterward.
7. Session clones a repository, boots an isolated Gondolin VM, runs setup, and starts host-side Pi.
8. Chat, thinking, tool calls, and tool output stream to desktop and mobile UI.
9. Follow-up messages are visibly queued, editable/cancellable, and promotable to steering.
10. Messages sent while runner is offline are delivered once after reconnect.
11. VM checkpoints after 15 minutes idle and wakes for subsequent work.
12. User can review aggregate diff and files while VM is sleeping.
13. Browser terminal works without any inbound runner port.
14. Agent can fetch, commit, and push to a private repository without obtaining the real credential in the guest.
15. User can choose the pushed branch name.
16. Agent can publish a private managed preview that supports HTTP/WebSockets over the outbound tunnel.
17. Managed preview wakes and restarts after sleep; live-only preview clearly expires.
18. Capability preview links are revocable and do not expose control-panel authentication to the guest.
19. Archive preserves state; delete removes runner artifacts and control-panel records, including after an offline runner reconnects.
20. Project Pi extensions cannot execute on the runner host by default.

## 33. Known risks and mitigations

### Remix 3 beta churn

**Risk:** APIs and UI conventions may change.

**Mitigation:** Pin exact versions, follow current Remix 3 skill/docs, isolate adapters, and upgrade intentionally with route/component tests.

### Gondolin maturity and limitations

**Risk:** Experimental APIs, Alpine-only image builder, disk-only checkpoints, and serialized guest exec behavior.

**Mitigation:** Pin versions/build IDs, own a tested developer image, use SSH for terminal, supervise background services, and maintain real-QEMU integration tests.

### Reverse tunnel complexity

**Risk:** Backpressure, WebSockets, slow consumers, and large assets can destabilize control traffic.

**Mitigation:** Separate control/data sockets, per-channel credit flow control, bounded buffers, fair scheduling, and exhaustive protocol tests.

### Credential mediation compatibility

**Risk:** Git/provider tools may use protocols or credential shapes not covered by Gondolin substitution.

**Mitigation:** Explicitly support tested HTTPS Basic/Bearer and SSH Git paths, fail closed, and document unsupported protocols.

### Pinned runner availability

**Risk:** A dead runner makes its sessions unavailable.

**Mitigation:** Show cached transcript, durable queued messages, explicit offline state, backups/exports later, and defer migration rather than implementing unsafe partial movement.

### SQLite concurrency

**Risk:** Event bursts and tunnel metadata could create write contention.

**Mitigation:** WAL, short transactions, batch durable events, avoid storing token deltas, and keep bulk preview/terminal traffic out of the database.

### Disk growth

**Risk:** Checkouts, Git objects, caches, logs, and checkpoints accumulate.

**Mitigation:** Disk reporting, reservation safety threshold, bounded logs/caches, archive/delete UI, and no surprise automatic deletion.

## 34. Deferred roadmap

- Centrally managed Pi Agent Profiles with trusted extensions
- Provider OAuth/subscription credentials
- GitHub App integration and pull-request creation
- Session migration/export between runners
- Optional direct/SDN runner transport
- Multi-user/workspace permissions
- Shared sessions and collaboration
- Full Pi tree/branch visualization
- True workspace+VM rollback for message edits
- Local checkout synchronization
- Managed service manifest committed to repositories
- Portals for multiple coordinated services
- Object-store backup of checkpoints/workspaces
- Postgres/Redis and multi-instance control plane
- macOS runners
- GPU resources
- Webhooks/event-triggered sessions
- OIDC workload identity for guest services

## 35. Implementation-session checklist

At the start of each implementation session:

1. Read this master plan and the relevant current Pi, Gondolin, and Remix 3 documentation.
2. Identify the milestone and explicit acceptance criterion being advanced.
3. Confirm no proposed code weakens the trust boundaries or introduces inbound runner requirements.
4. Update shared runtime schemas before implementing both sides of a protocol change.
5. Add idempotency and reconnect behavior for every distributed command.
6. Test the failure path, not only the connected happy path.
7. Keep runner/control/guest version compatibility explicit.
8. Update this document or an ADR when a decision changes.

---

This plan deliberately favors a narrow, reliable, outbound-only distributed system over a general remote-compute platform. The central invariant is that a runner with spare compute can join with a URL and enrollment token, remain unreachable from the public network, and still provide the complete coding-agent experience through the control panel.
