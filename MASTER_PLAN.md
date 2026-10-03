# OpenOrb Master Plan

> Living reference document for implementation. Update this document whenever a product or architectural decision changes.

The settled agent contracts follow the
[Durable integration decision](docs/adr/0004-durable-agent-independent-environment.md),
[domain vocabulary](CONTEXT.md), and [security boundaries](security.md). Milestones and explicitly
planned features below retain product goals, not alternative runtime contracts.

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
5. **Untrusted workspace metadata.** The entire checkout, including `.git`, is attacker-controlled data on the guest root disk. Native host Git must never consume it.
6. **Central configuration.** Model credentials, Git credentials, project secrets, project configuration, and defaults live in the gateway.
7. **Automatic lifecycle.** VMs wake when needed and Stop after 15 minutes without relevant activity while retaining the Session's root disk.
8. **Useful remotely.** Chat, tools, diffs, files, terminals, and app previews must work without SSHing into a runner.
9. **Mobile-capable.** The main workflows must be usable from a phone, not merely render on a narrow screen.
10. **Web-standard interfaces.** Use HTTP, SSE, WebSockets, Fetch APIs, and versioned runtime-validated protocol types.
11. **Single gateway persistence.** PostgreSQL is the gateway's only durable persistence, including for future control-plane growth. Never introduce Redis, another database/KV service, or application-owned durable local files. For the MVP, do not require an SDN, Kubernetes, or a multi-node control plane.
12. **Workspace tenancy from the start.** Each user belongs directly to exactly one Workspace. Projects, secrets, provider/Git credentials, runners, enrollment credentials, session catalog rows, and deletion markers are owned by immutable `workspace_id`; composite foreign keys prevent cross-Workspace references. Passwords and Git author identity remain user-owned.

## 3. Scope

### 3.1 MVP scope

- Single-administrator gateway with Workspace-scoped tenant persistence
- Local password authentication and WebAuthn/passkeys
- Multiple outbound-only Linux runners
- Reusable or one-time runner enrollment tokens
- Automatic runner selection with an optional user override before the first prompt
- Predefined per-session CPU and memory requests
- Runner resource reporting and reservation
- One fresh repository checkout and Gondolin VM per session
- Host-side Pi Durable Agent Harness
- Central API-key model credentials and custom compatible model definitions
- Linear conversation UI
- Streaming assistant text, thinking, tool calls, and tool results
- Durable Submissions, including Follow-ups while the agent is busy
- Runner-owned Harness State for admitted input, queued work, and recovery; offline runners reject sends
- Planned conversation-only “edit last message”; workspace changes remain
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
- Explicit trusted Durable registry, in-memory credentials, and no project or global Pi discovery
- Batteries-included Gondolin guest image
- Ephemeral guest package caches
- Archive and explicit deletion
- Minimal Workspace-owned gateway live-session catalog (project, creation time, trimmed initial prompt) plus Workspace-owned deleted-session ID/time markers; all full session data is runner-backed

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
- Project Checkout rollback when editing a message
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
- **Session:** A durable association between a conversation and its Project Checkout, pinned to one runner, with at most one running Gondolin VM.
- **Draft session:** A session whose first prompt has not been sent. Its runner selection can still change.
- **Workspace:** The tenant that owns projects, credentials, secrets, runners, enrollment credentials, and the session catalog. Each user belongs directly to one Workspace.
- **Project Checkout:** The session-specific checkout at `/workspace` on Gondolin's persistent root disk.
- **Agent Harness:** Provider-neutral agent capability used by the runner; currently implemented with Pi Durable.
- **Harness State:** Durable conversation, queued inputs, and unfinished agent work needed to continue a Session.
- **Submission:** One admitted input with its own stable identity, whether it starts work or becomes a Follow-up.
- **Agent Run:** A continuous period of agent activity, including Follow-ups and automatic continuations, ending when the agent settles.
- **Follow-up:** Input added to the current Agent Run rather than starting another.
- **Conversation View:** The current active transcript, queued input, agent configuration, usage, and live progress shown to a viewer.
- **Session Journal:** Runner-owned infrastructure and configuration facts, separate from Harness State.
- **Agent Environment:** Live isolated compute capabilities and the Project Checkout available to the harness.
- **Stop Session / Wake:** Recoverably pause agent work and durably stop compute / resume both.
- **Abort:** Cancel agent work and queued inputs without stopping the Agent Environment.
- **Environment Control:** Agent-initiated start, stop, or restart of compute without pausing the harness.
- **Lease:** A reason a VM must remain awake, such as active agent work, a terminal, provisioning, or a preview.
- **Managed preview:** A preview with a restart command that can wake and resume after VM Stop.
- **Live-only preview:** A published port without a restart command; it expires when the VM Stops.
- **Capability link:** An unlisted, revocable preview URL that grants access without gateway login.

## 5. Locked product decisions

| Area | Decision |
|---|---|
| Initial audience | Single user on trusted user-owned compute |
| VM mapping | One Gondolin VM per session |
| Pi placement | Pi Durable runs on the trusted runner host behind the Agent Harness interface |
| Tool execution | Pi read/write/edit/bash operations execute through Gondolin |
| Repository | Fresh clone per session, performed inside Gondolin |
| Workspace storage | Private per-session qcow2 root disk; `/workspace` and `.git` are untrusted guest bytes, not a host mount |
| Git execution boundary | Never run native host Git against a session checkout; all clone/status/diff/fetch/commit/push operations execute inside Gondolin |
| Session placement | Auto-select runner; user may override before first prompt; immutable afterward |
| Resource scheduling | Sessions select `tiny`, `small`, `medium`, `large`, or `xxlarge`; runners advertise total/reserved/free resources |
| Idle lifecycle | Stop after 15 minutes without relevant activity; retain the persistent root disk |
| Conversation | Linear active Conversation View; not an archive of pre-compaction entries |
| Edit last | Planned conversation-only edit; do not roll back files or VM state; Durable interface still to be designed |
| While running | Normal send admits a Durable Submission with `whenBusy: "followUp"` |
| Queued input | Owned durably by the harness; no separate OpenOrb handoff queue or per-item mutation API |
| Offline/waking runner | Reject sends while the runner is offline; host-side admission and model work do not wait for guest readiness |
| Stop / Wake / Abort | Stop pauses recoverably before stopping compute; Wake resumes checkpoints; Abort cancels conversation work without stopping compute |
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
| Gateway persistence | PostgreSQL only, for Workspace-owned gateway configuration, a five-column live-session catalog (`workspace_id` plus four catalog fields), and three-column deletion markers (`workspace_id`, session ID, deletion time); no Redis, secondary database/KV store, or durable local gateway files |
| Tenant ownership | Direct `users.workspace_id`; tenant repository methods receive authenticated `workspaceId`, tenant uniqueness is composite with `workspace_id`, and foreign keys prevent cross-Workspace references. Passwords and Git author identity use `userId`. No memberships, new roles, tenant abstractions, or Workspace-selection UI |
| Runner persistence | Private per-Session Durable SQLite for Harness State; separate files for Session Journal, logs, root disk, Git Snapshots, and media |
| Browser streaming | HTTP commands + SSE events + dedicated WebSockets for terminal/preview |
| Runner transport | Outbound Effect RPC control WebSocket plus authenticated bulk WebSocket for media/Git patches; generic terminal/preview tunneling remains planned |
| Pi workspace resources | Explicit trusted Durable registry; no project/global discovery or ambient credentials |
| Project guidance | Project files are available only through Gondolin-backed tools; Pi does not host-load `AGENTS.md`, `CLAUDE.md`, skills, prompts, packages, settings, or extensions |
| Guest image | Batteries-included OpenOrb Gondolin image |
| Caches | Guest package caches are tmpfs-backed and do not survive Stop; shared host caches are deferred |
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
                                 │    ├── Bulk media/Git patch gateway
                                 │    └── Wildcard preview gateway
                                 │
                                 │             ▲
                                 │             │ outbound TLS/WebSockets only
                                 │             │
                                 │          Runner behind NAT
                                 │          ├── Effect RPC identity and state streams
                                 │          ├── Session/workspace storage
                                 │          ├── Pi Durable Agent Harness + SQLite
                                 │          ├── Git service
                                 │          ├── Gondolin lifecycle manager
                                 │          ├── Terminal bridge
                                 │          └── Preview supervisor
                                 │                    │
                                 │                    ▼
                                 │             Gondolin VM
                                 │             ├── persistent root disk with /workspace
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

Current package boundaries:

```text
packages/
  gateway/                 Remix 3 gateway
  runner/                  published Linux runner CLI/service
  protocol/                shared runtime schemas and wire types
  result/                  small shared result helpers
  runner/src/harness/       Agent Harness interface and Durable adapter
  runner/src/environment/   Agent Environment interface and Gondolin provider
  runner/src/session/       lifecycle actors, journal, views, Git Snapshots, media
images/
  guest/                   OpenOrb Gondolin image build configuration
scripts/                   build, release, and verification tasks
docs/
  adr/
  operations.md
security.md
MASTER_PLAN.md
```

Use a Deno-native workspace with strict TypeScript and require stable Deno 2.9.5 or newer for development,
gateway deployment, and source runners. Pin CI, lockfile generation, and release runner compilation to Deno 2.9.5 for reproducibility. `deno.json`/`deno.lock` are
authoritative together with the private root `package.json`, which pins Pi Durable and Chord and
contains Effect setup scripts, Effect-aware diagnostics, and local TypeScript tooling. Deno installs and runs
that tooling. Do not add npm/Bun application scripts or pnpm files. Deno generates and owns the local
`node_modules` tree required by those tools and Remix's browser-asset compiler. This does not require
npm tooling or a Node.js runtime. Exact `npm:` compatibility dependencies remain locked by Deno.
Browser/gateway contracts should prefer Web APIs (`Request`, `Response`, `ReadableStream`,
`Uint8Array`, Web Crypto).

## 8. Gateway

### 8.1 Technology

- Remix 3 from the `remix` package
- Pin an exact release (currently RC.5); never track `next` implicitly in lockfiles
- Use Remix 3 conventions rather than Remix v2 conventions
- `app/routes.ts` is the typed URL contract
- Controllers under `app/actions`
- Middleware for auth, sessions, CSRF, database, and request context
- `remix/ui`, not React
- Browser `/assets` serves an explicit allowlist of application modules and audited browser dependency
  files, including Chord's structural-delta code. Never broadly expose server dependencies or the
  Deno-owned `node_modules` tree; audit each browser dependency closure before expanding access.
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

- First-run setup atomically creates one Workspace, the single admin user, and their password credential; concurrent attempts cannot create another administrator or an orphan Workspace.
- User IDs are application-generated UUIDv7 values stored in PostgreSQL `uuid` columns.
- The login and account-management UI remains single-administrator for MVP, but `workspaces` and `users` support multiple rows. Every user has a required direct `workspace_id` foreign key. Browser auth is `{userId, workspaceId}`, resolved from persisted user/session records and rejected on mismatch, never selected by request input.
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
- Import the 256-bit master key with Web Crypto and encrypt with `@std/crypto`'s `encryptAesGcm()`/`decryptAesGcm()`. Persist the returned nonce/ciphertext/tag bytes unchanged as one opaque value, store key version separately, and authenticate immutable `workspaceId`, credential key, and key version as AAD.
- Store each secret as an `encrypted_secrets` row with a UUID primary key, immutable `workspace_id`, a credential key unique within that Workspace, an explicit required purpose, and the opaque ciphertext. Provider keys use purpose `provider-api-key` and are referenced by provider ID through separate provider-credential records; generic secrets use `generic-secret`; rows referenced by `git_credentials` use `git-credential`. Repositories select rows by both Workspace and purpose rather than key-prefix conventions. Provider identity never derives from an environment-variable-style secret name.
- Never derive the server encryption key from the login password; the service must restart unattended.
- Backups are incomplete without the PostgreSQL database and master key.
- Secret values are never returned to the browser after creation; only metadata is returned.

## 9. Runner bootstrap and identity

### 9.1 Installation target

- Linux x86-64 and ARM64
- Native service, preferably installed with a package or `curl | sh` wrapper
- Standalone OpenOrb executable compiled by Deno 2.9.5 for GNU Linux x86-64 or ARM64; no installed Deno or Node.js runtime
- glibc 2.27 or newer; musl is unsupported in the MVP
- QEMU; KVM is optional acceleration, with a warned TCG fallback when unavailable
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
- `/dev/kvm` access and hardware virtualization capability; warn and select TCG when unavailable
- Available CPU, memory, and disk
- Ability to reach the gateway URL
- Gondolin image availability
- Writable runner data directory

### 9.2 Enrollment

1. Runner calls the enrollment endpoint with the PSK and metadata.
2. Gateway derives the immutable Workspace owner from the persisted enrollment token, stores `workspace_id` with enrollment and runner identity, and returns a stable runner ID plus bearer token. Subsequent authentication resolves ownership from the trusted token/runner record. Runner payloads cannot choose or change tenant ownership. At most one active reusable enrollment PSK exists per Workspace.
3. The runner stores the bearer token in its data directory with mode `0600`.
4. On each outbound RPC connection, the gateway invokes `IdentifyRunner`; the runner returns the bearer token, claimed runner ID, runner version, and application protocol version.
5. The gateway admits the connection only after the token, claimed identity, revocation state, and protocol version pass authentication.
6. The shared enrollment PSK is not used as the runner’s ongoing identity.
7. The gateway can revoke one runner without regenerating the enrollment PSK.

The current reusable enrollment token is always available per Workspace. Regeneration atomically revokes
the previous token and creates its replacement, while PostgreSQL enforces at most one active token
per Workspace. Support reusable enrollment tokens for homelab convenience and one-time tokens for safer
automation.

### 9.3 Outbound connections

Each connected runner maintains an outbound Effect RPC control WebSocket:

```text
wss://openorb.example.com/api/runners/connect
```

The runner opens the physical socket and serves `RunnerApi`; the gateway accepts the socket and acts
as the RPC client. The API contains typed identity, runner-state, provisioning, prompt, abort, and
session-event procedures. Effect owns framing, schema decoding, request correlation, stream
acknowledgement, interruption, and ping/pong.

A separately authenticated outbound bulk WebSocket at `/api/runners/connect/bulk` serves bounded
chunks of cached Git patches and Session media without waking compute. Generic terminal/preview
tunneling is still planned; its flow-control design must preserve control-channel responsiveness.

## 10. Runner storage

The runner owns all full Session persistence. Pi Durable stores Harness State in a private
per-Session SQLite database; infrastructure/configuration facts remain in the separate Session
Journal. Sensitive identity, token, harness, and disk files use restrictive filesystem permissions.

Session storage layout (under the runner's working directory):

```text
/var/lib/openorb-runner/
  images/
  sessions/
    <session-id>/
      events.jsonl         infrastructure/configuration Session Journal only
      root-disk.qcow2
      harness/
        harness.sqlite
      artifacts/
      logs/
      snapshots/
        git-snapshot.json
```

The runner is authoritative for all complete live-session data; the gateway duplicates only the immutable Workspace owner and four catalog fields described below and retains minimal Workspace-owned deleted-session ID/time markers:

- Session metadata and pinned-runner identity
- Durable Harness State: conversation entries, Submissions, queued inputs, tasks, and recovery
- Session Journal infrastructure and configuration facts, not a second agent task state machine
- Working tree and Git objects, treated as untrusted bytes by the host
- Full file contents
- Host-owned cached Git Snapshots produced by guest-side Git
- Private Published Media and projected conversation-image artifacts
- Preview definitions, access policy, and capability hashes
- Persistent 40 GiB sparse `root-disk.qcow2`
- Guest service logs

The session root disk is guest-writable and opaque to ordinary host file tools. The runner stores and
deletes it as a private file, but must never attach it to multiple writable VMs or invoke native host
Git—or another executable selected by workspace metadata—against its contents.

The gateway persists gateway configuration:

- Users and browser authentication
- Projects and configuration
- Credentials and secrets
- Runner identities and revocation

It also persists one deliberately minimal catalog row per session:

```ts
interface SessionCatalogEntry {
  workspaceId: string
  id: string
  projectId: string
  createdAt: string
  initialPromptPreview: string
}
```

`initialPromptPreview` is derived from the initial textual prompt by collapsing whitespace and truncating to at most 200 Unicode code points. It excludes attachments and is display-only; it must never be used to reconstruct or replay a prompt.

No runner ID, title, status, branch, model selection, transcript, message, tool, event cursor, usage, diff, file, log, preview, capability, Git state, or root-disk state is persisted in the gateway. The only session record outside the live five-column catalog is a deleted-session marker containing immutable Workspace ID, session ID, and deletion time. After authentication, each runner streams a complete bounded initial `WatchRunner` snapshot containing the four catalog data fields plus live routing/state data. The gateway derives the owner from the authenticated runner record, never from runner-supplied tenant data; it upserts missing non-deleted catalog rows and atomically installs a Workspace-scoped in-memory routing index only after the snapshot completion boundary. Snapshot absence alone does not delete a catalog row because runner assignment is not persisted. A tombstoned snapshot entry is never reinserted or routed and triggers idempotent runner cleanup once active work settles.

## 11. Domain model

Workspace-owned project/configuration entities, the five-column `SessionCatalogEntry`, and minimal Workspace/session/time deletion markers are persisted by the gateway. Passwords and Git author identity remain user-owned. Complete Session entities, Harness State, previews, infrastructure events, and runtime state are persisted only by their owning runner and merely proxied by the gateway.

### 11.1 Project

```ts
interface Project {
  id: string
  workspaceId: string
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
  workspaceId: string
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

Do not create one giant state enum. The current wire contract exposes separate agent state
(`idle`, `running`, `paused`, `error`), environment state (`starting`, `running`, `stopping`,
`stopped`, `error`), checkout availability, provisioning stage, and bounded issues/recovery actions.
See [the runtime schemas](packages/protocol/src/runner-api-session-events.ts). Agent work can be
running while compute is stopped or starting. Runner connectivity and planned archive/preview
state must not collapse those independent dimensions.

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
  state: "starting" | "ready" | "stopped" | "expired" | "failed"
  config: PreviewConfig
  lastActivityAt?: string
}
```

### 11.6 Submissions and queued input

Durable admits each input under the caller's stable `clientRequestId` and returns a `submissionId`.
The identity belongs to that input, including a Follow-up, not to an Agent Run. Harness State owns
the queue and unfinished tasks across close/reopen. The Conversation View exposes queued input;
OpenOrb does not persist another queue or custom acceptance receipts. A duplicate acknowledgement
reads the existing submission without invoking `submit`, which would enable scheduling even for a
duplicate. Abort cancels conversation work, queued input, and owned background work. There is no
current per-item edit/cancel/promote contract.

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

### 12.3 Stopped sessions

Stopped sessions retain their persistent root disk but do not reserve CPU or memory. On wake, the
pinned runner must reacquire resources. If unavailable:

- Preserve already-admitted Harness State; do not create a separate capacity-waiting prompt queue.
- Show the condition in the UI.
- Do not migrate automatically.
- Retry when subsequent `WatchRunner` observations show capacity.
- For previews, show a temporary unavailable/waiting response rather than routing elsewhere.

## 13. Session flow

### 13.1 Draft and first prompt

1. User chooses project, ref, one `provider/model` reference, thinking level, a predefined orb size, and optional branch name in browser/gateway request state.
2. Scheduler displays the currently selected automatic runner.
3. User may override the runner while drafting.
4. Sending the first prompt reserves an online runner.
5. Runner creates the session locally, durably stores the full initial prompt, and becomes permanently assigned.
6. After runner confirmation, gateway stores only the Workspace owner and four catalog data fields with the trimmed prompt preview; the runner assignment remains in the live routing index, not the catalog row.
7. Runner opens the Durable harness and admits the initial input concurrently with environment
   startup. Model work and trusted prompt preparation do not wait for guest readiness.
8. The environment creates the persistent session root disk, boots Gondolin with requested resources,
   and creates `/workspace` inside the guest.
9. Git inside Gondolin clones the repository through mediated HTTPS/SSH credentials and reports the exact base commit.
10. Git inside Gondolin creates the local working branch.
11. Runner stores the reported base/branch state outside the guest-writable workspace.
12. Runner runs `.agents/setup` once inside Gondolin. Guest tools wait cancellably for readiness;
    host-side environment control is available immediately.

Provisioning logs stream to the browser as session events.

### 13.2 Subsequent normal message

1. Gateway resolves the session through its live runner index; if the assigned runner is offline, reject the send.
2. Invoke `PromptSession` with a stable `clientRequestId`. The runner serializes admission and opens
   or updates the harness using credentials held only in memory.
3. Durable admits the input with `whenBusy: "followUp"`; acceptance returns `clientRequestId` and
   `submissionId`, not completion of the Agent Run.
4. If the Session was paused, harness opening and environment startup proceed independently. The
   environment reopens the same disk, recreates transient policy/placeholders, and runs `.agents/resume`.
5. If the agent itself stopped compute through Environment Control, ordinary tools fail explicitly
   until the environment is started; admission does not depend on a ready guest.
6. Do not automatically retry an ambiguous RPC outcome. Durable deduplicates admitted request IDs;
   explicit reconciliation must not enable scheduling merely to acknowledge a duplicate.
7. Stream the Conversation View, refresh guest-generated Git Snapshots while compute is available,
   and start the idle timer when work settles and no lease remains.

### 13.3 Message while running

Normal send admits a Follow-up with its own Submission identity. Durable owns its persistence,
delivery, and recovery. The browser renders the queue from the Conversation View rather than
maintaining a second source of truth. Stop Session preserves unfinished work; Abort cancels it.

An explicit steering action remains a product goal requiring a Durable-based interface decision;
it is not implemented by the current Agent Harness or runner RPC API. Do not expose the removed
SDK steering or handoff-queue mutation APIs as current behavior.

### 13.4 Edit last message

Planned behavior, not a current Agent Harness operation. Allow only when:

- Agent is idle
- There are no already-delivered later user messages
- The target is the last visible user message

The Durable-based editing interface and treatment of abandoned responses need a separate design.
Do not assume an active Conversation View provides an archive of entries before compaction.

**Project Checkout and VM changes are not reverted.** The UI must say that the retry runs on the current checkout.

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

- Agent work and admitted Follow-ups
- Terminal input/output
- Preview HTTP requests
- Preview WebSocket traffic
- Setup/resume work

At timeout, use the same recoverable Stop Session ordering as explicit Stop:

1. Close Durable recoverably before cancelling guest operations or collecting the final Git Snapshot.
2. As terminal/preview support is implemented, stop new live-only streams, expire those previews,
   close terminals, and stop managed services within a bounded deadline.
3. Run a final controlled status/diff operation inside Gondolin and atomically store the Git Snapshot outside the workspace.
4. Run guest `/bin/sync`.
5. Explicitly stop and close the Gondolin VM without deleting `root-disk.qcow2`.
6. Call host `fsync` on `root-disk.qcow2` and its session directory.
7. Append `stop.completed` to the Session Journal and set environment state to `stopped`.

Wake resumes checkpointed agent work concurrently with opening the same disk in a new VM and
running `.agents/resume`. RAM, processes, and tmpfs-backed guest paths do not survive Stop.
Abort instead cancels conversation work without stopping compute. The host-side `environment`
tool can stop or restart compute without pausing the agent; forced restart reports possible
unsynced-data loss and must wait for exclusive disk ownership before attaching a replacement VM.

### 13.6 Archive and delete

Archive:

- Stop the VM and retain its persistent root disk.
- Expire preview access.
- Hide the session from the active list.
- Retain Harness State, checkout, Session Journal, `root-disk.qcow2`, and logs.

Delete:

- Require explicit confirmation.
- If the owning runner is online and any agent, provisioning, setup/resume, maintenance, terminal, or preview work is active, reject deletion until that work settles; do not interrupt it implicitly.
- In one PostgreSQL transaction, write a durable deleted-session marker containing only Workspace ID, session ID, and deletion time, remove the five-column catalog row, and remove any persisted gateway configuration that is scoped only to that session. Remove the ephemeral Workspace-scoped route immediately afterward.
- If the runner is online and idle, request idempotent cleanup of preview capabilities, metadata, the persistent root disk and its checkout, Harness State, media, logs, and Git Snapshots.
- If the runner is offline or permanently lost, deletion still succeeds at the control plane. The marker prevents a stale runner disk or backup from recreating the catalog entry.
- If a runner later reports a tombstoned session, do not route or reinsert it. Repeatedly request runner cleanup; if the runner reports active work, wait for it to settle rather than interrupting it.
- Retain the deleted-session marker after runner cleanup so a later stale snapshot cannot resurrect the ID.

## 14. Pi integration

### 14.1 Durable harness

Use `@earendil-works/pi-durable` behind the
[Agent Harness interface](packages/runner/src/harness/agent-harness.ts). The
[Durable adapter](packages/runner/src/harness/durable/layer.ts) opens a private SQLite store,
an explicit registry, and a root conversation. Durable owns entries, documents, Submissions, queued
input, task checkpoints, compaction, and recovery. OpenOrb does not implement another agent task
state machine. There is no conversion or compatibility path for disposable pre-migration sessions.

The scoped harness supports submit, explicit resume, conversation-wide abort, model/thinking
configuration, and complete Conversation Views. Closing it pauses recoverably. Opening for
observation alone does not resume scheduling. One Session owner serializes live harness access,
offline view reads, close, and deletion.

Pi AI uses a per-open `InMemoryCredentialStore`; ambient environment/file authentication is disabled.
Provider credentials are never written to harness configuration or guest files.

### 14.2 Guest tools and independent environment control

The explicit registry exposes guest-backed `read`, `write`, `edit`, and `bash`, plus
`publish_media` and host-side `environment` control. Durable's `ExecutionEnv` is backed exclusively
by the Agent Environment; `NodeExecutionEnv` and host-filesystem fallbacks are forbidden.

Relative paths resolve from `/workspace`. Absolute paths address the guest filesystem, never the
runner host. Guest operations wait cancellably during boot/setup/resume and fail explicitly while
compute is stopped. The host-side `environment` tool can start, stop, or restart compute even while
the guest is unavailable, without pausing the agent. Replacement VMs must not overlap disk ownership.

`publish_media` copies bounded allowlisted image/video bytes from `/workspace/.openorb/artifacts`
into private Session-owned storage. Browser media access is authenticated and Workspace-scoped;
arbitrary guest paths and remote embeds are not transcript mounts.

### 14.3 Trusted registry and resource boundary

Only OpenOrb-owned tools and prompt sections are installed in the Durable registry. Neither project
nor global Pi settings, packages, extensions, skills, prompts, themes, context files, or system-prompt
fragments are discovered on the host. Trusted prompt preparation never requires a ready guest.
It explains guest-only tools, independent Environment Control, disk-only persistence, and Git policy.

Repository files such as `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and `.pi/**` remain untrusted
guest files. The model can inspect them through guest tools and execute associated scripts only
inside Gondolin. Security tests must reject host discovery and host tool fallbacks.

A future centrally managed **Agent Profile** may add explicitly approved resources from trusted
configuration/storage. Its registry integration still needs design; it must not enable checkout
discovery or host execution of scripts referenced by passive skill metadata.

### 14.4 Conversation View projection

Consume Durable's complete Conversation Views, not deltas replayed into a second source replica.
Redact secrets and project media references before diffing the browser-facing view. Send an initial
`conversation.snapshot` followed by `conversation.ops` containing Chord structural operations.
Slow viewers coalesce to the latest view and receive a delta from their own last-delivered view.
Reconnect replaces the baseline, with no transcript replay cursor.
The active view includes queued input and live progress, but is not a pre-compaction archive.

Inline model images retain their bytes in Harness State/model context; browser control frames carry
Session artifact references only. Unsupported images or publication failures become placeholders,
never inline-byte fallback. Session infrastructure state and provisioning logs remain separate
Session Events. Neither gateway persistence nor the Session Journal maintains a second conversation
transcript.

## 15. Gondolin integration

### 15.1 VM shape

- QEMU backend first
- Requested CPU and memory passed to Gondolin/QEMU
- One VM object at a time per active session
- Session label includes OpenOrb session ID
- Private sparse 40 GiB qcow2 active root disk stored at a stable per-session path
- `/workspace` is an ordinary directory on the root disk; no host workspace VFS is mounted
- Package caches use tmpfs until an explicit safe cache design is added
- Guest log paths may be tmpfs-backed; runner-captured logs live in private Session storage, not a host workspace mount
- Internal ranges blocked by default
- HTTP/HTTPS mediated through host hooks
- Generic TCP denied except explicit mappings and SSH Git proxy

### 15.2 Persistent root disk and Stop constraints

- One sparse 40 GiB `root-disk.qcow2` exists at a stable path in each Session directory.
- `/workspace` and all other non-tmpfs root-disk paths persist on that disk.
- Explicit and idle Stop Session both close Durable recoverably before collecting the final Git
  Snapshot and running guest `/bin/sync`, then stop and close the VM without deleting the disk.
- Abort cancels agent work and queued inputs without stopping compute; Environment Control stops
  or restarts compute without pausing the harness.
- The runner calls host `fsync` on the disk and Session directory before journaling
  `stop.completed`.
- A runner interrupted in `Stopping` cannot confirm guest sync and VM exit, so it preserves the
  disk and fails with `restart-environment`.
- Wake creates a new VM object over the same disk and runs `.agents/resume`.
- RAM, processes, and tmpfs-backed paths such as `/root`, `/tmp`, and `/var/log` do not persist.
- The Session remains pinned to the matching Gondolin guest assets/build ID.

Setup documentation must tell projects not to rely on persistence under tmpfs-backed paths.

### 15.3 Setup hooks

- Run executable `.agents/setup` once after a fresh clone and initial boot.
- Capture stdout/stderr into session logs and stream them as provisioning events.
- Surface a non-zero setup exit as a visible warning and release guest readiness so the agent can diagnose or repair the project.
- Run executable `.agents/resume` on every environment wake before guest tools become ready; model
  work may already be running concurrently.
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

Image builds must be versioned and reproducible. Reopening a Session root disk requires the matching
image.

### 15.5 Package caches

Package caches use tmpfs in the current guest image and therefore do not survive Stop. Do not mount
host directories into the guest or share installed project dependency directories. A safe shared
cache design is deferred; dependencies installed on non-tmpfs paths within the Session root disk do
persist.

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
3. The browser selects one `provider/model` reference and no credential value. For provisioning,
   prompt admission, or Wake, the gateway resolves the Session's selection, splits the reference only
   at its first `/`, and sends the model reference, thinking level, and credential in the authenticated
   `ProvisionSession`, `PromptSession`, or `WakeSession` RPC payload.
4. Runner keeps credentials in memory.
5. Runner configures Pi AI's in-memory credential store and the Durable conversation's model.
6. Model credentials never enter Gondolin.
7. Runner reports Pi/model catalog compatibility; the gateway hides unsupported model choices.

## 17. Git and repository handling

### 17.1 Absolute execution boundary

The complete session checkout, including `.git`, is untrusted guest data on the persistent root
disk. A repository or agent can modify executable Git configuration such as:

- Credential helpers
- `core.sshCommand`
- `core.hooksPath` and hooks
- Diff and textconv drivers
- Clean/smudge filters
- `core.fsmonitor`
- URL rewrites, remote helpers, aliases, and include files

Consequently, **the runner must never run native host Git against a session workspace**. This applies to clone, status, log, diff, fetch, commit, push, cleanup, and any future Git operation. It also applies when the VM is stopped. Otherwise a later host-side Git command could execute guest-controlled code with runner privileges.

All Git operations against session data execute inside Gondolin. The host handles the opaque root-disk
file only for lifecycle and durability operations and may consume bounded serialized Git Snapshots
returned by the guest.

### 17.2 Clone and branch creation

1. Runner creates or opens the Session's persistent root disk and starts Gondolin.
2. Git inside Gondolin clones the configured repository into `/workspace` through mediated credentials.
3. Automatic recursive submodule initialization is disabled.
4. The clone command permits only the configured network protocol and canonical repository URL.
5. Guest Git returns the exact base commit to the runner.
6. Git inside Gondolin creates the session working branch.
7. Runner stores base commit, branch, and remote metadata in a host-owned file outside the workspace; these values are untrusted data, not trusted instructions.

By default, the working branch is the Project's default ref. The user may instead provide a custom
branch name, for example:

```text
openorb/<sanitized-session-name>-<short-session-id>
```

The branch can change until its first successful push and is fixed afterward.

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

### 17.6 Git Snapshots and stopped sessions

During an Agent Run, the runner executes controlled status/diff commands inside Gondolin at tool and
turn boundaries, every 15 seconds, and in a final awaited run-end flush. It debounces boundary
bursts, prevents overlapping inspections, and stores a bounded normalized Git Snapshot in a
host-owned runtime path that is not mounted guest-writable. The gateway proxies this snapshot
without persisting it.

While the VM is stopped:

- Show the last cached Git Snapshot.
- Mark it stale if terminal or VM failure prevented a final refresh.
- Wake the VM for an authoritative refresh when requested.
- Never run host Git against the checkout on the stopped VM's disk.

A future host-side implementation may use a deliberately non-executing parser over a sanitized immutable snapshot, but it must not use native Git, load `.git/config`, invoke hooks/drivers/filters/fsmonitor, or execute workspace-selected programs. This parser is not required for the MVP.

Read-only file browsing executes through bounded guest operations with path/symlink protections. It
wakes a stopped VM rather than reading `root-disk.qcow2` through host filesystem tools.

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
- Keeps VM awake while active; Stops after inactivity.
- On request while stopped: reserve resources, wake the same disk, run `.agents/resume`, restart the
  command, wait for readiness, and proxy.
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
- Expires when the VM Stops because the process command is unknown.
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

The route tables below are product API sketches except for the current conversation routes in
section 20.6. Implemented URLs are defined by
[the typed gateway routes](packages/gateway/app/routes.ts); planned endpoints are not public API promises.

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
POST   /app/sessions/:sessionId/messages
POST   /app/sessions/:sessionId/thinking-level
POST   /app/sessions/:sessionId/abort
POST   /app/sessions/:sessionId/stop
POST   /api/sessions/:sessionId/wake
GET    /api/sessions/:sessionId/events
```

The message form supplies a text prompt and optional thinking level. The gateway resolves the
Session's model/credentials, generates a `clientRequestId` for that command, and proxies
`PromptSession`; successful admission identifies the Durable Submission. Runner-offline sends fail;
ambiguous command outcomes are shown rather than automatically retried. Queued inputs belong to
Harness State, not a separate pending-message API.

Abort targets the Session's conversation. Stop is a recoverable pause plus durable compute stop.
Opening the session page separately sends a CSRF-protected Wake request. Subscribing to or
reconnecting the event stream never sends Wake or enables harness scheduling. Planned steering and
edit-last controls need Durable-based contracts before routes are added.

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
GET /api/sessions/:sessionId/events
Accept: text/event-stream
```

Requirements:

- Initial `conversation.snapshot` followed by Chord `conversation.ops` on the projected view
- No SSE event IDs, `Last-Event-ID` replay, or transcript cursors
- Send periodic keepalives
- Reconnect replaces the entire browser baseline from runner-owned Harness State
- Coalesce pending conversation updates to the latest view; compute each viewer's next delta from its last-delivered view
- Keep infrastructure events in a separate bounded queue; overflow fails only that watch and SSE reconnect supplies a fresh baseline
- Redact secrets and project inline images to private artifact references before diffing
- Keep live/offline harness ownership serialized; observation never wakes compute or resumes work
- Do not persist conversation/event history in the gateway or a second runner transcript
- Carry queue, usage, configuration, and progress in the Conversation View; keep infrastructure events separate
- Browser snapshot replacement and validated structural application must not duplicate messages

The session list may use a separate lightweight global SSE stream for runner/session status, or poll initially. Do not overload every session stream with unrelated status.

## 22. Runner Effect RPC API

Effect Schema declarations in `@openorb/protocol` are the sole runner wire contract. Effect RPC
owns JSON framing, runtime decoding, in-connection correlation, stream acknowledgement, remote
interruption, and ping/pong. OpenOrb does not maintain a parallel wire contract or runtime path.

Control payloads are UTF-8 JSON reassembled through bounded SchemaBinary framing: at most 1 MiB per
binary WebSocket chunk and 16 MiB per logical frame. Decode only after complete reassembly; reject
malformed UTF-8/JSON and discard partial frames on disconnect. Chunking does not bypass RPC schemas
or per-field limits. The control path has no CBOR decoder; schema bigints use strings.

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
| `session.prompt` | Unary | Admit a Submission, including a Follow-up when busy |
| `session.thinking-level.set` | Unary | Configure the open harness's thinking level |
| `session.wake` | Unary | Resume checkpointed work and start compute independently |
| `session.abort` | Unary | Cancel conversation work, queued input, and owned background work without stopping compute |
| `session.stop` | Unary | Close the harness recoverably, then durably stop compute |
| `session.delete` | Unary | Clean up runner-owned Session data |
| `session.watch` | Stream | Send a Conversation View snapshot, structural updates, and infrastructure events |
| `session.git-snapshot.read` | Unary | Read the cached Git Snapshot |
| `session.git-file.update` | Unary | Stage or unstage through guest Git |

Later archive and terminal/preview operations join the same typed RPC
group. They are domain procedures, not generic command/result messages.

### 22.3 Identity, retry, and handoff

Effect RPC request IDs are transport correlation only. Stable domain identifiers remain explicit:
the provisioning Session ID, each prompt `clientRequestId`, and each Durable `submissionId`.
None is derived from an RPC request ID. There is no OpenOrb Agent Run identifier or transcript cursor.

`ProvisionSession` performs one short idempotent acceptance transaction: validate, create or prepare
runner-local metadata, transfer the long-running work to the process-owned supervisor, and return a
durable snapshot. A disconnect after transfer may lose the response without stopping provisioning.
The gateway does not blindly retry; an explicit same-session retry is reconciled against durable
metadata and a later `WatchRunner` snapshot can reveal successful acceptance.

Prompt admission is serialized per Session. `PromptSession` returns the admitted `submissionId`;
Durable request-ID deduplication replaces custom receipt documents and admission observers.
Duplicate acknowledgements only read the persisted Submission: calling even a duplicate `submit`
would enable scheduling. `AbortSession` takes only `sessionId` and acts on the conversation.
Neither command is automatically retried after timeout/disconnect. Surface uncertainty for explicit
reconciliation. Checkpoint recovery on Wake is distinct from retrying an ambiguous gateway command;
model requests may repeat and interrupted unsafe tools may report partial execution. There is no
exactly-once execution guarantee or reconstruction of harness queues from gateway state.

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

`WatchSession({ sessionId })` reads the complete current Conversation View under the runner's scoped
ownership and sends a projected snapshot plus infrastructure state. Live updates are structural
diffs of complete projected views. A stopped Session can be observed from SQLite without scheduling
work or starting a VM; offline reads cannot race a live owner or deletion.

Each browser owns a request-scoped runner RPC stream. The gateway encodes its records and merges
keepalive comments without caching a conversation copy. The runner keeps one shared latest projected
view and a sliding one-slot change notification per viewer. Each viewer computes its next delta on
consumption, against its own last-delivered view; intermediate conversation updates can be skipped
without breaking the delta chain. Infrastructure events remain ordered in a separate bounded queue;
its overflow fails the slow watch without blocking the harness or other viewers. Overflow, read failure, or disconnect closes SSE; native
`EventSource` reconnect gets a new snapshot, not a missing suffix. Browser cancellation interrupts
only the matching watch stream, not agent work.

## 23. Future runner binary data protocol

This section plans generic terminal/preview tunnels, not the existing chunked media/Git-patch bulk
RPC or the control channel's SchemaBinary framing.

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

Document the exact encoding and integration with existing bulk transport before implementation.
Keep metadata small and runtime validated.

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

Use the current source contracts rather than parallel illustrative SDK interfaces:

- [Agent Harness](packages/runner/src/harness/agent-harness.ts): scoped open; submit returns a
  Submission ID; resume, abort, model/thinking configuration, and complete view observation.
- [Agent Environment and Provider](packages/runner/src/environment/agent-environment.ts): guest
  capabilities and acquisition over a durable root disk. The harness receives a readiness-aware
  guest proxy plus a separate host-side control callback.
- [Session actor](packages/runner/src/session/actor/session.ts): admission and recoverable
  harness ownership, independent environment startup, Wake, Stop, and Abort.
- [Environment actor](packages/runner/src/session/actor/environment.ts): readiness, guest operation
  cancellation, sync/stop, bounded restart, and exclusive disk attachment.
- Git review and mutations execute only inside Gondolin; cached snapshots are runner-owned.
  Planned file browsing must use bounded guest reads, never a host checkout adapter.
- Planned terminal/preview services need scoped ownership, leases, bounded streams, and guest-only
  destinations. Their exact internal interfaces remain implementation work.

`RunnerApi` and the process-scoped runner connection supervisor own the transport boundary. Do not
introduce a generic OpenOrb transport abstraction or mirror Effect RPC types. Bulk transfer is a
separate scoped service; generic tunnels remain planned. These boundaries allow Pi, Gondolin, Git, RPC, and
data-plane details to be tested independently.

## 25. Persistence ownership

Gateway PostgreSQL is the gateway's only durable persistence. It stores configuration plus the minimal session catalog:

- `workspaces`
- `users`, with required direct `workspace_id` ownership
- `password_credentials`
- `webauthn_credentials`
- `browser_sessions`, with persisted `{userId, workspaceId}` auth consistent with the user's Workspace; anonymous sessions have no authenticated owner
- `encrypted_secrets`, with explicit purpose classification for each encrypted value
- `model_providers`
- `git_credentials`
- Per-user Git author configuration
- `projects`
- `project_secrets`
- `runners`
- `runner_enrollment_tokens`
- `sessions`, restricted to `workspace_id`, `id`, `project_id`, `created_at`, and `initial_prompt_preview`
- `deleted_sessions`, restricted to `workspace_id`, `session_id`, and `deleted_at`
- Control-plane audit events that contain no session content beyond the catalog identity

It must not add other session columns or contain session routes, pending messages, conversation messages, tool calls/results, event streams, usage, diffs, files, logs, previews, Git session state, root-disk state, runner commands containing prompt content, or deletion records beyond the minimal `deleted_sessions` markers.

Runner-owned persistence has separate authorities:

- Durable's private per-Session SQLite database owns conversation entries, documents, Submissions,
  queued input, task checkpoints, usage, and recovery.
- The file-backed Session Journal owns infrastructure/configuration facts such as Session identity,
  project definition, placement, and environment lifecycle; it is not another agent task state machine.
- Root disks, Git Snapshots, Published Media, and logs retain their own private storage.
- Planned preview definitions/capability hashes remain runner-local, never gateway conversation data.

The gateway keeps a Workspace-scoped in-memory session routing index populated by complete, reconciled `WatchRunner` snapshots. After a restart the route index starts empty and is rebuilt as runners reconnect; a snapshot entry also upserts any missing five-column catalog row for a valid, non-tombstoned runner-local session under the authenticated runner's owner. Minimal catalog cards remain visible for offline sessions, but their runner assignment, status, transcript, files, diffs, previews, and runner-backed actions are unavailable until the owning runner reconnects. Explicit deletion remains available and writes the Workspace-owned control-plane marker without waiting for the runner.

Gateway PostgreSQL guidelines:

- Do not add Redis, another database/KV service, or application-owned durable local files
- UUIDv7 or another time-sortable random identifier for configuration entities
- Foreign keys enabled
- Tenant-owned projects, secrets, provider/Git credentials, runners, enrollment credentials, catalog rows, and deletion markers use immutable `workspace_id`; uniqueness is tenant-relative and composite foreign keys prevent cross-Workspace references
- Tenant persistence repositories require authenticated `workspaceId` for list/read/write/delete operations and treat foreign-Workspace identifiers as not found; passwords and Git author configuration remain user-owned and require `userId`
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
│ Resource size   │ Durable queued input        │ Previews            │
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
- Durable queued input is visible through the Conversation View while the runner is connected.
- Distinguish recoverable Stop, Wake, and conversation-wide Abort; there are no current per-item queue mutation controls.
- Preview opens in a new tab or dedicated embedded frame depending on browser limitations.

### 26.3 Session status communication

Always distinguish:

- Waiting for runner
- Waiting for runner capacity
- Provisioning clone
- Running setup
- Waking VM
- Agent running
- Durable Follow-up queued
- Agent paused, checkpointed work retained
- Agent running with environment stopped or starting
- Idle, VM awake
- Stopped, persistent disk retained
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
- Stopped-session review uses a host-owned cached Git Snapshot generated inside Gondolin, not host Git.
- Workspace generic secrets use Gondolin placeholder substitution. Allowed destinations are
  optional; omission intentionally allows all public HTTP(S) hosts.
- Pi Durable uses an explicit trusted registry and a guest-only execution adapter; host execution fallbacks are forbidden.
- Pi AI credentials are in memory with ambient environment/file authentication disabled; no workspace/global settings or packages are loaded.
- No project context, prompt, skill, theme, package, extension, or system-prompt resource is host-discovered in the MVP.
- Pi/the model can access project files and skill-associated scripts only through Gondolin-backed tools.
- Project Checkout path APIs reject traversal and symlink escape.
- Preview hosts are origin-isolated from gateway UI and one another.
- Preview gateway strips OpenOrb auth material before guest forwarding.
- Tunnel destinations are registered guest ports only.
- Internal IP ranges and cloud metadata remain blocked by default.
- Gateway and runner protocol messages are runtime validated.
- Sensitive values are redacted from logs and error messages.

### 27.3 Guest-controlled Git metadata

Treat `.git` as executable configuration, not passive data. The agent can rewrite helpers, hooks, SSH commands, diff/textconv drivers, filters, fsmonitor commands, URL rewrites, and includes. The host must therefore never invoke Git with the session workspace as a repository or working tree.

This prohibition applies even to apparently read-only commands such as `git status`, `git diff`, `git log`, and `git rev-parse`; Git configuration and attributes can cause subprocess execution. It also applies after the VM stops, when the checkout remains inside the opaque persistent root disk, not on a host workspace mount.

Only code inside Gondolin may interpret Git metadata. Host-owned Git Snapshots must live outside guest-writable mounts, be treated as untrusted display data, and never be evaluated as commands or configuration.

### 27.4 Pi resource-discovery boundary

Pi resource discovery is a host-code execution boundary, not a convenience feature. Default discovery can involve settings, packages, extension paths, system-prompt files, context files, skills, prompts, and themes. Filtering results after discovery is insufficient because executable extensions may already have been imported or initialized.

The runner therefore installs only explicit OpenOrb-owned tools and prompt sections in Durable's
registry. It never scans the workspace or global directories for Pi resources and never loads
`.pi/settings.json`. Host-provided prompt material is trusted and independent of guest readiness.

Project documentation remains accessible to the agent through Gondolin-backed file tools. This preserves the VM boundary: reading or executing a script associated with a repository skill happens inside Gondolin, never through host-side Pi discovery.

### 27.5 Mediated workspace secrets

Generic secrets are centrally encrypted and supplied to newly started Agent Environments in their
Workspace. Project-scoped assignment remains deferred. When a VM needs them:

- Gondolin generates guest placeholder environment-variable values.
- Real values remain in host memory.
- Gondolin substitutes only in supported outbound HTTP headers. Configured hosts restrict
  substitution; an omitted host list permits substitution for any public HTTP(S) host and therefore
  permits guest code to exfiltrate that secret.
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
- Running VMs and stopped sessions
- VM start/wake/Stop duration
- Pi run duration and failures
- Setup/resume duration
- Git operation duration
- Open terminal/preview channels
- Conversation stream resets and queued-work counts

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
- Gateway retains minimal Workspace-owned catalog rows and deleted-session markers, upserts a missing five-column row under the authenticated runner's owner from a valid non-tombstoned snapshot entry, rejects tombstoned entries, and atomically rebuilds all Workspace-scoped in-memory routes/live session state after the completion boundary; it recovers no full sessions or RPC operations from PostgreSQL.
- Browser SSE reconnect replaces its baseline with a fresh Conversation View after the runner is available; it does not Wake the Session.
- Stable domain IDs and runner-owned state support reconciliation; ambiguous prompt/Abort handoffs remain explicit.

### VM start/wake failure

- Preserve the persistent root disk and diagnostics.
- Mark VM failed without deleting data.
- Surface image/backend/build-ID mismatch distinctly.
- Permit explicit retry after remediation.

### Interrupted Stop

- Reconcile a Session journaled as `Stopping` by preserving the disk, marking the Session failed,
  and requiring the explicit `restart-environment` recovery action. Host `fsync` alone cannot prove
  that guest sync and VM exit completed.

### Setup/resume failure

- Stream logs and show the exact failed hook.
- Failed `.agents/setup` or `.agents/resume` emits a visible warning and releases guest readiness
  so the agent can diagnose or repair the project. Host-side model work need not wait for either hook.

### Pi/model failure

- Preserve Durable Harness State; no second normalized conversation log exists.
- Surface provider errors and retry status.
- Derive activity from Durable's current view, including unfinished work, before declaring the Agent Run settled.

### Tunnel failure

- Reset only the affected logical channel.
- Keep the Effect RPC connection alive.
- Bound buffers and cancel upstream work on browser disconnect.

### Message handoff or runner-process crash

- Admitted Submissions, Follow-ups, and task checkpoints survive in runner-owned Durable SQLite.
- Nothing can be submitted through the gateway while the runner is unreachable.
- Runner restoration and read-only observation do not automatically resume work; Wake does.
- Never reconstruct harness queues from the gateway projection or the Session Journal.
- Resolve duplicate request IDs by reading existing Submissions, without scheduling through `submit`.
- Report ambiguous command outcomes for explicit reconciliation rather than silently retrying.
- Recovery is not exactly-once: model requests may repeat; interrupted unsafe tools report possible
  partial execution rather than being blindly replayed. Guest processes and RAM do not survive.

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
- Durable request-ID deduplication and stable Submission identity, including Follow-ups
- Duplicate acknowledgement does not call `submit` or enable scheduling
- Recoverable Stop versus Abort versus independent Environment Control
- Path normalization and symlink escape protection
- Preview auth/capability exchange
- Secret encryption/redaction
- Git URL/repository policy
- Controlled guest Git argument/environment construction
- Cached Git Snapshot parsing and terminal-control sanitization
- Conversation View projection, media redaction, and validated Chord operations
- Explicit Durable registry ignores hostile workspace/global resources
- In-memory credentials disable ambient environment/file authentication
- Binary channel flow control

### 30.2 Contract tests

- `IdentifyRunner` admission and rejection across application protocol versions
- Idempotent provisioning reconciliation after a dropped RPC result
- Ambiguous prompt outcomes remain explicit without automatic command resubmission
- Durable admission deduplication and checkpoint recovery through an unpersisted gateway proxy
- Complete `WatchRunner` snapshot reconciliation and atomic in-memory route rebuilding, including tombstoned-entry rejection and cleanup request
- Binary open/data/window/end/reset behavior
- Conversation updates coalesce for slow viewers; infrastructure overflow and SSE reconnect replace the baseline
- Observation never wakes compute
- Live/offline harness ownership, close, and deletion are serialized
- Preview HTTP header/body streaming
- Preview WebSocket tunneling

### 30.3 Integration tests

Use real Pi Durable with a fake deterministic model where possible and real Gondolin/QEMU in Linux CI where available.

Scenarios:

- Enroll runner behind an outbound-only network boundary
- Clone public HTTPS repository
- Clone/push private HTTPS repository with guest-visible placeholder only
- Clone/push private SSH repository through Gondolin proxy
- Every clone/status/diff/fetch/commit/push process runs inside the guest, never on the runner host
- Stopped-session diff uses a final guest-generated cached Git Snapshot and wakes for refresh
- Provision setup hook
- Prompt → tools → settled → Stop → wake same disk → continue
- Stop during active work → reopen → Wake resumes checkpoints and queued Follow-ups
- Abort cancels queued inputs and owned background work but leaves compute running
- Model generation and environment control do not wait for guest boot/setup/resume
- Environment stop/restart leaves the harness running and prevents overlapping disk attachment
- Offline runner rejects message submission and exposes only the minimal catalog card, not cached full session data
- Ambiguous command handoff is visible; interrupted unsafe tools are not blindly repeated
- Planned edit last without workspace rollback, once its Durable interface is settled
- Diff review and wake-for-file browsing while the VM is stopped
- Browser terminal through data tunnel
- Managed preview wake/restart
- Live-only preview expiration
- Capability revocation
- Online idle deletion removes runner data; offline deletion removes the catalog card, records a minimal marker, and causes cleanup rather than resurrection if the runner later reconnects

### 30.4 Security tests

- A hostile workspace containing `.pi/extensions`, `.pi/settings.json`, package resources, prompt/system-prompt files, context files, skills, and themes cannot execute host code or alter the resources/system prompt returned to Pi
- Runner source/build checks forbid project discovery, ambient auth, and host execution adapters
- Pi/the model reaches workspace `AGENTS.md`, `CLAUDE.md`, and skill-associated scripts only through Gondolin-backed tools
- Project Checkout traversal and escaping symlink denied
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
- Durable queued input and distinct Stop/Wake/Abort controls
- Planned steering/edit-last controls only after their Durable contracts are defined
- Runner/resource selection before first send
- Runner lock after first send
- Terminal resize/input
- Preview private/capability flows
- Accessibility and keyboard navigation

## 31. Implementation milestones

Milestones are dependency-ordered, not calendar estimates. Each milestone should end in a demonstrable vertical slice.

### Milestone 0 — Foundation and contracts

- Create a Deno 2.9.5 TypeScript workspace with Deno-native manifests, lockfile, tasks, formatting, linting, checking, and tests.
- Pin Remix 3 and core dependency versions.
- Establish formatting, linting, tests, and CI.
- Define domain IDs, Effect Schema/RPC contracts, and the application protocol-version policy.
- Add architecture decision records for trust model, outbound tunnels, PostgreSQL, Pi-on-host, runner file storage, and the no-workspace-resource-discovery boundary.
- Implement and unit-test the explicit trusted Durable registry, guest execution adapter, and in-memory credentials.
- Enforce the audited harness boundary, with no host resource discovery, ambient auth, or host tool fallback.
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
- Persistent `root-disk.qcow2` with `/workspace` inside the guest
- `.agents/setup`/`.agents/resume`
- Stop/wake lifecycle and interrupted-Stop reconciliation
- Provisioning logs/events

**Exit:** First prompt provisioning can boot Gondolin, clone inside the guest, run setup, Stop, wake
from the same root disk, and preserve workspace state without Pi yet.

### Milestone 4 — Pi runtime and conversation

- Host-side Pi Durable Agent Harness
- Central model config delivery
- Milestone 0's trusted registry and in-memory credentials, with no workspace/global discovery
- Gondolin-backed Pi tools
- Private per-Session SQLite Harness State; separate infrastructure/configuration journal
- Complete Conversation View projection, snapshots and Chord operations, no second durable transcript
- HTTP prompt API and SSE stream
- Submission identity, durable Follow-ups, request-ID deduplication, and conversation-wide Abort
- Recoverable Stop/Wake and independent host-side Environment Control
- Model work concurrent with guest startup; cancellable guest readiness waits
- Offline runner rejection with only the minimal catalog card available
- Ambiguous-command reporting, checkpoint recovery, and partial unsafe-tool execution warnings
- Model/thinking controls
- Planned steering and edit-last semantics, pending Durable interface decisions

**Exit:** User can complete, pause, Wake, and continue a streamed Durable Session from desktop/mobile,
with queued work retained and reconnect replacing the Conversation View. Only the Workspace owner
plus four live-session catalog fields and minimal Workspace/session/time deletion markers are
stored by the gateway. Steering and edit-last remain explicit planned gaps until their contracts land.

### Milestone 5 — Review surfaces

- Aggregate Git status/diff generated inside Gondolin and cached outside the workspace
- Hostile `.git/config` regression tests
- Changed-file navigation
- Read-only file browser
- Runner-owned active Conversation View through the gateway proxy without waking compute
- Explicit unavailable state while the runner is offline
- Session archive on the online owning runner, online/offline deletion with durable anti-resurrection markers, and disk reporting

**Exit:** While the owning runner is connected, the user can inspect the active Conversation View
and guest-generated Git result from runner-owned data, without a pre-compaction archive promise.
The user can delete the session while the runner is online or offline without allowing a stale snapshot to resurrect it.

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
3. User can centrally configure a model API key, private Git credential, per-user Git author identity,
   project, and Workspace generic secrets with optional allowed hosts.
4. A Linux runner behind NAT enrolls using only gateway URL and enrollment token.
5. Runner reports free CPU/memory/disk and accepts a requested session size.
6. User can override the automatic runner before the first message and cannot move the session afterward.
7. Session starts host-side Durable work concurrently with isolated Gondolin boot, guest clone, and setup; guest tools wait cancellably for readiness.
8. Chat, thinking, tool calls, and tool output stream to desktop and mobile UI.
9. While the agent is running, normal sends become durable Follow-ups with stable Submission IDs and visible queue state. Explicit steering remains planned and requires a Durable contract; there are no current per-item queue mutation controls.
10. Sends are rejected while the assigned runner is offline. Admitted input and unfinished work persist in runner-owned Harness State; request-ID deduplication does not promise exactly-once execution, and ambiguous commands are not silently retried.
11. After 15 minutes idle, Stop Session closes the harness recoverably and durably stops compute; Wake resumes checkpointed work and the same root disk. Abort cancels conversation work without stopping compute, and Environment Control does not pause the agent.
12. While the owning runner is connected, the user can review the runner-owned guest-generated aggregate diff while the VM is stopped and wake it to browse files, without native host Git interpreting the checkout.
13. Browser terminal works without any inbound runner port.
14. Agent can fetch, commit, and push to a private repository without obtaining the real credential in the guest.
15. User can choose the pushed branch name.
16. Agent can publish a private managed preview that supports HTTP/WebSockets over the outbound tunnel.
17. Managed preview wakes and restarts after Stop; live-only preview clearly expires.
18. Capability preview links are revocable and do not expose gateway authentication to the guest.
19. Archive operates on the online owning runner. Explicit deletion is available online or offline, atomically removes the five-column Workspace-owned catalog row, stores only a Workspace/session/time deletion marker, and causes any later stale runner snapshot entry to be cleaned up rather than resurrected.
20. Pi never discovers project settings, packages, extensions, skills, prompts, themes, context files, or system-prompt fragments on the runner host; Pi/the model accesses project files and scripts only through Gondolin-backed tools.

## 33. Known risks and mitigations

### Remix 3 release-candidate churn

**Risk:** APIs and UI conventions may change.

**Mitigation:** Pin exact versions, follow current Remix 3 skill/docs, isolate adapters, and upgrade intentionally with route/component tests.

### Gondolin maturity and limitations

**Risk:** Experimental APIs, Alpine-only image builder, persistent-disk lifecycle, and serialized guest exec behavior.

**Mitigation:** Pin versions/build IDs and Debian OCI inputs, own a tested guest image, keep services explicitly process-managed, and maintain real-QEMU integration tests.

### Pi discovery defaults

**Risk:** A future harness or registry refactor could introduce project/global resource discovery,
ambient authentication, or a host execution adapter on the trusted runner.

**Mitigation:** Keep an explicit trusted Durable registry, guest-only execution, and in-memory
credentials. Test hostile workspaces and require security review for new tools or resource types.

### Durable recovery and uncertain execution

**Risk:** Request admission can succeed while its response is lost. Checkpoint recovery may repeat
model requests, and interruption may leave an unsafe tool partially executed. Calling `submit` even
for a duplicate can unexpectedly enable scheduling.

**Mitigation:** Let Durable own admission and recovery; acknowledge duplicates by reading the
persisted Submission. Surface ambiguous commands and unsafe-tool partial execution, never promise
exactly-once execution, and keep observation separate from Wake.

### Reverse tunnel complexity

**Risk:** Backpressure, WebSockets, slow consumers, and large assets can destabilize control traffic.

**Mitigation:** Separate control/data sockets, per-channel credit flow control, bounded buffers, fair scheduling, and exhaustive protocol tests.

### Credential mediation compatibility

**Risk:** Git/provider tools may use protocols or credential shapes not covered by Gondolin substitution.

**Mitigation:** Explicitly support tested HTTPS Basic/Bearer and SSH Git paths, fail closed, and document unsupported protocols.

### Pinned runner availability

**Risk:** A dead runner makes its sessions unavailable.

**Mitigation:** Show an explicit unavailable state, reject runner-backed session operations while offline, permit marker-backed offline deletion, add runner-side backups/exports later, and defer migration rather than implementing unsafe partial movement.

### PostgreSQL load and runner persistence growth

**Risk:** Gateway configuration/catalog traffic can exhaust PostgreSQL connections. Durable databases
and runner journals grow; a journal append may be incomplete after a crash.

**Mitigation:** Keep full Session data out of gateway PostgreSQL and use a bounded pool with short
transactions. Let Durable own database recovery/compaction; keep infrastructure journal appends
crash-checked and separate from conversation data. Do not claim the active view archives compacted
entries. Broader retention and journal compaction remain explicit future policies.

### Disk growth

**Risk:** Persistent root disks, Git objects, caches, and logs accumulate.

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
- Object-store backup of Session root disks
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
