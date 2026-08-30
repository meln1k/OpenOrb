# OpenOrb Master Plan

> Living reference document for implementation. Update this document whenever a product or architectural decision changes.

## 1. Product summary

OpenOrb is an open-source, self-hostable system for running Pi coding-agent sessions on spare user-owned compute.

A user hosts one gateway, installs runners on Linux machines, and enrolls each runner with only:

```bash
openorb-runner start \
  --gateway https://openorb.example.com \
  --enrollment-token "$OPENORB_ENROLLMENT_TOKEN"
```

The runners may be on a home network, behind NAT or CGNAT, or on cloud VMs. They never require inbound ports. Each runner creates one Gondolin micro-VM per OpenOrb session, while Pi runs on the trusted runner host and executes its tools through Gondolin.

The primary experience is a responsive web UI for starting, monitoring, reviewing, and continuing remote coding-agent sessions from desktop or mobile.

### Motto

> If you have unused compute at home, you can run an agent on it.

## 2. Product principles

1. **Easy compute enrollment.** A new runner requires the gateway URL and an enrollment token, not model credentials, Git credentials, VPN setup, or inbound networking.
2. **Outbound-only runners.** Control, terminal, and preview traffic all use connections initiated by the runner.
3. **One session, one VM, one checkout.** This is the isolation and concurrency boundary.
4. **Trusted host, isolated guest.** The runner host is trusted. Agent-generated commands, repository setup scripts, and every Git operation against a guest-writable checkout run in Gondolin.
5. **Untrusted workspace metadata.** The entire checkout, including `.git`, is attacker-controlled data once mounted into the guest. Native host Git must never consume it.
6. **Central configuration.** Model credentials, Git credentials, project secrets, project configuration, and defaults live in the gateway.
7. **Automatic lifecycle.** VMs wake when needed and checkpoint after 15 minutes without relevant activity.
8. **Useful remotely.** Chat, tools, diffs, files, terminals, and app previews must work without SSHing into a runner.
9. **Mobile-capable.** The main workflows must be usable from a phone, not merely render on a narrow screen.
10. **Web-standard interfaces.** Use HTTP, SSE, WebSockets, Fetch APIs, and versioned runtime-validated protocol types.
11. **Single gateway persistence.** PostgreSQL is the gateway's only durable persistence, including for future control-plane growth. Never introduce Redis, another database/KV service, or application-owned durable local files. For the MVP, do not require an SDN, Kubernetes, or a multi-node control plane.
12. **Tenant ownership from the start.** The MVP creates only one administrator, but every user-owned control-plane row and repository operation is scoped by immutable `user_id`. There are no global user resources, and foreign keys prevent cross-user references.

## 3. Scope

### 3.1 MVP scope

- Single-administrator gateway with user-scoped persistence
- Local password authentication and WebAuthn/passkeys
- Multiple outbound-only Linux runners
- Reusable or one-time runner enrollment tokens
- Automatic runner selection with an optional user override before the first prompt
- Predefined per-session CPU and memory requests
- Runner resource reporting and reservation
- One fresh repository checkout and Gondolin VM per session
- Host-side Pi SDK integration
- Central API-key model credentials and custom compatible model definitions
- Linear conversation UI
- Streaming assistant text, thinking, tool calls, and tool results
- Pi-native `followUp()` and `steer()` behavior while the runner is connected
- Runner-local pending delivery while the assigned runner is connected, waking, or provisioning; durability ends at Pi handoff
- Conversation-only “edit last message”; workspace changes remain
- Aggregate Git diff and changed-file view
- Read-only file browser
- Browser terminal
- Agent- and user-created HTTP previews
- Private previews and optional revocable capability links
- Managed restartable previews and live-only previews
- Central HTTPS Git credentials and SSH private keys
- Agent-initiated Git fetch, commit, and push without exposing real credentials to the VM
- User-defined push branch names
- Project `.agents/setup` and `.agents/resume` hooks, executed only inside Gondolin
- Explicit allowlist-only Pi `ResourceLoader` with no project resource discovery and in-memory Pi settings
- Batteries-included Gondolin guest image
- Shared package download caches
- Archive and explicit deletion
- Minimal user-owned gateway live-session catalog (project, creation time, trimmed initial prompt) plus user-owned deleted-session ID/time markers; all full session data is runner-backed

### 3.2 Explicit non-goals for MVP

- Additional user account creation, organizations, sharing, or collaborative permissions
- Automatic session migration between runners
- High-availability gateway
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
- Automatic Pi loading of project context files, settings, packages, extensions, skills, prompts, themes, or system-prompt fragments
- Arbitrary untrusted project Pi extensions
- Memory/process VM snapshots
- GPU scheduling
- Generic TCP preview forwarding

## 4. Terminology

- **Gateway:** The self-hosted Remix web application, API, scheduler, secret store, runner gateway, and preview gateway.
- **Runner:** A native Linux service running Pi, managing Gondolin/session storage, and orchestrating Git operations inside the guest.
- **Project:** Repository configuration, credentials, secrets, defaults, and policies shared by sessions.
- **Session:** One linear user-visible Pi conversation, one checkout, one pinned runner, and one Gondolin VM/checkpoint.
- **Draft session:** A session whose first prompt has not been sent. Its runner selection can still change.
- **Workspace:** The session-specific host checkout mounted at `/workspace` in Gondolin.
- **Turn:** One Pi model response plus its tool calls. One user prompt may produce multiple turns.
- **Run:** All work resulting from an accepted prompt, including retries, compaction, and Pi-native queued continuations, until Pi is fully settled.
- **Pending delivery:** A normal user message durably held by the assigned runner before it is handed to Pi.
- **Pi queue:** Pi’s process-local steering/follow-up queue. It is live-only, has no stable item IDs, and is not part of Pi JSONL until delivery.
- **Lease:** A reason a VM must remain awake, such as active agent work, a terminal, provisioning, or a preview.
- **Managed preview:** A preview with a restart command that can wake and resume after VM sleep.
- **Live-only preview:** A published port without a restart command; it expires when the VM sleeps.
- **Capability link:** An unlisted, revocable preview URL that grants access without gateway login.

## 5. Locked product decisions

| Area | Decision |
|---|---|
| Initial audience | Single user on trusted user-owned compute |
| VM mapping | One Gondolin VM per session |
| Pi placement | Pi SDK runs on the runner host |
| Tool execution | Pi read/write/edit/bash operations execute through Gondolin |
| Repository | Fresh clone per session, performed inside Gondolin |
| Workspace storage | Host directory mounted into Gondolin with `RealFSProvider`; all contents including `.git` are untrusted |
| Git execution boundary | Never run native host Git against a session checkout; all clone/status/diff/fetch/commit/push operations execute inside Gondolin |
| Session placement | Auto-select runner; user may override before first prompt; immutable afterward |
| Resource scheduling | Sessions select `tiny`, `small`, `medium`, `large`, or `xxlarge`; runners advertise total/reserved/free resources |
| Idle lifecycle | Stop/checkpoint after 15 minutes without relevant activity |
| Conversation | Linear UI; Pi tree remains an internal implementation detail |
| Edit last | Conversation-only rewind; do not roll back files or VM state |
| While running | Normal send calls Pi `followUp()`; an explicit “Steer now” action calls `steer()` |
| Pi pending queue | Live-only and process-local; no edit, cancel, promotion, replay, or durability promise after handoff |
| Offline/waking runner | Reject sends while the runner is offline; a connected runner may durably hold messages while waking/provisioning until Pi handoff |
| Model credentials | Centralized in gateway; API keys first |
| Git credentials | Centralized HTTPS tokens and SSH private keys |
| Git push | Agent may push, with credentials mediated outside the guest |
| Commit identity | Per-user defaults, with room for project overrides |
| Networking | Mediated HTTP/HTTPS by default; internal ranges blocked |
| Previews | Private by default; optional revocable capability access |
| Preview domain | Wildcard preview domain is acceptable |
| Preview lifecycle | Managed previews wake/restart; live-only previews expire on sleep |
| Runner OS | Native Linux first |
| Gateway UI | Remix 3, end-to-end TypeScript |
| Gateway persistence | PostgreSQL only, for user-owned gateway configuration, a five-column live-session catalog (`user_id` plus four catalog fields), and three-column deletion markers (`user_id`, session ID, deletion time); no Redis, secondary database/KV store, or durable local gateway files |
| Tenant ownership | Personal user tenancy only; every repository method receives authenticated `userId`, tenant uniqueness is composite with `user_id`, and foreign keys prevent cross-user references |
| Runner persistence | Ordinary files/directories only for metadata, JSONL, logs, workspaces, Git Snapshots, checkpoints, and journals; no runner database |
| Browser streaming | HTTP commands + SSE events + dedicated WebSockets for terminal/preview |
| Runner transport | One outbound Effect RPC WebSocket for MVP; a separately scoped binary data plane is future work |
| Pi workspace resources | No project resource discovery in MVP; use an explicit empty/allowlist-only `ResourceLoader` and in-memory settings |
| Project guidance | Project files are available only through Gondolin-backed tools; Pi does not host-load `AGENTS.md`, `CLAUDE.md`, skills, prompts, packages, settings, or extensions |
| Guest image | Batteries-included OpenOrb Gondolin image |
| Caches | Shared package download caches enabled |
| Retention | No automatic deletion; explicit archive and delete; offline delete is represented by a durable minimal control-plane marker |

## 6. High-level architecture

```text
                                      Public Internet

 Browser ───── HTTPS/SSE/WS ─────┐
                                 │
 Preview client ─ HTTPS/WS ──────┼──► Gateway
                                 │    ├── Remix 3 web application
                                 │    ├── Browser HTTP API + SSE
                                 │    ├── Authentication
                                 │    ├── PostgreSQL + encrypted secret store
                                 │    ├── Scheduler and runner registry
                                 │    ├── Effect RPC runner registry
                                 │    ├── Future binary tunnel gateway
                                 │    └── Wildcard preview gateway
                                 │
                                 │             ▲
                                 │             │ outbound TLS/WebSockets only
                                 │             │
                                 │          Runner behind NAT
                                 │          ├── Effect RPC identity and state streams
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

A future optional direct or SDN-backed data path may change the separate data-plane service without changing session, preview, or terminal APIs.

## 7. Repository and package shape

Recommended monorepo shape:

```text
packages/
  gateway/                 Remix 3 gateway
  runner/                  published Linux runner CLI/service
  protocol/                shared runtime schemas and wire types
  domain/                  entities, state types, shared policy
  gateway-core/            scheduler, runner registry, events, secret broker
  runner-core/             runner orchestration and RPC handlers
  pi-runtime/              Pi SDK adapter and normalized events
  gondolin-runtime/        VM lifecycle, tools, terminal, preview ingress
  git-service/             guest Git orchestration, safe snapshots, and credential mediation
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

Use a Deno-native workspace with strict TypeScript and pin Deno exactly to 2.9.5 for development, CI,
gateway deployment, lockfile generation, and runner compilation. `deno.json`/`deno.lock` are
authoritative for application runtime dependencies. Retain one private root `package.json` only for
Effect setup scripts, Effect-aware diagnostics, and local TypeScript tooling. Deno installs and runs
that tooling. Do not add npm/Bun application scripts or pnpm files. Deno generates and owns the local
`node_modules` tree required by those tools and Remix's browser-asset compiler. This does not require
npm tooling or a Node.js runtime. Exact `npm:` compatibility dependencies remain locked by Deno.
Browser/gateway contracts should prefer Web APIs (`Request`, `Response`, `ReadableStream`,
`Uint8Array`, Web Crypto).

## 8. Gateway

### 8.1 Technology

- Remix 3 from the `remix` package
- Pin an exact beta release; never track `next` implicitly in lockfiles
- Use Remix 3 conventions rather than Remix v2 conventions
- `app/routes.ts` is the typed URL contract
- Controllers under `app/actions`
- Middleware for auth, sessions, CSRF, database, and request context
- `remix/ui`, not React
- Browser `/assets` serves only `packages/gateway/app/assets/**`; the Deno-owned `node_modules` tree is never mapped or allowed in the asset server, because unauthenticated requests could otherwise compile server-only dependencies (including the transitive `.deno` layout). When a client entry first needs an npm package, audit the complete browser dependency closure and expose only the required files.
- Effect `DenoHttpServer` owns the Deno HTTP/WebSocket lifecycle
- The runner upgrade is an Effect HTTP handler; other requests delegate to Remix's Fetch-oriented router through `HttpEffect.fromWebHandler`
- `remix/data-schema` for runtime validation
- PostgreSQL with explicit committed migrations
- PostgreSQL is the only durable gateway persistence; do not add Redis, another database/KV service, or application-owned durable local files
- Keep only rebuildable routing/live state in gateway-process memory
- Keep the PostgreSQL driver/framework integration behind a small local persistence interface; confirm the exact adapter before implementation

Because Remix 3 is under active development, wrap framework-specific persistence and server adapters behind small local interfaces. An exact dependency upgrade must be an intentional implementation task with tests.

### 8.2 Server request split

```text
Effect DenoHttpServer
├── /api/runners/connect upgrade  → Effect HTTP handler → RunnerRegistry
├── preview wildcard host         → PreviewGateway
├── normal HTTP                   → HttpEffect.fromWebHandler → Remix router
├── session event SSE             → Remix action → Effect stream → Response
└── future browser WebSockets
    ├── /api/sessions/:id/terminal→ TerminalGateway
    └── preview wildcard host      → PreviewGateway
```

Guest preview content must never be served from the gateway’s origin.

### 8.3 Single-administrator authentication

- First-run setup creates the single admin user.
- User IDs are application-generated UUIDv7 values stored in PostgreSQL `uuid` columns.
- The login and account-management UI remains single-administrator for MVP, but `users` supports multiple rows and every persisted resource is owned by one user.
- Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with exactly 600,000 iterations, a random 16-byte salt, and a 256-bit derived key. The fixed profile is runtime validated; there is no Argon2 compatibility path.
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

Preview capability tokens are session data: the runner generates them, returns the clear value once through the proxy, and stores only their hash in its local session store.

Use envelope-style application encryption:

- A gateway master key is supplied through `OPENORB_MASTER_KEY` or equivalent deployment-time secret injection.
- The gateway never generates or persists the master key to local disk or PostgreSQL and fails startup if it is missing or invalid.
- Import the 256-bit master key with Web Crypto and encrypt with `@std/crypto`'s `encryptAesGcm()`/`decryptAesGcm()`. Persist the returned nonce/ciphertext/tag bytes unchanged as one opaque value, store key version separately, and authenticate immutable user ID, credential key, and key version as AAD.
- Store each secret as an `encrypted_secrets` row with a UUID primary key, immutable `user_id`, a credential key unique within that user, an explicit required purpose, and the opaque ciphertext. Provider keys use purpose `provider-api-key` and are referenced by provider ID through separate provider-credential records; generic secrets use `generic-secret`; rows referenced by `git_credentials` use `git-credential`. Repositories select rows by both user and purpose rather than key-prefix conventions. Provider identity never derives from an environment-variable-style secret name.
- Never derive the server encryption key from the login password; the service must restart unattended.
- Backups are incomplete without the PostgreSQL database and master key.
- Secret values are never returned to the browser after creation; only metadata is returned.

## 9. Runner bootstrap and identity

### 9.1 Installation target

- Linux x86-64 and ARM64
- Native service, preferably installed with a package or `curl | sh` wrapper
- Standalone OpenOrb executable compiled by Deno 2.9.5 for GNU Linux x86-64 or ARM64; no installed Deno or Node.js runtime
- glibc 2.27 or newer; musl is unsupported in the MVP
- QEMU/KVM
- No host OpenSSH prerequisite in the current compiled permission profile; the later terminal ticket must select and explicitly permit an audited Deno-compatible SSH/PTTY bridge before adding one
- systemd service

Release artifacts are exactly `dist/openorb-runner-linux-x64` (`x86_64-unknown-linux-gnu`) and `dist/openorb-runner-linux-arm64` (`aarch64-unknown-linux-gnu`), with SHA-256 checksums. The startup CWD is the canonical runner working directory; production systemd sets `WorkingDirectory=/var/lib/openorb-runner`, development uses an ignored dedicated working directory, and the MVP exposes no `--data-dir` option.

The compiled runner uses one least-privilege Deno process: read/write is scoped to its working directory, network is unrestricted because approved Pi web tools must reach arbitrary public hosts, subprocess permission is limited to the architecture-appropriate QEMU suite, FFI is disabled, and environment/system permissions are narrow. Deno network permission is not the SSRF boundary; application/Gondolin egress policy must still block loopback, private, link-local, cloud-metadata, redirect, and DNS-rebinding targets. QEMU children are outside Deno's sandbox, so OpenOrb exposes no raw-QEMU interface and creates VMs only through pinned Gondolin `VM` options owned by trusted code.

Guest images are separate architecture-specific release assets. Release metadata pins one exact build ID, URLs, sizes, and trusted hashes; the runner downloads atomically into `images/<build-id>/`, verifies before every use, and passes only verified real paths to Gondolin. Do not embed VM images or resolve `latest` in production.

The runner package must include a `doctor` command that checks:

- Supported architecture/kernel
- Embedded Deno/denort and runner version
- glibc compatibility (with actionable musl rejection)
- QEMU availability/version
- `/dev/kvm` access and hardware virtualization
- Available CPU, memory, and disk
- Ability to reach the gateway URL
- Gondolin image availability
- Writable runner data directory

### 9.2 Enrollment

1. Runner calls the enrollment endpoint with the PSK and metadata.
2. Gateway derives the immutable owner from the authenticated user's enrollment token, stores `user_id` with the runner identity, and returns a stable runner ID plus bearer token. Runner payloads cannot choose or change tenant ownership.
3. The runner stores the bearer token in its data directory with mode `0600`.
4. On each outbound RPC connection, the gateway invokes `IdentifyRunner`; the runner returns the bearer token, claimed runner ID, runner version, and application protocol version.
5. The gateway admits the connection only after the token, claimed identity, revocation state, and protocol version pass authentication.
6. The shared enrollment PSK is not used as the runner’s ongoing identity.
7. The gateway can revoke one runner without regenerating the enrollment PSK.

The current reusable enrollment token is always available per user. Regeneration atomically revokes
the previous token and creates its replacement, while PostgreSQL enforces at most one active token
per user. Support reusable enrollment tokens for homelab convenience and one-time tokens for safer
automation.

### 9.3 Outbound connections

Each connected runner maintains one outbound Effect RPC WebSocket:

```text
wss://openorb.example.com/api/runners/connect
```

The runner opens the physical socket and serves `RunnerApi`; the gateway accepts the socket and acts
as the RPC client. The API contains typed identity, runner-state, provisioning, prompt, abort, and
session-event procedures. Effect owns framing, schema decoding, request correlation, stream
acknowledgement, interruption, and ping/pong.

A future terminal/preview milestone adds a separately authenticated outbound binary data socket. It
is not a second runner path or part of the current MVP transport.

## 10. Runner storage

The runner persists state in ordinary files and directories, not a database. Sensitive identity and token files use restrictive filesystem permissions.

Recommended layout:

```text
/var/lib/openorb-runner/
  runner.json
  identity/
    ed25519.key
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
      snapshots/
        git-snapshot.json
```

The runner is authoritative for all complete live-session data; the gateway duplicates only the immutable user owner and four catalog fields described below and retains minimal user-owned deleted-session ID/time markers:

- Session metadata and pinned-runner identity
- Raw Pi JSONL
- Runner-local pending message handoff records
- Working tree and Git objects, treated as untrusted bytes by the host
- Full file contents
- Host-owned cached Git Snapshots produced by guest-side Git
- Preview definitions, access policy, and capability hashes
- VM checkpoint
- Guest service logs

The session workspace is guest-writable. The runner may safely store, mount, copy, hash, or serve bounded file bytes from it, but must never invoke native host Git—or another executable selected by workspace metadata—against that directory.

The gateway persists gateway configuration:

- Users and browser authentication
- Projects and configuration
- Credentials and secrets
- Runner identities and revocation

It also persists one deliberately minimal catalog row per session:

```ts
interface SessionCatalogEntry {
  userId: string
  id: string
  projectId: string
  createdAt: string
  initialPromptPreview: string
}
```

`initialPromptPreview` is derived from the initial textual prompt by collapsing whitespace and truncating to at most 200 Unicode code points. It excludes attachments and is display-only; it must never be used to reconstruct or replay a prompt.

No runner ID, title, status, branch, model selection, transcript, message, tool, event cursor, usage, diff, file, log, preview, capability, Git state, or checkpoint is persisted in the gateway. The only session record outside the live five-column catalog is a deleted-session marker containing immutable user ID, session ID, and deletion time. After authentication, each runner streams a complete bounded initial `WatchRunner` snapshot containing the four catalog data fields plus live routing/state data. The gateway derives the owner from the authenticated runner record, never from runner-supplied tenant data; it upserts missing non-deleted catalog rows and atomically installs a user-scoped in-memory routing index only after the snapshot completion boundary. Snapshot absence alone does not delete a catalog row because runner assignment is not persisted. A tombstoned snapshot entry is never reinserted or routed and triggers idempotent runner cleanup once active work settles.

## 11. Domain model

User-owned project/configuration entities, the five-column `SessionCatalogEntry`, and minimal user/session/time deletion markers are persisted by the gateway. Complete session entities, pending messages, previews, events, and runtime state are persisted only by their owning runner and merely proxied by the gateway.

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
    model: string // provider/model, split only at the first slash
    thinkingLevel: ThinkingLevel
    orbSize: "tiny" | "small" | "medium" | "large" | "xxlarge"
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

Per-user Git author defaults are required. Project values may override them later without changing the core model.

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
    deno: string
    qemu: string
  }
  labels: Record<string, string>
  resources: RunnerResources
  lastObservedAt?: string
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
  model: string // provider/model, split only at the first slash
  orbSize: "tiny" | "small" | "medium" | "large" | "xxlarge"
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

### 11.6 Pending delivery

This model covers only messages that have not yet been handed to Pi. It does not mirror Pi’s in-memory queue.

```ts
type PendingMessageState =
  | "waiting-for-capacity"
  | "waiting-for-session"
  | "handing-off"
  | "delivery-uncertain"

interface PendingMessage {
  id: string
  sessionId: string
  clientRequestId: string
  content: ContentBlock[]
  state: PendingMessageState
  createdAt: string
}
```

Pending messages live only in the assigned runner’s local session store. A waiting message may be cancelled through the gateway proxy with a compare-and-set transition before handoff begins. It is not editable; the user cancels and sends a replacement. Once state becomes `handing-off`, cancellation is rejected. If the runner is offline, reads, sends, and cancellation are unavailable.

## 12. Resource scheduling

Orb sizes resolve to fixed resources: `tiny` is 1 CPU/2 GB, `small` is 2 CPUs/4 GB, `medium` is 4 CPUs/8 GB, `large` is 8 CPUs/16 GB, and `xxlarge` is 16 CPUs/32 GB. `medium` is the default. The runner persists the selected size and resolves it authoritatively whenever it creates or recreates the VM.

### 12.1 Runner observation

`WatchRunner` snapshot-complete and periodic observation events report actual allocatable capacity:

```ts
interface RunnerCapacity {
  activeSessions: number
  vmCpuCount: number
  vmMemoryMiB: number
  diskFreeMiB: number
}
```

The event also carries a monotonic runner revision and observation timestamp. Session state is sent
through the initial snapshot and later `session.updated`/`session.removed` stream elements rather
than embedded in a periodic transport message.

### 12.2 Placement

1. Filter online, non-draining runners by protocol/capability compatibility.
2. Filter by requested CPU, memory, disk safety threshold, labels, and architecture requirements.
3. Honor an explicit draft runner selection if it can accept the request.
4. Otherwise score candidates by free-resource ratio and current running VM count.
5. Reserve the candidate in the gateway's scoped in-memory registry and invoke `ProvisionSession`.
6. Runner re-checks local resources authoritatively before creating durable state.
7. Release the gateway reservation exactly once on success, rejection, timeout, disconnect, or interruption.
8. On a definite capacity rejection, try the next candidate; never retry an ambiguous provisioning handoff blindly.
9. Once provisioning starts, the runner persists its assignment and the gateway routes it from `WatchRunner` state.

A runner observation is advisory; `ProvisionSession` acceptance is authoritative.

### 12.3 Sleeping sessions

Sleeping sessions consume disk but do not reserve CPU or memory. On wake, the pinned runner must reacquire resources. If unavailable:

- Keep the prompt queued as `waiting-for-capacity`.
- Show the condition in the UI.
- Do not migrate automatically.
- Retry when subsequent `WatchRunner` observations show capacity.
- For previews, show a temporary unavailable/waiting response rather than routing elsewhere.

## 13. Session lifecycle

### 13.1 Draft and first prompt

1. User chooses project, ref, one `provider/model` reference, thinking level, a predefined orb size, and optional branch name in browser/gateway request state.
2. Scheduler displays the currently selected automatic runner.
3. User may override the runner while drafting.
4. Sending the first prompt reserves an online runner.
5. Runner creates the session locally, durably stores the full initial prompt, and becomes permanently assigned.
6. After runner confirmation, gateway stores only the user owner and four catalog data fields with the trimmed prompt preview; the runner assignment remains in the live routing index, not the catalog row.
7. Runner creates an empty session workspace, boots Gondolin with requested resources, and mounts it.
8. Git inside Gondolin clones the repository through mediated HTTPS/SSH credentials and reports the exact base commit.
9. Git inside Gondolin creates the local working branch.
10. Runner stores the reported base/branch state outside the guest-writable workspace.
11. Runner runs `.agents/setup` once inside Gondolin.
12. Runner creates the persistent Pi session and dispatches the first message.

Provisioning logs stream to the browser as session events.

### 13.2 Subsequent normal message

1. Gateway resolves the session through its live runner index; if the assigned runner is offline, reject the send.
2. Runner durably stores the message in its local session store with a unique `clientRequestId` before acknowledging HTTP acceptance.
3. If the VM is sleeping or lacks capacity, wake/reserve it and retain the runner-local pending record.
4. Recreate transient Gondolin policy, mounts, ingress, and secret placeholders.
5. Run `.agents/resume` and open Pi’s existing JSONL session.
6. Invoke `PromptSession` once with the stable `clientRequestId`; do not retry it automatically after an ambiguous transport outcome.
7. Runner calls `session.prompt()` if Pi is idle or `session.followUp()` if Pi is currently streaming. For idle prompts, use Pi’s documented preflight acceptance callback rather than waiting for the complete run.
8. When Pi reports preflight acceptance or `followUp()` returns successfully, `PromptSession` returns the explicit `runId` and whether the prompt started a run or became a follow-up.
9. If it was a follow-up, subsequent queue state is Pi-owned and process-local until Pi emits the user message.
10. Stream normalized Pi events, refresh the Git Snapshot on the active-run cadence, perform the final awaited flush when Pi settles, and start the idle timer if no lease remains.

### 13.3 Message while running

The UI exposes two send actions matching Pi directly:

- **Follow up** (default): submit a normal message; the runner calls `session.followUp()` when Pi is streaming.
- **Steer now**: call `session.steer()` immediately. Steering is accepted only when the pinned runner is connected, the VM/session is ready, and Pi is running.

After either SDK method accepts a message:

- The item may be displayed from Pi’s live queue-update events.
- It has no stable OpenOrb item ID or mutation controls.
- It cannot be edited, cancelled, or promoted between queues.
- It is not durably represented in Pi JSONL until Pi actually delivers it as a user message.
- A runner-process crash can lose it; OpenOrb does not silently replay it because replay could duplicate a message Pi already accepted.

If steering is unavailable, return a conflict response and let the user send a normal pending message instead. Extension commands are not supported through follow-up or steering.

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
5. Run a final controlled status/diff operation inside Gondolin and atomically store the Git Snapshot outside the workspace.
6. Flush guest filesystems.
7. Create a disk checkpoint; this consumes/stops the current Gondolin VM.
8. Persist checkpoint metadata and set VM state to `sleeping`.

Gondolin checkpoints are disk-only. Processes and RAM do not survive.

### 13.6 Archive and delete

Archive:

- Stop/checkpoint the VM.
- Expire preview access.
- Hide the session from the active list.
- Retain transcript, checkout, Pi JSONL, checkpoint, and logs.

Delete:

- Require explicit confirmation.
- If the owning runner is online and any agent, provisioning, setup/resume, maintenance, terminal, or preview work is active, reject deletion until that work settles; do not interrupt it implicitly.
- In one PostgreSQL transaction, write a durable deleted-session marker containing only user ID, session ID, and deletion time, remove the five-column catalog row, and remove any persisted gateway configuration that is scoped only to that session. Remove the ephemeral user-scoped route immediately afterward.
- If the runner is online and idle, request idempotent cleanup of preview capabilities, metadata, checkout, Pi JSONL, checkpoint, logs, and snapshots.
- If the runner is offline or permanently lost, deletion still succeeds at the control plane. The marker prevents a stale runner disk or backup from recreating the catalog entry.
- If a runner later reports a tombstoned session, do not route or reinsert it. Repeatedly request runner cleanup; if the runner reports active work, wait for it to settle rather than interrupting it.
- Retain the deleted-session marker after runner cleanup so a later stale snapshot cannot resurrect the ID.

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

### 14.3 Allowlist-only resource and settings boundary

The untrusted workspace must never be passed to Pi’s default discovery machinery. OpenOrb must follow Pi 0.83’s **full control** SDK pattern:

- Never instantiate, wrap, subclass, or delegate to `DefaultResourceLoader` for a session.
- Provide an explicit OpenOrb-owned object implementing the `ResourceLoader` interface.
- Use `SettingsManager.inMemory(...)`; never use `SettingsManager.create(...)` for a session.
- Never load workspace `.pi/settings.json`, user/global Pi settings, package declarations, or settings-selected resource paths.
- Point Pi’s `agentDir` and any model/auth metadata paths at runner-owned locations outside the workspace, while supplying model credentials through runtime APIs.
- Treat `cwd` as an untrusted tool-path value only; the custom loader must not use it for discovery.
- Route all Pi session construction through one `OpenOrbPiSessionFactory`; every SDK session creation call must explicitly pass both `resourceLoader` and `settingsManager`, so omission cannot silently activate defaults.

For the MVP, the project-resource allowlist is deliberately empty. The loader returns:

- No extensions and a fresh empty extension runtime
- No skills
- No prompt templates
- No themes
- No agent/context files
- No append-system-prompt fragments
- No project system-prompt override
- No package resources

The only system prompt is trusted OpenOrb-owned static text plus explicit gateway configuration. It is created without reading the workspace.

The implementation should structurally resemble:

```ts
const settingsManager = SettingsManager.inMemory(openOrbSettings)

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => trustedOpenOrbSystemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
}
```

Repository files such as `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, `.pi/skills/**`, and `.pi/prompts/**` remain ordinary untrusted workspace files. They are not scanned or parsed by the runner host. The model may inspect them only by invoking Gondolin-backed `read`, `find`, or `bash` tools. Any referenced or skill-associated script can therefore execute only through a Gondolin-backed tool inside the guest.

Add restricted-import/lint rules that forbid `DefaultResourceLoader` in runner packages and forbid direct Pi session construction outside `OpenOrbPiSessionFactory`. A test must fail if session creation observes any workspace-discovered extension, package, setting, prompt, skill, theme, context file, or system-prompt fragment.

A future centrally managed **Agent Profile** may add explicitly approved resources. Such resources must be selected by gateway configuration, copied into immutable runner-owned storage outside the workspace, and returned directly by the allowlist loader. Project workspace discovery must remain disabled, and scripts referenced by passive skill metadata must remain executable only through Gondolin-backed tools.

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
  | { type: "pending-delivery.changed"; pending: PendingMessage[] }
  | { type: "pi.queue.changed"; followUps: string[]; steering: string[] }
  | { type: "usage.changed"; usage: SessionUsage }
  | { type: "workspace.changed"; summary: DiffSummary }
  | { type: "preview.changed"; preview: Preview }
  | { type: "runner.changed"; runner: RunnerSummary }
```

Persist completed semantic records and cursors on the runner, not the gateway. Live deltas are best-effort traffic. On browser reconnect, the gateway opens `WatchSession(afterCursor)` so the runner projects completed state from Pi JSONL and then continues with live events.

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
- Surface a non-zero setup exit as a visible warning, then continue to Pi so the prompt can diagnose or repair the project.
- Run executable `.agents/resume` on every wake before Pi continues.
- Use a bounded blocking period; surface failure rather than silently continuing.
- Hooks execute inside Gondolin from `/workspace`.

### 15.4 Guest image

Gondolin currently implements an Alpine boot-image pipeline, but it accepts an OCI rootfs. The OpenOrb guest image uses a pinned Debian OCI userspace with Gondolin's Alpine kernel/initramfs boot layer. Its shared development environment contains:

- Shell, text, archive, editor, network, and media utilities comparable to a fresh Amp orb
- Git, `gh`, GCC/G++, Make, Autoconf, Automake, and pkg-config
- Python/pip, Node.js/npm/Corepack/pnpm/Yarn, Bun, and Perl
- `apt` for repository-specific setup
- The pinned native agent-browser CLI and browser runtime libraries
- Gondolin guest helpers and its minimal init

The image does not embed Chromium. An OpenOrb wrapper serializes on-demand installation before the first browser command: it fetches current Stable Chrome for Testing with the guest's Gondolin-compatible `curl` on x86-64, while ARM64 installs snapshot-pinned Debian Chromium because Google does not publish a Linux ARM64 Chrome for Testing build. The browser lands in the writable copy-on-write rootfs. The image does not include Amp/E2B internals, Deno, Go, Rust, Java, host container/VM/database tooling, a package cache, service supervisor, SSH daemon, terminal service, or preview service.

Image builds must be versioned and reproducible. Checkpoint resume requires the matching image.

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

1. Gateway stores encrypted provider configuration.
2. Browser lists only redacted metadata.
3. The browser submits one `provider/model` reference and no credential value. On run start, the gateway splits the reference only at its first `/`, resolves that provider's configured credential, and sends the model reference, thinking level, and credential only in the authenticated `ProvisionSession` or `PromptSession` RPC payload.
4. Runner keeps credentials in memory.
5. Runner configures Pi `ModelRuntime` at runtime.
6. Model credentials never enter Gondolin.
7. Runner reports Pi/model catalog compatibility; the gateway hides unsupported model choices.

## 17. Git and repository handling

### 17.1 Absolute execution boundary

The complete session checkout, including `.git`, becomes untrusted as soon as it is mounted into Gondolin. A repository or agent can modify executable Git configuration such as:

- Credential helpers
- `core.sshCommand`
- `core.hooksPath` and hooks
- Diff and textconv drivers
- Clean/smudge filters
- `core.fsmonitor`
- URL rewrites, remote helpers, aliases, and include files

Consequently, **the runner must never run native host Git against a session workspace**. This applies to clone, status, log, diff, fetch, commit, push, cleanup, and any future Git operation. It also applies when the VM is sleeping. Otherwise a later host-side Git command could execute guest-controlled code with runner privileges.

All Git operations against session data execute inside Gondolin. The host may handle the workspace only as untrusted file bytes and may consume bounded serialized Git Snapshots returned by the guest.

### 17.2 Clone and branch creation

1. Runner creates an empty host workspace and mounts it into Gondolin.
2. Git inside Gondolin clones the configured repository into `/workspace` through mediated credentials.
3. Automatic recursive submodule initialization is disabled.
4. The clone command permits only the configured network protocol and canonical repository URL.
5. Guest Git returns the exact base commit to the runner.
6. Git inside Gondolin creates the session working branch.
7. Runner stores base commit, branch, and remote metadata in a host-owned file outside the workspace; these values are untrusted data, not trusted instructions.

Default branch pattern:

```text
openorb/<sanitized-session-name>-<short-session-id>
```

The user may provide a custom branch name. It can change until its first successful push and is fixed afterward.

### 17.3 Controlled Git operations

Gateway Git actions ask the runner to execute a narrowly constructed command inside Gondolin. The runner does not shell-concatenate user data. Commands use explicit argument arrays, a controlled working directory, a clean environment, bounded output, timeouts, and explicit safe overrides where applicable.

For review-oriented commands:

- Disable pagers and interactive prompts.
- Use `--no-ext-diff` and `--no-textconv`.
- Disable configured filesystem monitors.
- Do not invoke hooks.
- Bound patch/file size and sanitize terminal control characters before browser rendering.

For network operations:

- Pass the project’s canonical remote URL explicitly instead of trusting an agent-modified `origin` URL.
- Restrict allowed protocols; deny `file`, `ext`, and arbitrary remote helpers.
- Do not recurse into submodules automatically.
- Scope the Git credential helper to the exact configured repository. Public HTTP/HTTPS egress is
  independent, and GitHub enforces the token's repository permissions.

These controls make OpenOrb-owned actions deterministic, but the main privilege boundary remains Gondolin. An agent can intentionally run Git features that execute repository-controlled code, but that code stays inside the guest.

### 17.4 HTTPS credentials without guest exposure

1. A trusted helper included in the guest image returns generated placeholder username/token values.
2. Git encodes placeholders into HTTP authorization headers.
3. Gondolin host hooks substitute the real secret only for `github.com` and `api.github.com`.
4. Non-GitHub hosts never receive substitution; GitHub enforces the token's repository permissions.
5. The guest can print only placeholders, never the real token.

The real HTTPS credential is not placed in guest environment variables, files, process arguments, or `.git/config`.

### 17.5 SSH credentials without guest exposure

- SSH private key is decrypted only on the trusted runner.
- Configure Gondolin’s host-side SSH proxy with the key and known-host policy.
- Use `execPolicy` to allow only Git operations for the configured repository.
- Permit `git-upload-pack` and `git-receive-pack` for that repository.
- Deny interactive SSH, SFTP, agent forwarding, port forwarding, and unrelated repositories.
- Agent-modified `core.sshCommand` may execute only inside the guest and cannot obtain the host-held key.

### 17.6 Git Snapshots and sleeping sessions

During an Agent Run, the runner executes controlled status/diff commands inside Gondolin at tool and
turn boundaries, every 15 seconds, and in a final awaited run-end flush. It debounces boundary
bursts, prevents overlapping inspections, and stores a bounded normalized Git Snapshot in a
host-owned runtime path that is not mounted guest-writable. The gateway proxies this snapshot
without persisting it.

While the VM sleeps:

- Show the last cached Git Snapshot.
- Mark it stale if terminal or VM failure prevented a final refresh.
- Wake the VM for an authoritative refresh when requested.
- Never run host Git against the sleeping workspace.

A future host-side implementation may use a deliberately non-executing parser over a sanitized immutable snapshot, but it must not use native Git, load `.git/config`, invoke hooks/drivers/filters/fsmonitor, or execute workspace-selected programs. This parser is not required for the MVP.

Read-only file browsing may read bounded workspace bytes directly with path/symlink protections because it does not interpret Git configuration or execute repository-selected code.

### 17.7 Commit and push

The agent may inspect history, create branches, commit, fetch, and push from inside Gondolin. System guidance says to push only when the user explicitly requests it.

The gateway **Commit & Push** action:

1. Wakes the VM if necessary.
2. Refreshes aggregate diff/status using controlled Git inside Gondolin.
3. Preserves existing agent-created commits.
4. If dirty, commits inside Gondolin using explicit author name/email and a user-supplied/default message.
5. Pushes the explicit local ref to the configured canonical remote URL and branch.
6. Records reported remote ref and commit IDs outside the workspace.

Never issue force flags from OpenOrb-owned UI/actions. Best-effort guest command policy should detect obvious force pushes, but true enforcement belongs in remote branch protection because raw Git protocol intent is difficult to police reliably at the HTTP/SSH transport boundary.

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
2. Runner launches a local OpenSSH client under an approved Deno-compatible PTY bridge; select and compatibility-test the exact implementation before the terminal ticket.
3. Terminal bytes are tunneled over the outbound runner data channel.
4. SSH forwarding and agent forwarding remain disabled.
5. Terminal activity acquires and refreshes a VM lease.

The runner itself exposes no terminal listener to the network.

## 19. Previews and portals

### 19.1 External behavior

OpenOrb previews emulate the useful behavior of Amp Portals while supporting NATed user-owned runners:

```text
Browser
  → wildcard preview endpoint on gateway
  → outbound runner data tunnel
  → runner-local Gondolin ingress
  → guest loopback dev-server port
```

Unlike Amp’s managed E2B network, OpenOrb cannot route over an operator-owned internal node network. The reverse tunnel is the data path.

### 19.2 Wildcard domain

Configuration example:

```text
Gateway: app.openorb.example.com
Preview base:  *.preview.openorb.example.com
```

Each preview uses a unique hostname:

```text
p-<random-id>.preview.openorb.example.com
```

Require wildcard DNS and TLS. A path-based fallback is not a primary target because many dev servers assume they own `/`, use absolute URLs, or need stable WebSocket/HMR paths.

### 19.3 Private preview authentication

- Gateway session cookie is host-only and never sent to preview hosts.
- Unauthenticated preview request redirects to the gateway for authorization.
- Gateway creates a short-lived, single-use authorization code.
- Preview host exchanges it for an `HttpOnly`, `Secure`, exact-host preview cookie.
- Remove codes/tokens from the visible URL via redirect.
- Gateway strips the OpenOrb preview-auth cookie before forwarding to the guest.
- Preserve unrelated application cookies used by the previewed app.
- Unique hostnames isolate preview origins from each other and from the gateway UI.

### 19.4 Capability access

- Owning runner generates a high-entropy token and stores only its hash in runner-local session data.
- Gateway returns the clear token once without persisting it.
- On access, the gateway asks the connected owning runner to validate the token before exchange.
- Exchange a valid token for an exact-host preview cookie, then redirect to a clean URL.
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

The browser API is internal and may evolve before a stable public API is declared. It still uses shared runtime schemas and explicit response types. Session-list/catalog responses may come from the four persisted metadata fields. Every full session-scoped read or mutation requires the owning runner to be connected and is proxied to that runner.

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
  model: string // provider/model, split only at the first slash
  orbSize: "tiny" | "small" | "medium" | "large" | "xxlarge"
  branchName?: string
}
```

`DELETE /api/sessions/:sessionId` is available while the runner is offline. After explicit confirmation, it atomically records the minimal deletion marker and removes the catalog row. Runner-local cleanup occurs immediately when the runner is online and idle, or is requested repeatedly from future snapshots without resurrecting the session.

### 20.6 Conversation and delivery

```http
GET    /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/steer
POST   /api/sessions/:sessionId/abort
POST   /api/sessions/:sessionId/edit-last
GET    /api/sessions/:sessionId/pending-messages
DELETE /api/sessions/:sessionId/pending-messages/:messageId
GET    /api/sessions/:sessionId/events?after=<cursor>
```

Normal message input:

```ts
interface SendMessageInput {
  clientRequestId: string
  content: ContentBlock[]
}
```

`POST /messages` returns `202 Accepted` only after the online owning runner durably stores the message before attempting delivery. The durability promise covers only that runner-local pre-handoff record. If the runner is offline, return `503 Service Unavailable`. `DELETE` is proxied to the runner and succeeds only while the record is still waiting; it returns `409 Conflict` once handoff starts.

`POST /steer` uses the same input shape but is a direct, live Pi operation. It returns success only after `session.steer()` accepts the message and returns `409 Conflict` when the runner/session/agent is unavailable. Steering is not durably queued or automatically retried.

### 20.7 Workspace and Git

```http
GET  /api/sessions/:sessionId/git-snapshot
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

- Runner-owned monotonic conversation position derived from the active Pi JSONL branch
- Support `Last-Event-ID`
- Send periodic keepalives
- Ask the runner to project completed conversation state from Pi JSONL after cursor expiration/compaction
- Do not persist event history in the gateway
- Do not persist every token delta
- Coalesce high-frequency live deltas
- Pi JSONL is the sole durable conversation transcript. The runner projects bounded wire/UI events from it and stores lifecycle, pending-delivery, preview, and other non-conversation state only in their owning metadata/journals.
- Relay Pi queue updates live without treating them as durable history
- Browser reconnect must not duplicate completed messages

The session list may use a separate lightweight global SSE stream for runner/session status, or poll initially. Do not overload every session stream with unrelated status.

## 22. Runner Effect RPC API

Effect Schema declarations in `@openorb/protocol` are the sole runner wire contract. Effect RPC
owns JSON framing, runtime decoding, in-connection correlation, stream acknowledgement, remote
interruption, and ping/pong. OpenOrb does not maintain a parallel wire contract or runtime path.

### 22.1 Connection admission

The runner physically opens the WebSocket and serves `RunnerApi`; the gateway accepts the socket and
acts as the RPC client. `IdentifyRunner` is the only call permitted before admission:

1. The gateway starts a bounded authentication deadline and invokes `IdentifyRunner`.
2. The runner returns its bearer token, claimed runner ID, runner version, and application protocol
   version.
3. The gateway authenticates the token, requires the authenticated and claimed IDs to match, checks
   revocation and protocol compatibility, and then starts `WatchRunner`.
4. Only a complete, reconciled initial runner snapshot is admitted to `RunnerRegistry`.

Permanent authentication, identity, revocation, or application-version rejection closes with code
`4401` and stops runner reconnect. Bootstrap timeout closes with code `4408` and remains transient.
Credentials never appear in the URL or WebSocket subprotocol and must be redacted from diagnostics.

### 22.2 Logical procedures

| RPC name | Shape | Purpose |
| --- | --- | --- |
| `runner.identify` | Unary | Return identity and protocol version for admission |
| `runner.watch` | Stream | Deliver initial session snapshot, capacity/liveness observations, and later session changes |
| `session.provision` | Unary | Accept new or explicit-retry provisioning into runner-owned durable state |
| `session.prompt` | Unary | Accept one prompt or Pi-native follow-up |
| `session.abort` | Unary | Abort one exact active `runId` |
| `session.watch` | Stream | Project durable Pi JSONL history after a cursor and continue with live events |

Later status, diff, archive, delete, and data-channel preparation operations join the same typed RPC
group. They are domain procedures, not generic command/result messages.

### 22.3 Identity, retry, and handoff

Effect RPC request IDs are transport correlation only. Stable domain identifiers remain explicit:
the provisioning session ID, each prompt `clientRequestId`, each Pi `runId`, and each session cursor.
None is derived from an RPC request ID.

`ProvisionSession` performs one short idempotent acceptance transaction: validate, create or prepare
runner-local metadata, transfer the long-running work to the process-owned supervisor, and return a
durable snapshot. A disconnect after transfer may lose the response without stopping provisioning.
The gateway does not blindly retry; an explicit same-session retry is reconciled against durable
metadata and a later `WatchRunner` snapshot can reveal successful acceptance.

`PromptSession` and `AbortSession` are serialized per session. Prompt reports the explicit active
`runId`; Abort must target that exact run. Neither operation is automatically retried after a timeout
or disconnect because Pi may already have accepted the prompt or begun stopping the run. The gateway
surfaces that outcome as uncertain and requires explicit user action. Pi-native follow-up state is
process-local and is never reconstructed from gateway data.

### 22.4 `WatchRunner`

The runner subscribes to state changes before taking its bounded initial snapshot. The stream emits
individual session elements, one completion boundary carrying revision/count/capacity, periodic
`runner.observed` elements, and later session updates/removals. The gateway accumulates and validates
the initial elements, reconciles catalog rows and tombstones, and atomically commits routes only at
the completion boundary. Invalid or tombstoned data never becomes partially live, and snapshot
absence alone never deletes a catalog row.

The gateway uses a stream inactivity timeout for domain liveness while Effect RPC ping/pong checks
socket responsiveness. On reconnect, the complete stream restarts and rebuilds only live routing
state; PostgreSQL is never used to reconstruct runner-owned session data.

### 22.5 `WatchSession` and SSE

`WatchSession({ sessionId, afterCursor })` combines cursor-bearing completed conversation events
read from Pi JSONL with bounded best-effort live events. Pi JSONL remains the sole durable
conversation source. Each browser owns a request-scoped runner RPC stream; the gateway filters
browser-visible events, encodes SSE records, and merges keepalive comments without sharing or
caching watch streams.

Each watcher subscribes before its initial JSONL read. A latest-wins, payload-free conversation
notification causes it to reread JSONL and emit every missing cursor suffix, while ephemeral events
remain separately bounded and lossy. A history failure or runner disconnect closes SSE so the same
native `EventSource` reconnects from `Last-Event-ID`; browser cancellation interrupts only its
matching runner stream.

## 23. Future runner binary data protocol

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

The Effect RPC connection must remain usable even if the future data connection is saturated or reconnecting.

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
  // Every method executes Git inside the session's Gondolin VM.
  clone(vm: RunningVm, config: CloneConfig): Promise<CloneResult>
  status(vm: RunningVm): Promise<GitStatus>
  diff(vm: RunningVm): Promise<WorkspaceDiff>
  commit(vm: RunningVm, input: CommitInput): Promise<CommitResult>
  push(vm: RunningVm, input: PushInput): Promise<PushResult>
  getCachedSnapshot(): Promise<CachedGitSnapshot | undefined>
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
  // File access treats workspace content as untrusted bytes and executes nothing.
  list(path: string): Promise<FileEntry[]>
  read(path: string): Promise<File>
}
```

`RunnerApi` and the process-scoped runner connection supervisor own the transport boundary. Do not
introduce a generic OpenOrb transport abstraction or mirror Effect RPC types. The future data
connection is a separate scoped service. These boundaries allow Pi, Gondolin, Git, RPC, and
data-plane details to be tested independently.

## 25. Persistence ownership

Gateway PostgreSQL is the gateway's only durable persistence. It stores configuration plus the minimal session catalog:

- `users`
- `password_credentials`
- `webauthn_credentials`
- `browser_sessions`
- `encrypted_secrets`, with explicit purpose classification for each encrypted value
- `model_providers`
- `git_credentials`
- Per-user Git author configuration
- `projects`
- `project_secrets`
- `runners`
- `runner_enrollment_tokens`
- `sessions`, restricted to `user_id`, `id`, `project_id`, `created_at`, and `initial_prompt_preview`
- `deleted_sessions`, restricted to `user_id`, `session_id`, and `deleted_at`
- Control-plane audit events that contain no session content beyond the catalog identity

It must not add other session columns or contain session routes, pending messages, conversation messages, tool calls/results, event streams, usage, diffs, files, logs, previews, Git session state, checkpoints, runner commands containing prompt content, or deletion records beyond the minimal `deleted_sessions` markers.

Each runner owns a file-backed local session metadata/event store in addition to the filesystem layout in section 10. It persists:

- Session identity, project snapshot/reference, and pinned runner
- Conversation/tool/usage records and event cursors
- Pending handoff state
- Preview definitions/capability hashes
- Git Snapshots and session lifecycle state

The gateway keeps a user-scoped in-memory session routing index populated by complete, reconciled `WatchRunner` snapshots. After a restart the route index starts empty and is rebuilt as runners reconnect; a snapshot entry also upserts any missing five-column catalog row for a valid, non-tombstoned runner-local session under the authenticated runner's owner. Minimal catalog cards remain visible for offline sessions, but their runner assignment, status, transcript, files, diffs, previews, and runner-backed actions are unavailable until the owning runner reconnects. Explicit deletion remains available and writes the user-owned control-plane marker without waiting for the runner.

Gateway PostgreSQL guidelines:

- Do not add Redis, another database/KV service, or application-owned durable local files
- UUIDv7 or another time-sortable random identifier for configuration entities
- Foreign keys enabled
- Every user-owned table has immutable `user_id`; uniqueness is tenant-relative and composite foreign keys prevent cross-user references
- Every persistence repository requires `userId` for list/read/write/delete operations and treats foreign-user identifiers as not found
- Explicit migrations committed to source
- Secret ciphertext separate from searchable metadata
- Store timestamps in UTC

## 26. UI and information architecture

### 26.1 Desktop

```text
┌─────────────────┬─────────────────────────────┬─────────────────────┐
│ Sessions        │ Conversation                │ Context             │
│                 │                             │                     │
│ Project/ref     │ Streaming assistant output  │ Changes             │
│ Status          │ Thinking (collapsed)        │ Files               │
│ Runner          │ Tool calls/results          │ Terminal            │
│ Resource size   │ Pending/Pi queue status      │ Previews            │
│                 │ Composer + model controls   │ Session details     │
└─────────────────┴─────────────────────────────┴─────────────────────┘
```

### 26.2 Mobile

- Conversation is the primary screen.
- Session list is a drawer.
- Bottom navigation: Chat, Changes, Files, Terminal, Preview.
- Model, thinking level, predefined orb size, and draft runner selection live in a composer/settings sheet.
- Runner selector becomes read-only after first send.
- Terminal can enter dedicated full-screen mode.
- Runner-local pending messages remain visible and cancellable through the proxy before handoff while the runner is connected.
- Pi-native follow-up/steering items are visible while connected but have no edit/cancel/promote actions.
- Preview opens in a new tab or dedicated embedded frame depending on browser limitations.

### 26.3 Session status communication

Always distinguish:

- Waiting for runner
- Waiting for runner capacity
- Provisioning clone
- Running setup
- Waking VM
- Agent running
- Message pending delivery
- Follow-up/steering held in Pi’s live queue
- Idle, VM awake
- Sleeping
- Runner offline
- Failed with retryable/non-retryable reason

Do not collapse these into a generic spinner.

## 27. Security model

### 27.1 Trust boundaries

Trusted:

- Gateway host
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
- Model credentials remain gateway/runner-side and never enter Gondolin.
- Git credentials remain gateway/runner-side; guest sees placeholders or an SSH proxy.
- The session checkout and `.git` metadata are untrusted; native host Git never consumes them.
- Every Git operation against a session checkout executes inside Gondolin, including status/diff while the VM is awake and clone/fetch/commit/push.
- Sleeping-session review uses a host-owned cached Git Snapshot generated inside Gondolin, not host Git.
- Project secrets use Gondolin placeholder substitution scoped to allowed destinations.
- Pi uses an explicit allowlist-only `ResourceLoader`; `DefaultResourceLoader` is forbidden for untrusted workspaces.
- Pi uses `SettingsManager.inMemory(...)` and never loads workspace or global Pi settings/packages.
- No project context, prompt, skill, theme, package, extension, or system-prompt resource is host-discovered in the MVP.
- Pi/the model can access project files and skill-associated scripts only through Gondolin-backed tools.
- Workspace path APIs reject traversal and symlink escape.
- Preview hosts are origin-isolated from gateway UI and one another.
- Preview gateway strips OpenOrb auth material before guest forwarding.
- Tunnel destinations are registered guest ports only.
- Internal IP ranges and cloud metadata remain blocked by default.
- Gateway and runner protocol messages are runtime validated.
- Sensitive values are redacted from logs and error messages.

### 27.3 Guest-controlled Git metadata

Treat `.git` as executable configuration, not passive data. The agent can rewrite helpers, hooks, SSH commands, diff/textconv drivers, filters, fsmonitor commands, URL rewrites, and includes. The host must therefore never invoke Git with the session workspace as a repository or working tree.

This prohibition applies even to apparently read-only commands such as `git status`, `git diff`, `git log`, and `git rev-parse`; Git configuration and attributes can cause subprocess execution. It also applies after the VM stops, when the workspace remains on the host filesystem.

Only code inside Gondolin may interpret Git metadata. Host-owned Git Snapshots must live outside guest-writable mounts, be treated as untrusted display data, and never be evaluated as commands or configuration.

### 27.4 Pi resource-discovery boundary

Pi resource discovery is a host-code execution boundary, not a convenience feature. Default discovery can involve settings, packages, extension paths, system-prompt files, context files, skills, prompts, and themes. Filtering results after discovery is insufficient because executable extensions may already have been imported or initialized.

The runner therefore constructs the `ResourceLoader` itself and returns only trusted in-memory resources. It never calls `DefaultResourceLoader`, never scans the workspace for Pi resources, and never loads `.pi/settings.json`. In the MVP all project resource collections are empty. The only host-provided prompt material is OpenOrb-owned.

Project documentation remains accessible to the agent through Gondolin-backed file tools. This preserves the VM boundary: reading or executing a script associated with a repository skill happens inside Gondolin, never through host-side Pi discovery.

### 27.5 Mediated project secrets

Project secrets are centrally encrypted. When a VM needs them:

- Runner generates guest placeholder values.
- Real values remain in host memory.
- Gondolin substitutes only in supported outbound HTTP headers for configured hosts.
- Do not claim mediation works for arbitrary protocols or secrets embedded in request bodies.
- Explicitly mapped TCP does not receive HTTP secret substitution.
- SSH secrets use Gondolin’s SSH proxy, not environment injection.

## 28. Observability

OpenOrb uses Deno's built-in OpenTelemetry integration and the OpenTelemetry API for explicit
application spans. Runtime configuration remains environment-driven so production deployments can
select any OTLP collector without application-owned exporter wiring. Motel is an optional local
agent-debugging backend for traces and logs only; it is not a production dependency or metrics
backend.

### 28.1 Structured logs

Gateway and runner logs include:

- Component
- Runner/session/project IDs
- Command/correlation ID
- Event type
- Duration
- Error category

Never log prompts or tool output by default at infrastructure log level; those belong to session records with user-controlled retention. Never log secrets or placeholder mappings.

### 28.2 Metrics

Gateway:

- Connected runners
- Runner reconnects
- Command latency/failures
- SSE connections
- Tunnel channels/bytes/resets
- Preview wake latency
- Scheduler reservation rejection rate
- PostgreSQL query/write latency

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

Gateway audit records contain only gateway-configuration actions:

- Login and passkey changes
- Secret/provider/Git credential changes
- Runner enrollment/revocation

Session-scoped audit records remain on the owning runner:

- Session creation/archive/delete
- Preview capability creation/revocation
- Git pushes
- Agent model changes

## 29. Failure handling

### Runner disconnect

- Mark the runner offline and remove its sessions from the live routing index.
- Keep minimal catalog cards visible using only project, creation time, and trimmed initial-prompt preview.
- Transcript, status, pending messages, diffs, files, terminals, previews, and other runner-backed actions become unavailable because the gateway has no full session copy. Explicit deletion remains available through a control-plane deletion marker.
- Do not reassign pinned sessions.
- Return runner-offline status for session and preview requests.
- Re-authenticate, consume and reconcile a complete `WatchRunner` snapshot, rebuild routes, and reopen runner-backed `WatchSession` streams after reconnect.

### Gateway restart

- Runner reconnects automatically with exponential backoff and jitter, answers `IdentifyRunner`, and starts a fresh `WatchRunner` stream.
- Gateway retains minimal user-owned catalog rows and deleted-session markers, upserts a missing five-column row under the authenticated runner's owner from a valid non-tombstoned snapshot entry, rejects tombstoned entries, and atomically rebuilds all user-scoped in-memory routes/live session state after the completion boundary; it recovers no full sessions or RPC operations from PostgreSQL.
- Browser SSE reconnects through the runner-owned cursor after the runner is available.
- Stable domain IDs and runner-owned state support reconciliation; ambiguous prompt/Abort handoffs remain explicit.

### VM start/resume failure

- Preserve checkpoint and diagnostics.
- Mark VM failed without deleting data.
- Surface image/backend/build-ID mismatch distinctly.
- Permit explicit retry after remediation.

### Setup/resume failure

- Stream logs and show the exact failed hook.
- A failed `.agents/setup` emits a visible warning and continues to Pi so the prompt can repair the project.
- A failed `.agents/resume` stops before dispatching the next prompt; permit terminal access when safe and allow an explicit resume retry.

### Pi/model failure

- Preserve Pi JSONL; no second normalized conversation log exists.
- Surface provider errors and retry status.
- Respect Pi’s retry/compaction lifecycle before declaring the run settled.

### Tunnel failure

- Reset only the affected logical channel.
- Keep the Effect RPC connection alive.
- Bound buffers and cancel upstream work on browser disconnect.

### Message handoff or runner-process crash

- Messages already stored in runner-local pending delivery remain durable across runner process restart.
- Nothing can be queued while the runner itself is unreachable.
- Pi-native follow-up and steering queues disappear if the Pi/runner process dies.
- Never reconstruct those queues from the gateway live projection.
- If Pi JSONL or current runner state proves Pi accepted a message, do not submit it again.
- If a crash leaves handoff ambiguous, mark `delivery-uncertain` and require explicit user resend rather than choosing between loss and duplication invisibly.

### Disk pressure

- Runner advertises disk safety threshold.
- Refuse new reservations before exhaustion.
- Never auto-delete sessions.
- Show per-session and runner disk use.
- Allow archive/delete cleanup from the UI.

## 30. Testing strategy

### 30.1 Unit tests

- Effect runner RPC schema validation
- Scheduler scoring and reservation fallback
- Resource accounting
- Session state transitions
- Deleted-session marker transaction and anti-resurrection guard
- Pending-message FIFO ordering and cancellation-before-handoff state guard
- Pi `prompt()`/`followUp()`/`steer()` selection from current agent state
- Path normalization and symlink escape protection
- Preview auth/capability exchange
- Secret encryption/redaction
- Git URL/repository policy
- Controlled guest Git argument/environment construction
- Cached Git Snapshot parsing and terminal-control sanitization
- Pi event normalization
- Allowlist-only `ResourceLoader` always returns empty project resource collections
- In-memory Pi settings ignore hostile workspace/global settings files
- Binary channel flow control

### 30.2 Contract tests

- `IdentifyRunner` admission and rejection across application protocol versions
- Idempotent provisioning reconciliation after a dropped RPC result
- Non-idempotent prompt handoff transitions to `delivery-uncertain` rather than automatic resubmission
- Pi JSONL conversation projection/replay and deduplication through an unpersisted gateway proxy
- Complete `WatchRunner` snapshot reconciliation and atomic in-memory route rebuilding, including tombstoned-entry rejection and cleanup request
- Binary open/data/window/end/reset behavior
- SSE cursor reconnect using runner-owned Pi history through the gateway proxy
- Preview HTTP header/body streaming
- Preview WebSocket tunneling

### 30.3 Integration tests

Use real Pi SDK with a fake deterministic model where possible and real Gondolin/QEMU in Linux CI where available.

Scenarios:

- Enroll runner behind an outbound-only network boundary
- Clone public HTTPS repository
- Clone/push private HTTPS repository with guest-visible placeholder only
- Clone/push private SSH repository through Gondolin proxy
- Every clone/status/diff/fetch/commit/push process runs inside the guest, never on the runner host
- Sleeping diff uses a final guest-generated cached Git Snapshot and wakes for refresh
- Provision setup hook
- Prompt → tools → settled → sleep → wake → continue
- Pi-native follow-up and steering with no post-handoff mutation controls
- Runner-local waking/provisioning pending delivery
- Offline runner rejects message submission and exposes only the minimal catalog card, not cached full session data
- Crash during Pi handoff produces `delivery-uncertain` and no automatic replay
- Edit last without workspace rollback
- Diff/file browsing while VM sleeps
- Browser terminal through data tunnel
- Managed preview wake/restart
- Live-only preview expiration
- Capability revocation
- Online idle deletion removes runner data; offline deletion removes the catalog card, records a minimal marker, and causes cleanup rather than resurrection if the runner later reconnects

### 30.4 Security tests

- A hostile workspace containing `.pi/extensions`, `.pi/settings.json`, package resources, prompt/system-prompt files, context files, skills, and themes cannot execute host code or alter the resources/system prompt returned to Pi
- Runner source/build checks forbid `DefaultResourceLoader` and session use of file-backed `SettingsManager.create(...)`
- Pi/the model reaches workspace `AGENTS.md`, `CLAUDE.md`, and skill-associated scripts only through Gondolin-backed tools
- Workspace traversal and escaping symlink denied
- Preview cannot target runner LAN/loopback arbitrarily
- Gateway/preview cookies never reach guest
- Capability token removed from URL and stored hashed only on the owning runner
- Placeholder secret cannot be recovered in guest
- Git credentials absent from process args, env, files, logs, and tool output
- Hostile `.git/config`, hooks, textconv/diff drivers, filters, fsmonitor, and `core.sshCommand` cannot create a runner-host marker during any OpenOrb Git/review action
- A test process monitor confirms no native host Git process is launched with a session workspace in its arguments, environment, repository/work-tree options, or current working directory
- Internal/cloud metadata addresses blocked
- Invalid or revoked `IdentifyRunner` credentials and claimed-runner mismatches are rejected
- A stale or restored runner snapshot cannot recreate or route a tombstoned session

### 30.5 UI tests

- Server route/controller tests first, following Remix 3 guidance
- Desktop and mobile viewport coverage
- Reconnect while assistant streams
- Pending-message cancellation before handoff
- Follow-up and explicit “Steer now” controls without post-handoff mutation actions
- Runner/resource selection before first send
- Runner lock after first send
- Terminal resize/input
- Preview private/capability flows
- Accessibility and keyboard navigation

## 31. Implementation milestones

Milestones are dependency-ordered, not calendar estimates. Each milestone should end in a demonstrable vertical slice.

### Milestone 0 — Foundation and contracts

- Create a Deno 2.9.5 TypeScript workspace with Deno-native manifests, lockfile, tasks, formatting, linting, checking, and tests.
- Pin Remix 3 beta and core dependency versions.
- Establish formatting, linting, tests, and CI.
- Define domain IDs, Effect Schema/RPC contracts, and the application protocol-version policy.
- Add architecture decision records for trust model, outbound tunnels, PostgreSQL, Pi-on-host, runner file storage, and the no-workspace-resource-discovery boundary.
- Implement and unit-test the explicit empty/allowlist-only Pi `ResourceLoader` and in-memory `SettingsManager` factory.
- Add static enforcement forbidding `DefaultResourceLoader`, file-backed Pi settings, and direct Pi session construction outside the audited OpenOrb factory.
- Create fake runner/model test harness.

**Exit:** Gateway and fake runner can perform `IdentifyRunner` admission and a typed RPC call in tests, and a Pi session created over a hostile fixture workspace exposes only trusted OpenOrb resources without executing workspace code.

### Milestone 1 — Gateway identity and configuration

- First-run admin setup
- Password sessions and CSRF
- Passkey registration/login
- Master-key setup and encrypted secret storage
- Model-provider CRUD/test
- Git-credential CRUD/test
- Per-user Git author name/email configuration
- Project CRUD/defaults

**Exit:** User can log in, configure a project, model API key, and Git credential without secrets being returned by APIs.

### Milestone 2 — Runner bootstrap, observation, and scheduling

- Runner CLI, data directory, `doctor`, and systemd packaging
- Enrollment and per-runner bearer identity
- One outbound Effect RPC WebSocket
- `IdentifyRunner` capability/version reporting and `WatchRunner` capacity/liveness observations
- CPU/memory/disk accounting
- Scoped gateway reservation, `ProvisionSession` capacity acceptance, and draft runner selection
- Runner list/status UI

**Exit:** A NATed runner enrolls with URL+PSK, reports free resources, and accepts/rejects `ProvisionSession` from the selected runner route.

### Milestone 3 — Workspace and Gondolin lifecycle

- Guest-side public repository clone with no native host Git against the workspace
- Session storage layout
- Guest image build and distribution
- Per-session VM creation with CPU/memory
- `/workspace` and cache mounts
- `.agents/setup`/`.agents/resume`
- Checkpoint/sleep/wake lifecycle
- Provisioning logs/events

**Exit:** First prompt provisioning can boot Gondolin, clone inside the guest, run setup, checkpoint, resume, and preserve workspace state without Pi yet.

### Milestone 4 — Pi runtime and conversation

- Host-side Pi SDK adapter
- Central model config delivery
- Milestone 0’s allowlist-only Pi resource loader and in-memory settings, with no workspace discovery
- Gondolin-backed Pi tools
- Persistent Pi JSONL
- Bounded Pi-to-wire event projection with no second durable transcript
- HTTP prompt API and SSE stream
- Pi-native follow-up, direct steering, and abort
- Runner-local pre-handoff pending delivery while connected/waking
- Offline runner rejection with only the minimal catalog card available
- Ambiguous-handoff state without automatic replay
- Model/thinking controls
- Edit-last conversation semantics

**Exit:** User can complete and continue a real streamed Pi session from desktop/mobile, with conversation state replayed from runner-owned Pi JSONL and only the user owner plus four live-session catalog fields and minimal user/session/time deletion markers stored by the gateway.

### Milestone 5 — Review surfaces

- Aggregate Git status/diff generated inside Gondolin and cached outside the workspace
- Hostile `.git/config` regression tests
- Changed-file navigation
- Read-only file browser
- Runner-owned Pi conversation replay through the gateway proxy
- Explicit unavailable state while the runner is offline
- Session archive on the online owning runner, online/offline deletion with durable anti-resurrection markers, and disk reporting

**Exit:** While the owning runner is connected, the user can inspect an agent’s complete result from runner-owned data. The user can delete the session while the runner is online or offline without allowing a stale snapshot to resurrect it.

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
- Controlled in-guest Git command runner and canonical-remote enforcement
- Verification that gateway Git actions never invoke host Git
- Apply the owning user's centrally configured Git author settings to guest commits
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
- Release/versioning process for gateway, runner, protocol, and guest image

**Exit:** A new user can deploy the gateway, enroll a Linux runner with URL+PSK, configure credentials, and complete the documented end-to-end workflow.

## 32. MVP acceptance criteria

A release is MVP-complete when all of the following are true:

1. Gateway can be deployed persistently with HTTPS and a wildcard preview domain.
2. User can create a password account, register a passkey, and recover with password.
3. User can centrally configure a model API key, private Git credential, per-user Git author identity, project, and project secrets.
4. A Linux runner behind NAT enrolls using only gateway URL and enrollment token.
5. Runner reports free CPU/memory/disk and accepts a requested session size.
6. User can override the automatic runner before the first message and cannot move the session afterward.
7. Session boots an isolated Gondolin VM, clones the repository inside it, runs setup, and starts host-side Pi.
8. Chat, thinking, tool calls, and tool output stream to desktop and mobile UI.
9. While Pi is running, the UI exposes normal follow-up and explicit “Steer now” actions; Pi-accepted queue items are visible when connected but are not editable, cancellable, promotable, or claimed durable.
10. Sends are rejected while the assigned runner is offline; while connected/waking, pending messages are stored only on that runner until handoff, and ambiguous handoff is surfaced instead of silently replayed.
11. VM checkpoints after 15 minutes idle and wakes for subsequent work.
12. While the owning runner is connected, the user can review the runner-owned guest-generated aggregate diff and files while the VM is sleeping, without native host Git interpreting the checkout.
13. Browser terminal works without any inbound runner port.
14. Agent can fetch, commit, and push to a private repository without obtaining the real credential in the guest.
15. User can choose the pushed branch name.
16. Agent can publish a private managed preview that supports HTTP/WebSockets over the outbound tunnel.
17. Managed preview wakes and restarts after sleep; live-only preview clearly expires.
18. Capability preview links are revocable and do not expose gateway authentication to the guest.
19. Archive operates on the online owning runner. Explicit deletion is available online or offline, atomically removes the five-column user-owned catalog row, stores only a user/session/time deletion marker, and causes any later stale runner snapshot entry to be cleaned up rather than resurrected.
20. Pi never discovers project settings, packages, extensions, skills, prompts, themes, context files, or system-prompt fragments on the runner host; Pi/the model accesses project files and scripts only through Gondolin-backed tools.

## 33. Known risks and mitigations

### Remix 3 beta churn

**Risk:** APIs and UI conventions may change.

**Mitigation:** Pin exact versions, follow current Remix 3 skill/docs, isolate adapters, and upgrade intentionally with route/component tests.

### Gondolin maturity and limitations

**Risk:** Experimental APIs, Alpine-only image builder, disk-only checkpoints, and serialized guest exec behavior.

**Mitigation:** Pin versions/build IDs and Debian OCI inputs, own a tested guest image, keep services explicitly process-managed, and maintain real-QEMU integration tests.

### Pi discovery defaults

**Risk:** A future refactor could omit the custom loader or use file-backed settings, re-enabling executable project extension/package discovery on the trusted runner.

**Mitigation:** Establish the full-control loader in Milestone 0, centralize SDK session creation in one audited factory, forbid `DefaultResourceLoader` and `SettingsManager.create(...)` in runner session code, test hostile workspaces, and require a security review for any new resource type.

### Pi in-memory message queues

**Risk:** `followUp()` and `steer()` are process-local, lack stable editable/cancellable item APIs, and are not persisted to Pi JSONL before delivery. A process crash can lose accepted queue items, while blind replay can duplicate them.

**Mitigation:** Keep durability only before handoff, expose Pi-native behavior without mutation promises, never auto-replay accepted/ambiguous message commands, and surface `delivery-uncertain` for explicit user action.

### Reverse tunnel complexity

**Risk:** Backpressure, WebSockets, slow consumers, and large assets can destabilize control traffic.

**Mitigation:** Separate control/data sockets, per-channel credit flow control, bounded buffers, fair scheduling, and exhaustive protocol tests.

### Credential mediation compatibility

**Risk:** Git/provider tools may use protocols or credential shapes not covered by Gondolin substitution.

**Mitigation:** Explicitly support tested HTTPS Basic/Bearer and SSH Git paths, fail closed, and document unsupported protocols.

### Pinned runner availability

**Risk:** A dead runner makes its sessions unavailable.

**Mitigation:** Show an explicit unavailable state, reject runner-backed session operations while offline, permit marker-backed offline deletion, add runner-side backups/exports later, and defer migration rather than implementing unsafe partial movement.

### PostgreSQL load and runner file growth

**Risk:** Gateway configuration/catalog traffic can exhaust PostgreSQL connections, while runner-local session event files can grow or be left with a partial final append after a crash.

**Mitigation:** Keep all full session data out of gateway PostgreSQL, use a bounded connection pool and short transactions, append runner events to crash-checked files without persisting token deltas, and compact only through an explicit future policy.

### Disk growth

**Risk:** Checkouts, Git objects, caches, logs, and checkpoints accumulate.

**Mitigation:** Disk reporting, reservation safety threshold, bounded logs/caches, archive/delete UI, and no surprise automatic deletion.

## 34. Deferred roadmap

- Centrally managed Pi Agent Profiles with trusted extensions
- Provider OAuth/subscription credentials
- GitHub App integration and pull-request creation
- Session migration/export between runners
- Optional direct/SDN runner transport
- Additional user accounts, workspace permissions, and sharing
- Shared sessions and collaboration
- Full Pi tree/branch visualization
- True workspace+VM rollback for message edits
- Local checkout synchronization
- Managed service manifest committed to repositories
- Portals for multiple coordinated services
- Object-store backup of checkpoints/workspaces
- PostgreSQL-only multi-instance control-plane coordination
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
7. Keep runner/gateway/guest version compatibility explicit.
8. Update this document or an ADR when a decision changes.

---

This plan deliberately favors a narrow, reliable, outbound-only distributed system over a general remote-compute platform. The central invariant is that a runner with spare compute can join with a URL and enrollment token, remain unreachable from the public network, and still provide the complete coding-agent experience through the gateway.
