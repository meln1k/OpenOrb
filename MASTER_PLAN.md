# OpenOrb Master Plan

> Living reference document for implementation. Update this document whenever a product or architectural decision changes.

The settled agent contracts follow the
[Durable integration decision](docs/adr/0004-durable-agent-independent-environment.md), the
[Session Durable Object harness placement](docs/adr/0005-agent-harness-in-session-durable-object.md),
[Agent Environment Providers](docs/adr/0006-agent-environment-providers-behind-execution-env.md),
[domain vocabulary](CONTEXT.md), and [security boundaries](security.md). Where ADR 0004 or the
[Published Media decision](docs/adr/0003-durable-published-media.md) describe runner-hosted agent
work, runner-owned Harness State, or runner-owned media storage, ADR 0005 supersedes them. Where
ADR 0005 leaves project setup/resume or Git Snapshots on the runner, ADR 0006 moves them into the
Session Durable Object.
Milestones and explicitly planned features below retain product goals, not alternative runtime
contracts.

## 1. Product summary

OpenOrb is an open-source, self-hostable system for running Pi coding-agent sessions on spare user-owned compute.

A user hosts one gateway, installs runners on Linux machines, and enrolls each runner with only:

```bash
openorb-runner start \
  --gateway https://openorb.example.com \
  --enrollment-token "$OPENORB_ENROLLMENT_TOKEN"
```

The runners may be on a home network, behind NAT or CGNAT, or on cloud VMs. They never require inbound ports. Each runner creates one Gondolin micro-VM per OpenOrb session. Pi runs in a per-Session Durable Object on the gateway and executes its file and shell tools inside Gondolin through a runner-relayed Environment Link, so conversations and published media stay available while a runner is offline.

The runner is the first **Agent Environment Provider**. The Agent Harness sees only Pi's `ExecutionEnv`; providers supply compute, lifecycle, persistence, network policy, and the Environment Link, while repository clone, setup/resume, Git Snapshots, skill discovery, and Published Media run in the Session Durable Object over `ExecutionEnv`. Sandbox-vendor providers can be added later behind the same boundary.

The primary experience is a responsive web UI for starting, monitoring, reviewing, and continuing remote coding-agent sessions from desktop or mobile.

### Motto

> If you have unused compute at home, you can run an agent on it.

## 2. Product principles

1. **Easy compute enrollment.** A new runner requires the gateway URL and an enrollment token, not model credentials, Git credentials, VPN setup, or inbound networking.
2. **Outbound-only runners.** Control, bulk, Environment Link, terminal, and preview traffic all use connections initiated by the runner.
3. **One session, one VM, one checkout.** This is the isolation and concurrency boundary.
4. **Trusted gateway and runner host, isolated guest.** The gateway hosts agent work and project behaviour (clone, setup/resume, Git Snapshots) in per-Session Durable Objects. The runner host is trusted for compute lifecycle and Egress Secret Mediation, but does not host agent work, receive model credentials, or store conversation content. Agent-generated commands, agent file operations, repository setup scripts, and every Git operation against a guest-writable checkout run inside the guest (Gondolin on a runner).
5. **Untrusted workspace metadata.** The entire checkout, including `.git`, is attacker-controlled data on the guest root disk. Native host Git must never consume it.
6. **Central configuration.** Model credentials, Git credentials, project secrets, project configuration, and defaults live in the gateway. Model credentials are resolved and used only inside the gateway.
7. **Automatic lifecycle.** VMs wake when needed and Stop after 15 minutes without relevant activity while retaining the Session's root disk.
8. **Useful remotely.** Chat, tools, diffs, files, terminals, and app previews must work without SSHing into a runner.
9. **Mobile-capable.** The main workflows must be usable from a phone, not merely render on a narrow screen.
10. **Web-standard interfaces.** Use HTTP, SSE, WebSockets, Fetch APIs, and versioned runtime-validated protocol types.
11. **Native gateway persistence.** The native celld Workspace Durable Object owns SQLite-backed gateway configuration and the minimal Session catalog. One Session Durable Object per Session owns Harness State and Published Media records in its own SQLite storage; Published Media bytes live in an R2 bucket. Do not add Redis or a second configuration database/KV service. The Session Durable Object also caches Git Snapshots and Project Checkout facts. Runners owns rebuildable live connection/routing state; runners own environment state (root disk, Session Journal, logs). For the MVP, do not require an SDN, Kubernetes, or a multi-node control plane.
12. **Workspace tenancy from the start.** Each user belongs directly to exactly one Workspace. Projects, secrets, provider/Git credentials, runners, enrollment credentials, session catalog rows, and deletion markers are owned by immutable `workspaceId`; composite foreign keys prevent cross-Workspace references. Passwords and Git author identity remain user-owned.

## 3. Scope

### 3.1 MVP scope

- Single-administrator gateway with Workspace-scoped tenant persistence
- Local password authentication and WebAuthn/passkeys
- Multiple outbound-only Linux runners
- Reusable or one-time runner enrollment tokens
- Automatic runner selection with an optional user override before the first prompt
- Predefined per-session CPU and memory requests
- Runner resource reporting and capacity-checked placement
- One fresh repository checkout and Gondolin VM per session
- Agent Environment Provider boundary behind Pi's `ExecutionEnv`, with the OpenOrb runner as the first provider; provider selection by Workspace default, Project override, and Session override at creation
- Pi Durable Agent Harness hosted in a per-Session gateway Session Durable Object
- Central API-key model credentials and custom compatible model definitions, resolved only inside the gateway
- Linear conversation UI
- Streaming assistant text, thinking, tool calls, and tool results
- Durable Submissions, including Follow-ups while the agent is busy
- Session Durable Object-owned Harness State for admitted input, queued work, and recovery, readable while the runner is offline
- Planned conversation-only “edit last message”; workspace changes remain
- Aggregate Git diff and changed-file view
- Read-only file browser
- Browser terminal
- Agent- and user-created HTTP previews
- Private previews and optional revocable capability links
- Managed restartable previews and live-only previews
- Central HTTPS Git credentials and SSH private keys
- Agent-initiated Git fetch, commit, and push without exposing real credentials to the VM (on providers with Egress Secret Mediation, such as the runner)
- User-defined push branch names
- Project `.agents/setup` and `.agents/resume` hooks, run by the Session Durable Object over `ExecutionEnv` and executed only inside the guest
- Explicit trusted Durable registry, in-memory credentials, and no project or global Pi discovery
- Batteries-included Gondolin guest image
- Ephemeral guest package caches
- Archive and explicit deletion
- Minimal Workspace-owned gateway live-session catalog (project, creation time, trimmed initial prompt) plus Workspace-owned deleted-session ID/time markers; conversation content and Published Media records are Session Durable Object-backed, Published Media bytes are R2-backed, and environment data is runner-backed
- Clean break from runner-hosted sessions: no migration, and runner protocol v27 is not backward compatible

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
- Additional model-provider OAuth/subscription logins beyond OpenAI Codex
- Automatic pull-request creation
- Automatic gateway- or runner-side Pi loading of project context files, settings, packages, extensions, skills, prompts, themes, or system-prompt fragments (passive guest repository skill metadata is supported)
- Arbitrary untrusted project Pi extensions
- Memory/process VM snapshots
- GPU scheduling
- Generic TCP preview forwarding

## 4. Terminology

- **Gateway:** The self-hosted Remix web application, API, scheduler, secret store, runner gateway, and preview gateway.
- **Runner:** A native Linux service and the first Agent Environment Provider. It manages Gondolin VMs and Persistent Root Disks, relays Environment Links, and mediates guest network credentials. It does not run Pi, clone repositories, run setup/resume hooks, or produce Git Snapshots.
- **Agent Environment Provider:** The authority that creates, starts, stops, and deletes Agent Environments and opens Environment Links to them, such as an OpenOrb runner or a future sandbox vendor. It supplies compute, lifecycle, persistence, and network policy, never project behaviour, and declares its capabilities (persistence, Egress Secret Mediation, hibernatable link).
- **Egress Secret Mediation:** Substitution of real credentials for guest-visible placeholders outside the guest, so the real values never enter it. The runner provides it through Gondolin.
- **Guest Credential Opt-in:** A Project's explicit consent to place real Git credentials and Workspace secrets inside guests whose provider lacks Egress Secret Mediation.
- **Runner Registry:** The Runners Durable Object: live runner connections, presence, command routing, and live environment projections.
- **Session Durable Object:** The per-Session gateway Durable Object that hosts the Agent Harness and owns Harness State, the Conversation View, Published Media records, and Stop Session orchestration.
- **Environment Link:** The connection over which a Session Durable Object reaches the Environment Daemon of its Agent Environment. Its provider determines how it is opened; for the runner it is a runner-initiated per-Session WebSocket.
- **Environment Daemon:** The unmodified static pi-env daemon running inside the guest that performs the harness's file and shell operations.
- **Git Snapshot:** A bounded point-in-time summary of a Project Checkout's Git state, generated by guest Git and cached by the Session Durable Object independently of the Agent Environment's lifecycle.
- **Published Media:** Immutable images or videos the agent publishes from the guest artifact directory into private, Session-owned object storage.
- **Project:** Repository configuration, credentials, secrets, defaults, and policies shared by sessions.
- **Session:** A durable association between a conversation and its Project Checkout, pinned to one Agent Environment Provider (on the runner provider, one runner), with at most one running Agent Environment.
- **Draft session:** A session whose first prompt has not been sent. Its provider and runner selection can still change.
- **Workspace:** The tenant that owns projects, credentials, secrets, runners, enrollment credentials, and the session catalog. Each user belongs directly to one Workspace.
- **Project Checkout:** The session-specific checkout at `/workspace` inside the Agent Environment; on a runner it lives on the Persistent Root Disk.
- **Persistent Root Disk:** The private, sparse 40 GiB `root-disk.qcow2` that a runner retains for one Session and reopens in each new VM.
- **Agent Harness:** Provider-neutral agent capability hosted by the Session Durable Object; currently implemented with Pi Durable.
- **Harness State:** Durable conversation, queued inputs, and unfinished agent work needed to continue a Session.
- **Submission:** One admitted input with its own stable identity, whether it starts work or becomes a Follow-up.
- **Agent Run:** A continuous period of agent activity, including Follow-ups and automatic continuations, ending when the agent settles.
- **Follow-up:** Input added to the current Agent Run rather than starting another.
- **Conversation View:** The current active transcript, queued input, agent configuration, usage, and live progress shown to a viewer.
- **Session Journal:** Runner-owned infrastructure facts such as VM and disk lifecycle, separate from Harness State. Provisioning and checkout facts belong to the Session Durable Object.
- **Agent Environment:** Live isolated compute capabilities and the Project Checkout available to the harness.
- **Stop Session / Wake:** Recoverably pause agent work and durably stop compute / resume both.
- **Abort:** Cancel agent work and queued inputs without stopping the Agent Environment.
- **Environment Control:** Agent-initiated start, stop, or restart of compute through its provider without pausing the harness.
- **Lease:** A reason a VM must remain awake, such as active agent work, a terminal, project setup, or a preview.
- **Managed preview:** A preview with a restart command that can wake and resume after VM Stop.
- **Live-only preview:** A published port without a restart command; it expires when the VM Stops.
- **Capability link:** An unlisted, revocable preview URL that grants access without gateway login.

## 5. Locked product decisions

| Area | Decision |
|---|---|
| Initial audience | Single user on trusted user-owned compute |
| VM mapping | One Agent Environment per session; one Gondolin VM per session on the runner provider |
| Pi placement | Pi Durable runs in one gateway Session Durable Object per Session behind the Agent Harness interface; it never runs on the runner host |
| Tool execution | Pi read/write/edit/bash operations use Pi's `ExecutionEnv`. Providers that run the static Environment Daemon (including the runner) share the vendored pi-env `RemoteExecutionEnv` client and differ only in Environment Link transport; a provider may instead return its own `ExecutionEnv` |
| Agent Environment Provider | The OpenOrb runner is the first provider; providers supply compute, lifecycle (start/stop/restart/delete), persistence, network policy, and Environment Link opening, never project behaviour, and declare persistence (durable root disk, vendor snapshot, or ephemeral), Egress Secret Mediation, and hibernatable-link capabilities |
| Provider selection | Workspace default; Project override; Session override at creation; immutable afterward. Only the runner provider exists; the Session record stores its provider kind and the Project's Guest Credential Opt-in, while Workspace/Project storage and UI for provider defaults are deferred until a second provider exists |
| Project behaviour | Repository clone, `.agents/setup`/`.agents/resume`, Git Snapshots, skill discovery, and Published Media run in the Session Durable Object over `ExecutionEnv` |
| Repository | Fresh clone per session, issued by the Session Durable Object and performed inside the guest |
| Workspace storage | On the runner, a private per-session qcow2 root disk; `/workspace` and `.git` are untrusted guest bytes, not a host mount |
| Git execution boundary | Never run native Git on the gateway or a provider host against a session checkout; all clone/status/diff/fetch/commit/push operations execute inside the guest |
| Session placement | Auto-select runner within the runner provider; user may override before first prompt; immutable afterward |
| Resource scheduling | Sessions select `tiny`, `small`, `medium`, `large`, or `xxlarge`; runners advertise allocatable CPU, memory, disk, and active-session counts |
| Idle lifecycle | Session Durable Object alarm Stops after 15 minutes without relevant activity; retain the persistent root disk |
| Conversation | Linear active Conversation View; not an archive of pre-compaction entries |
| Edit last | Planned conversation-only edit; do not roll back files or VM state; Durable interface still to be designed |
| While running | Normal send admits a Durable Submission with `whenBusy: "followUp"` |
| Queued input | Owned durably by the harness; no separate OpenOrb handoff queue or per-item mutation API |
| Offline/waking runner | Session Durable Object admission and model work need neither a connected runner nor a ready guest; the agent session is always available, and conversation, media, and the cached Git Snapshot remain viewable while the runner is offline. Guest tools fail immediately while the runner or provider is unreachable, without waiting, so the agent can choose another approach; they wait cancellably only while a reachable environment boots or runs setup/resume |
| Stop / Wake / Abort | Session Durable Object pauses the harness recoverably before asking the runner to stop compute; Wake resumes checkpoints; Abort cancels conversation work without stopping compute |
| Model credentials | Centralized in gateway; resolved from the Workspace DO inside the gateway and never sent to runners; API keys first |
| Git credentials | Centralized HTTPS tokens and SSH private keys |
| Guest credentials | With Egress Secret Mediation (runner/Gondolin), the GitHub token and Workspace secrets stay outside the guest. On a provider without it, they enter the guest only with a per-Project Guest Credential Opt-in; otherwise the Session runs without them |
| Git push | Agent may push, with credentials mediated outside the guest or present under Guest Credential Opt-in |
| Commit identity | Per-user defaults, with room for project overrides |
| Networking | Mediated HTTP/HTTPS by default; internal ranges blocked |
| Previews | Private by default; optional revocable capability access |
| Preview domain | Wildcard preview domain is acceptable |
| Preview lifecycle | Managed previews wake/restart; live-only previews expire on sleep |
| Runner OS | Native Linux first |
| Gateway UI | Remix 3, end-to-end TypeScript |
| Gateway persistence | Native celld Workspace DO SQLite, for configuration, a five-column Session catalog (`workspaceId` plus four catalog fields), and three-column deletion markers (`workspaceId`, `sessionId`, `deletedAt`); per-Session Session DO SQLite (pi-durable `storage/sqlite/cloudflare` adapter) for Harness State and Published Media metadata/quota; an R2 bucket for Published Media bytes; no Redis or secondary configuration store |
| Tenant ownership | Direct `users.workspaceId`; Workspace RPC methods receive authenticated `workspaceId`, tenant uniqueness is composite with `workspaceId`, and foreign keys prevent cross-Workspace references. Passwords and Git author identity use `userId`. No memberships, new roles, tenant abstractions, or Workspace-selection UI |
| Runner persistence | Private files for the infrastructure-only Session Journal (VM/disk lifecycle), logs, and root disk; no Harness State, conversation content, media, Git Snapshots, or checkout facts |
| Browser streaming | HTTP commands + Session DO SSE events + dedicated WebSockets for terminal/preview |
| Runner transport | Outbound Effect RPC control WebSocket carrying only runner identification, the environment watch stream, and `environment.*` procedures; an authenticated bulk WebSocket carrying only identification and a heartbeat, reserved for planned terminal/preview tunnels; and one dedicated per-Session Environment Link WebSocket |
| Migration | Clean break: runner-hosted Sessions are not migrated; runner protocol v26 was not backward compatible with v25, and v27, which removes every `session.*` procedure, rejects v26 runners |
| Pi workspace resources | Explicit trusted Durable registry; no project/global discovery or ambient credentials |
| Project guidance | Repository skill metadata is discovered by the Session Durable Object over `ExecutionEnv` after project readiness; full instructions and other project files are available through guest tools. Pi does not load (in the gateway or on the runner host) `AGENTS.md`, `CLAUDE.md`, skills, prompts, packages, settings, or extensions |
| Guest image | Batteries-included OpenOrb Gondolin image |
| Caches | Guest package caches are tmpfs-backed and do not survive Stop; shared host caches are deferred |
| Retention | No automatic deletion; explicit archive and delete; offline delete is represented by a durable minimal control-plane marker |

## 6. High-level architecture

```text
                                      Public Internet

 Browser ───── HTTPS/SSE/WS ─────┐
                                 │
 Preview client ─ HTTPS/WS ──────┼──► Gateway
                                 │    ├── Native celld Worker: Remix 3 web application
                                 │    ├── Browser HTTP API + SSE
                                 │    ├── Authentication
                                 │    ├── Workspace DO: SQLite configuration/encrypted secrets/catalog
                                 │    ├── Runners DO: live registry, scheduler, and routing
                                 │    ├── Session DO per Session: Pi Durable Agent Harness,
                                 │    │   SQLite Harness State, media records, idle/Stop alarm,
                                 │    │   clone, setup/resume, Git Snapshots over ExecutionEnv
                                 │    ├── R2 bucket: Published Media bytes
                                 │    ├── Named native DO RPC; runner Effect RPC WebSockets
                                 │    └── Wildcard preview gateway
                                 │
                                 │             ▲
                                 │             │ outbound TLS/WebSockets only
                                 │             │ (control, bulk, per-Session Environment Links)
                                 │             │
                                 │          Runner behind NAT (first Agent Environment Provider)
                                 │          ├── Effect RPC identity and state streams
                                 │          ├── Persistent Root Disk storage and Session Journal
                                 │          ├── Environment Link relay (verbatim frames)
                                 │          ├── GitHub/secret Egress Secret Mediation
                                 │          ├── Gondolin lifecycle manager
                                 │          ├── Terminal bridge
                                 │          └── Preview supervisor
                                 │                    │
                                 │                    ▼
                                 │             Gondolin VM
                                 │             ├── persistent root disk with /workspace
                                 │             ├── Environment Daemon (static pi-env)
                                 │             ├── developer toolchain
                                 │             ├── setup/resume hooks
                                 │             ├── managed dev services
                                 │             └── mediated egress/ingress
                                 └────────────────────────────────────────────
```

The Session Durable Object is the only conversation store. It reaches the guest only through Pi's
`ExecutionEnv` over its Environment Link and reaches the runner's compute lifecycle through the
Runners DO. It runs project behaviour itself over `ExecutionEnv`: repository clone and branch
creation, `.agents/setup` and `.agents/resume`, Git Snapshots, skill discovery, and Published Media.
The runner supplies compute, the Persistent Root Disk, and Egress Secret Mediation, and relays
Environment Daemon frames without interpreting them.

The runner is one Agent Environment Provider. A future sandbox-vendor provider replaces the runner
box above with vendor compute: if it can run the static Environment Daemon it reuses the vendored
`RemoteExecutionEnv` and supplies only its link transport, otherwise it returns its own
`ExecutionEnv`. Either way the Session Durable Object's project behaviour is unchanged.

### 6.1 Why no SDN in MVP

Tailscale or another SDN would add node enrollment, identity, routing, ACL, and deployment complexity. OpenOrb only needs a narrow set of application streams. An outbound reverse tunnel provides those streams without exposing the runner network or requiring a public runner address.

A future optional direct or SDN-backed data path may change the separate data-plane service without changing session, preview, or terminal APIs.

## 7. Repository and package shape

Current package boundaries:

```text
packages/
  gateway/                 native celld Worker serving Remix 3
  gateway/app/cells/workspace/  SQLite configuration, auth, catalog, OAuth, and SQL migrations
  gateway/app/cells/runners/    live runner connections, capacity, and Environment Control routing
  gateway/app/cells/session/    Session DO: Agent Harness, provisioning, Git Snapshots, media, skills
  runner/                  published Linux runner CLI/service
  protocol/                shared runtime schemas and wire types
  result/                  small shared result helpers
  runner/src/environment/   Agent Environment interface, Gondolin provider, and Environment Link dialer/relay
  runner/src/environment/session/  EnvironmentSupervisor/EnvironmentActor and the JSONL Session Journal
  pi-env/                  vendored pi-env RemoteExecutionEnv client (WebSocket, Web APIs)
images/
  guest/                   OpenOrb Gondolin image build configuration
scripts/                   build, release, and verification tasks
docs/
  adr/
  operations.md
security.md
MASTER_PLAN.md
```

Under ADR 0005 and ADR 0006 the Agent Harness, Durable adapter, Conversation View projection,
Published Media handling, repository clone, setup/resume, Git Snapshots, and skill discovery live in
the gateway Session Durable Object, beside the Workspace and Runners cells. The runner-hosted agent
path, including `packages/runner/src/harness/**` and the runner's session actor, store, events,
artifact store, provisioning, and Git Snapshots, has been removed. Runner code keeps only Agent
Environments: environment lifecycle, the Session Journal, Persistent Root Disks, Egress Secret
Mediation, and the Environment Link. `packages/pi-env` holds the vendored
`RemoteExecutionEnv` client and the transport-free daemon relay shared by the Session DO and the
runner.

Use a Deno-native workspace with strict TypeScript and require stable Deno 2.9.5 or newer for development,
gateway builds, and source runners. Native celld executes gateway requests; Deno does not serve them.
Pin CI, lockfile generation, and release runner compilation to Deno 2.9.5 for reproducibility. `deno.json`/`deno.lock` are
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
- Pin an exact release (currently 3.0.0); never track `next` implicitly in lockfiles
- Use Remix 3 conventions rather than Remix v2 conventions
- `app/routes.ts` is the typed URL contract
- Controllers under `app/actions`
- Middleware for auth, sessions, CSRF, native DO services, and request context
- `remix/ui`, not React
- Browser `/assets` serves an explicit allowlist of application modules and audited browser dependency
  files, including Chord's structural-delta code. Never broadly expose server dependencies or the
  Deno-owned `node_modules` tree; audit each browser dependency closure before expanding access.
- `server.ts` exports the public native celld Worker fetch handler plus `Workspace`, `Runners`, and the per-Session Session Durable Object, all extending native `DurableObject` from `cloudflare:workers`
- The Worker forwards runner control/bulk WebSocket upgrades to Runners DO `fetch`, Environment Link upgrades and authenticated viewer SSE to the owning Session DO, and other requests to Remix's Fetch-oriented router
- Worker handlers use named native Workspace/Runners/Session RPC methods for configuration and commands; no public generic Workspace RPC endpoint exists
- Each Session DO hosts Pi Durable with pi-durable's `storage/sqlite/cloudflare` adapter over its own SQLite storage, accepts its Environment Link as a hibernatable WebSocket, and uses a native alarm for idle timeout and Stop Session orchestration
- Published Media bytes live in an R2 bucket under `workspaces/{workspaceId}/sessions/{sessionId}/media/`; the Session DO validates writes and records metadata and quota
- Deno builds Worker/browser assets and model metadata into gateway `dist/`; requests use the `ASSETS` binding, not a runtime compiler or host filesystem
- `remix/data-schema` for runtime validation
- Workspace relational SQLite uses native `ctx.storage.sql`; `remix/data-table` declarations describe row shapes, while committed plain SQL migrations enforce the schema
- Remix's migration journal/checksums run inside one native storage transaction, with `blockConcurrencyWhile` gating Workspace startup
- Session DOs migrate OpenOrb's own tables with the same driver and journal when each object starts; Pi Durable versions its tables separately in `durable_schema`
- Workspace owns configuration, browser identities/sessions, enrollment, the minimal Session catalog, deletion markers, and alarm-driven provider OAuth
- Runners owns ephemeral control/bulk sockets, runner authentication, presence and capacity, live environment projections, and Environment Control routing by connection generation; it notifies Session DOs when an environment is updated, removed, unreachable, or revoked. Reconnecting runners' environment snapshots rebuild that state after restart or eviction. It closes a revoked runner's Environment Links. It does not route Sessions, hold reservations, or write the Session catalog
- Session DOs own Session creation and deletion (including environment deletion retried by their alarm), Harness State, the Conversation View, viewer streams, Published Media records, Stop Session orchestration, provider selection, Project Checkout facts, the Git Snapshot cache, skill discovery, and clone/setup/resume over `ExecutionEnv`
- No PostgreSQL pool, secondary configuration store, or PostgreSQL/legacy KV import is used; the former integer-ledger bootstrap is unsupported

Use the existing native DO boundaries and migration adapter. An exact dependency upgrade must be an intentional implementation task with tests.

### 8.2 Server request split

```text
Native celld Worker (server.ts)
├── runner control/bulk upgrades → Runners DO fetch → Effect RPC/bulk sockets
├── Environment Link upgrades   → Session DO fetch (runner token + one-time attach nonce)
├── normal HTTP                 → Remix router → named Workspace/Runners/Session RPC
├── conversation commands       → authenticated Remix action → Session DO RPC
├── session event SSE           → authenticated Remix action → Session DO fetch
├── Published Media/inline images → authenticated Remix action → Session DO (R2/Harness State)
└── planned terminal/preview gateways
    ├── /api/sessions/:id/terminal → TerminalGateway
    └── preview wildcard host     → PreviewGateway (separate origin)
```

Guest preview content must never be served from the gateway’s origin.

The local runtime uses `packages/gateway/wrangler.jsonc` with colocated bundles and persistent
`packages/gateway/.celld/dev` state. Production fleet provisioning, secret injection, and
storage/backup interfaces require a reviewed procedure; the local dev command is not a production
deployment contract. See [gateway operations](docs/operations.md).

### 8.3 Single-administrator authentication

- First-run setup atomically creates one Workspace, the single admin user, and their password credential; concurrent attempts cannot create another administrator or an orphan Workspace.
- User IDs are application-generated UUIDv7 values stored in Workspace SQLite `TEXT` columns.
- The current Workspace database enforces one Workspace and one administrator. Every user has a required direct `workspaceId` foreign key. Browser auth is `{userId, workspaceId}`, resolved from persisted user/session records and rejected on mismatch, never selected by request input. Additional users/Workspace selection remain deferred.
- Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with exactly 600,000 iterations, a random 16-byte salt, and a 256-bit derived key. The fixed profile is runtime validated; there is no Argon2 compatibility path.
- Planned passkeys use WebAuthn and require HTTPS except for local development; the current Workspace schema has no passkey table.
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
- Workspace rejects a missing or invalid master key and never generates a replacement or stores it in its tables. Local development prepares private `.dev.vars` from operator-supplied `.env`/environment bindings; those secret files are not committed.
- Import the 256-bit master key with Web Crypto and encrypt with `@std/crypto`'s `encryptAesGcm()`/`decryptAesGcm()`. Persist the returned nonce/ciphertext/tag bytes unchanged as one opaque value, store key version separately, and authenticate immutable `workspaceId`, credential key, and key version as AAD.
- Store each secret as an `encrypted_secrets` row with composite primary key `(workspaceId, key)`, an explicit required purpose, and opaque ciphertext BLOBs. Provider API keys use `provider-api-key`; OpenAI Codex OAuth credentials use `provider-oauth`. Both are referenced by provider ID through `model_provider_credentials`; generic secrets use `generic-secret`; rows referenced by `git_credentials` use `git-credential`. Workspace selects rows by both owner and purpose rather than key-prefix conventions. Provider identity never derives from an environment-variable-style secret name.
- Never derive the server encryption key from the login password; the service must restart unattended.
- Local backups are incomplete without the celld Workspace state and original master/session secrets. Stop celld and keep SQLite/WAL sidecars together; production fleet backup/restore remains undecided. See [gateway operations](docs/operations.md).
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

The compiled runner uses one least-privilege Deno process: read/write is scoped to its working directory, network is unrestricted because Gondolin's host-side mediation of guest egress must reach arbitrary public hosts, subprocess permission is limited to the architecture-appropriate QEMU suite, FFI is disabled, and environment/system permissions are narrow. Deno network permission is not the SSRF boundary; application/Gondolin egress policy must still block loopback, private, link-local, cloud-metadata, redirect, and DNS-rebinding targets. QEMU children are outside Deno's sandbox, so OpenOrb exposes no raw-QEMU interface and creates VMs only through pinned Gondolin `VM` options owned by trusted code.

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
2. Workspace derives the immutable owner from the persisted enrollment token, stores `workspaceId` with enrollment and runner identity, and returns a stable runner ID plus bearer token. Subsequent authentication resolves ownership from the trusted token/runner record. Runner payloads cannot choose or change tenant ownership. At most one active reusable enrollment PSK exists per Workspace.
3. The runner stores the bearer token in its data directory with mode `0600`.
4. On each outbound RPC connection, the gateway invokes `IdentifyRunner`; the runner returns the bearer token, claimed runner ID, runner version, and application protocol version.
5. The gateway admits the connection only after the token, claimed identity, revocation state, and protocol version pass authentication.
6. The shared enrollment PSK is not used as the runner’s ongoing identity.
7. The gateway can revoke one runner without regenerating the enrollment PSK.

The current reusable enrollment token is always available per Workspace. Regeneration atomically revokes
the previous token and creates its replacement, while Workspace SQLite enforces one token row per
Workspace. Reusable enrollment tokens support homelab convenience; one-time tokens remain planned
for safer automation.

### 9.3 Outbound connections

Each connected runner maintains an outbound Effect RPC control WebSocket:

```text
wss://openorb.example.com/api/runners/connect
```

The runner opens the physical socket and serves `RunnerApi`; the gateway accepts the socket and acts
as the RPC client. The API contains only typed identity, the runner/environment watch stream, and
environment creation, control, attach, and deletion procedures (§22.2); prompt, abort, and
thinking-level commands, clone, setup/resume, Git Snapshots, and media belong to the Session DO, not
the runner. Effect owns framing, schema decoding, request correlation, stream
acknowledgement, interruption, and ping/pong.

A separately authenticated outbound bulk WebSocket at `/api/runners/connect/bulk` carries only
`runner.bulk.identify` and the `runner.bulk.watch` heartbeat. It is kept for planned terminal and
preview tunnels; the former `session.git-patch.read-chunk` and `session.artifact.read-chunk`
procedures are removed, because full Git Snapshot patches stay in the guest and are read over the
Environment Link, and Published Media is read by the Session DO. Generic terminal/preview tunneling
is still planned; its flow-control design must preserve control-channel responsiveness.

While a Session's Agent Environment runs, the runner also dials one dedicated outbound Environment
Link WebSocket to that Session's Session DO, authenticated by its runner token plus a one-time
attach nonce, and relays Environment Daemon frames verbatim (see §22.6). Environment traffic is not
multiplexed over the control socket, so it never passes through the single Runners DO. The runner
dials `/api/runners/environments/<sessionId>/link`.

## 10. Runner storage

This section describes the runner provider. The runner owns environment persistence only: the
infrastructure Session Journal, the Persistent Root Disk, and logs. Harness State, conversation
content, Published Media metadata, Git Snapshots, and Project Checkout facts (base commit, branch,
remote, and setup state) live in the gateway Session DO; Published Media bytes live in R2. The
Session Journal records VM and disk lifecycle facts, not `message.accepted` or any other
conversation fact, nor provisioning, clone, setup, or checkout facts. Sensitive identity, token, and
disk files use restrictive filesystem permissions.

Environment storage layout (under the runner's working directory):

```text
/var/lib/openorb-runner/
  images/
  environments/
    <session-id>/
      events.jsonl         infrastructure Session Journal only (JSONL; VM/disk lifecycle)
      root-disk.qcow2
      runtime.json         pinned guest-image release for this disk
  environment-deletions/   environments being removed
```

The runner's EnvironmentSupervisor owns one EnvironmentActor per directory. The former
`sessions/<session-id>/` layout, including its Durable `harness/` database and artifact store, is not
read.

The runner is authoritative for environment data; the Workspace DO duplicates only the immutable
Workspace owner and four catalog fields described below and retains minimal Workspace-owned
deleted-session ID/time markers:

- Environment definition: Session and Workspace identity, runner identity, orb size, and the
  repository URL and Git author that scope credential mediation
- Session Journal infrastructure facts, not a second agent task state machine
- Working tree and Git objects on the root disk, treated as untrusted bytes by the host
- Full file contents
- Preview definitions, access policy, and capability hashes
- Persistent 40 GiB sparse `root-disk.qcow2`
- Guest service logs

The Session DO is authoritative for agent data:

- Durable Harness State: conversation entries, Submissions, queued inputs, tasks, usage, model and
  thinking configuration, inline conversation images, and recovery
- Published Media metadata and quota accounting (bytes in R2)
- Idle-timeout and Stop Session orchestration state
- The selected Agent Environment Provider
- Project Checkout facts reported by guest Git (base commit, branch, remote, pushed state) and
  setup/resume progress, treated as untrusted data
- The cached Git Snapshot, generated inside the guest

The session root disk is guest-writable and opaque to ordinary host file tools. The runner stores and
deletes it as a private file, but must never attach it to multiple writable VMs or invoke native host
Git—or another executable selected by workspace metadata—against its contents.

The Workspace DO persists gateway configuration:

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

No runner ID, title, status, branch, model selection, transcript, message, tool, event cursor, usage, diff, file, log, preview, capability, Git state, or root-disk state is persisted in the Workspace DO. Conversation content, model configuration, usage, Git Snapshots, and Git state live only in that Session's Session DO; files, logs, previews, capabilities, and root-disk state remain runner-owned. The only Workspace DO session record outside the live five-column catalog is a deleted-session marker containing immutable Workspace ID, session ID, and deletion time. The gateway writes the catalog row when it creates a Session, before the Session DO starts it; the runner assignment lives in the Session DO record. After authentication, each runner streams a complete bounded initial `WatchRunner` snapshot of its environments. The gateway derives the owner from the authenticated runner record, never from runner-supplied tenant data, and atomically installs a Workspace-scoped in-memory environment index only after the snapshot completion boundary. Runner snapshots never create, restore, or delete catalog rows; an environment reported for a deleted Session is ignored by its Session DO.

## 11. Domain model

Workspace-owned project/configuration entities, the five-column `SessionCatalogEntry`, and minimal Workspace/session/time deletion markers are persisted by the Workspace DO. Passwords and Git author identity remain user-owned. Harness State, Submissions, Published Media records, the Session's provider selection and runner assignment, Project Checkout facts, and Git Snapshots are persisted by the Session DO. Agent Environment state, planned previews, and VM/disk lifecycle facts are persisted only by their owning runner and reported to the Session DO through the Runners DO.

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

A Workspace selects a default Agent Environment Provider and a Project may override it. A Project
also records its Guest Credential Opt-in, which only matters on providers without Egress Secret
Mediation. Only the runner provider exists today, so Workspace and Project storage and UI for the
provider default, override, and opt-in are deferred until a second provider exists; their
configuration shapes are To be decided.

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

A Session may override the Project's provider at creation and is then pinned to that provider;
`runnerId` applies only to the runner provider. The Session DO record stores the selected provider
kind (only `runner` exists), the Project's Guest Credential Opt-in as of creation, the runner
placement, and the Project Checkout facts (`baseCommit`, `branchName`, `branchPushed`).

### 11.4 Orthogonal runtime state

Do not create one giant state enum. The current wire contract exposes separate agent state
(`idle`, `running`, `paused`, `error`), environment state (`starting`, `running`, `stopping`,
`stopped`, `error`), checkout availability, provisioning stage, and bounded issues/recovery actions.
See [the runtime schemas](packages/protocol/src/runner-api-session-events.ts). Agent work can be
running while compute is stopped or starting. Runner connectivity and planned archive/preview
state must not collapse those independent dimensions. The runner reports only environment state in
its environment snapshots; the Session DO combines it with runner reachability, its own agent state,
checkout availability, setup/resume stage, and issues.

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

Resource scheduling applies to the runner provider; a sandbox vendor's capacity is its own concern. Orb sizes resolve to fixed resources: `tiny` is 1 CPU/2 GB, `small` is 2 CPUs/4 GB, `medium` is 4 CPUs/8 GB, `large` is 8 CPUs/16 GB, and `xxlarge` is 16 CPUs/32 GB. `medium` is the default. The runner persists the selected size and resolves it authoritatively whenever it creates or recreates the VM.

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

The event also carries a monotonic runner revision and observation timestamp. Environment state is
sent through the initial `snapshot.environment` elements and later
`environment.updated`/`environment.removed` stream elements rather than embedded in a periodic
transport message.

### 12.2 Placement

Current placement:

1. Filter connected, non-revoked runners whose live capacity fits the orb size and keeps at least
   10 GiB of disk free.
2. Honor an explicit draft runner selection if it can accept the request.
3. Otherwise choose the runner with the fewest active sessions, breaking ties by runner ID.
4. The gateway records the catalog row, then creates the Session DO with the selected runner as its
   placement. There is no gateway-side reservation.
5. The Session DO asks the runner through the Runners DO to `environment.create`; the runner
   re-checks local resources authoritatively before creating durable state and rejects with
   `CapacityExceeded` when it cannot host the environment.
6. Never retry an ambiguous creation handoff blindly; `environment.create` is idempotent for the same
   Session, so an explicit retry is reconciled against durable runner state.

A runner observation is advisory; `environment.create` acceptance is authoritative. Planned:
labels, architecture requirements, draining, free-resource scoring, and trying the next candidate
after a definite capacity rejection.

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
2. The Agent Environment Provider resolves from the Workspace default, the Project override, and an
   optional Session override; it is fixed once the first prompt is sent.
3. For the runner provider, the scheduler displays the currently selected automatic runner and the
   user may override it while drafting.
4. Sending the first prompt selects an online runner (§12.2). The Workspace DO stores only the
   Workspace owner and four catalog data fields with the trimmed prompt preview; the runner
   assignment is stored in the Session DO record, not the catalog row.
5. The Session DO asks the runner to create the session's environment state (Persistent Root Disk,
   Session Journal) through `environment.create`; the Session is then permanently assigned.
7. The Session DO opens the Durable harness and admits the full initial input concurrently with
   environment startup. Model work and trusted prompt preparation do not wait for guest readiness.
8. The runner creates the persistent session root disk, boots Gondolin with requested resources,
   creates `/workspace` inside the guest, starts the Environment Daemon, and dials the Environment
   Link to the Session DO.
9. Over `ExecutionEnv`, the Session DO runs guest Git to clone the repository through mediated
   HTTPS/SSH credentials (or opted-in guest credentials on a provider without Egress Secret
   Mediation) and reads the exact base commit.
10. Guest Git creates the local working branch.
11. The Session DO stores the reported base/branch state in its SQLite storage as untrusted data.
12. As soon as the session branch is checked out, the Session DO starts the one-time skill discovery
    in the background, then runs `.agents/setup` once inside the guest. Guest
    tools wait cancellably for that readiness while the environment is reachable and fail
    immediately while it is not; Session DO-side Environment Control is available immediately.

The Session DO streams clone and setup output to the browser as Session Events.

### 13.2 Subsequent normal message

1. Gateway routes the send to the Session's Session DO; admission does not require the assigned
   runner to be connected.
2. The Session DO receives the prompt with a stable `clientRequestId`, serializes admission, and
   opens or updates the harness using provider credentials resolved from the Workspace DO and held
   only in memory.
3. Durable admits the input with `whenBusy: "followUp"`; acceptance returns `clientRequestId` and
   `submissionId`, not completion of the Agent Run.
4. If the Session was paused, harness opening and environment startup proceed independently. The
   Session DO asks the runner to start compute; the runner reopens the same disk, recreates
   transient policy/placeholders, and re-establishes the Environment Link, after which the Session
   DO runs `.agents/resume` over `ExecutionEnv`.
5. If the agent itself stopped compute through Environment Control, ordinary tools fail explicitly
   until the environment is started. If the runner or provider is unreachable, guest tools fail
   immediately without waiting, so the agent can choose another approach. Admission and model work
   never depend on a reachable runner or a ready guest.
6. Do not automatically retry an ambiguous command outcome. Durable deduplicates admitted request
   IDs; explicit reconciliation must not enable scheduling merely to acknowledge a duplicate.
7. Stream the Conversation View from the Session DO, refresh guest-generated Git Snapshots from the
   Session DO while compute is available, and arm the Session DO idle alarm when work settles and
   no lease remains.

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

The Session DO owns the idle timeout as a native alarm and arms a configurable 15-minute timer when
no lease is active. Agent work, clone, setup/resume, and Git Snapshot refreshes run in the Session
DO, which therefore observes them directly. How runner-side leases and activity (terminal, preview)
reach the Session DO is To be decided.

Lease types:

- `provisioning` (Session DO clone and setup)
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

At timeout, the Session DO uses the same recoverable Stop Session ordering as explicit Stop:

1. The Session DO closes Durable recoverably. Pausing happens before cancelling guest operations or
   collecting the final Git Snapshot.
2. The Session DO cancels its own guest operations (setup/resume), runs a final
   controlled status/diff operation inside the guest over `ExecutionEnv`, and atomically stores the
   Git Snapshot in its SQLite storage. If the environment is unreachable, it keeps the previous
   snapshot and marks it stale.
3. The Session DO asks the runner to stop compute.
4. As terminal/preview support is implemented, the runner stops new live-only streams, expires those
   previews, closes terminals, and stops managed services within a bounded deadline.
5. Run guest `/bin/sync`.
6. Explicitly stop and close the Gondolin VM without deleting `root-disk.qcow2`.
7. Call host `fsync` on `root-disk.qcow2` and its session directory.
8. Append `stop.completed` to the Session Journal and set environment state to `stopped`.

Steps 4–8 describe the runner provider. What Stop retains on a provider with vendor-snapshot or
ephemeral persistence, and how the Session DO restores a Project Checkout on Wake there, is To be
decided.

Wake resumes checkpointed agent work concurrently with opening the same disk in a new VM; the
Session DO then runs `.agents/resume` over `ExecutionEnv`. RAM, processes, and tmpfs-backed guest paths do not survive Stop; the
Environment Link closes with the VM. Abort instead cancels conversation work without stopping
compute. The Session DO-side `environment` tool can stop or restart compute through the provider without
pausing the agent; forced restart reports possible unsynced-data loss and must wait for exclusive
disk ownership before attaching a replacement VM.

### 13.6 Archive and delete

Archive:

- Stop the VM and retain its persistent root disk.
- Expire preview access.
- Hide the session from the active list.
- Retain Harness State, Published Media, and the cached Git Snapshot (Session DO and R2), checkout, Session Journal, `root-disk.qcow2`, and logs.

Delete:

- Require explicit confirmation.
- In one native Workspace SQLite transaction, write a durable deleted-session marker containing only Workspace ID, session ID, and deletion time and remove the five-column catalog row.
- The Session DO then marks itself deleting and aborts agent work. It deletes every object under the Session's R2 prefix `workspaces/{workspaceId}/sessions/{sessionId}/media/`, asks the provider to delete the environment (on the runner, `environment.delete` stops compute and removes the persistent root disk and its checkout, Session Journal, and environment directory), closes its Environment Links, and finally deletes its own storage (Harness State, Published Media records, Git Snapshot, Project Checkout facts, alarms).
- If the R2 or environment deletion fails, for example because the runner is offline, the Session DO's alarm retries it; the Session is already gone from the control plane.
- An environment that a runner later reports for a deleted Session is ignored by its Session DO, and runner reports never recreate the catalog entry.
- Retain the deleted-session marker so the deleted Session ID can never be cataloged again.

## 14. Pi integration

### 14.1 Durable harness

Use `@earendil-works/pi-durable` behind the Agent Harness interface, hosted in one gateway Session
Durable Object per Session. The Durable adapter lives in
`packages/gateway/app/cells/session/agent.ts`; the former runner harness is removed. It opens the Session
DO's own SQLite storage through pi-durable's `storage/sqlite/cloudflare` adapter, an explicit
registry, and a root conversation. Durable owns entries, documents, Submissions, queued input, task
checkpoints, compaction, and recovery. OpenOrb does not implement another agent task state machine.
There is no conversion or compatibility path for pre-migration or runner-hosted sessions.

The scoped harness supports submit, explicit resume, conversation-wide abort, model/thinking
configuration, and complete Conversation Views. Closing it pauses recoverably. Opening for
observation alone does not resume scheduling. The Session DO serializes live harness access,
idle view reads, close, and deletion.

Pi AI uses a per-open `InMemoryCredentialStore` in the Session DO, filled with provider credentials
resolved from the Workspace DO inside the gateway; ambient environment/file authentication is
disabled. Provider credentials are never sent to runners or written to harness configuration or
guest files.

### 14.2 Guest tools and independent environment control

The explicit registry exposes guest-backed `read`, `write`, `edit`, and `bash`, plus OpenOrb's
`publish_media` and Session DO-side `environment` control. The Agent Harness sees only Pi's
`ExecutionEnv`, unchanged; the Session DO's own clone, setup/resume, Git Snapshot, skill-discovery,
and Published Media work uses the same `ExecutionEnv`. The Agent Environment Provider supplies it.
For providers that run the static Environment Daemon, including the runner, it is a vendored copy of
`@earendil-works/pi-env`'s `RemoteExecutionEnv` client in `packages/pi-env`, using a WebSocket
transport and Web APIs instead of the upstream SSH child process and Node built-ins; only the
Environment Link transport is provider-specific. It talks to the unmodified static pi-env
Environment Daemon inside the guest, so untrusted paths are interpreted only by guest processes and
the environment conforms to Pi's `ExecutionEnv` contract. A provider with a suitable native API may
instead return its own `ExecutionEnv`, which must also interpret paths only inside the guest.
`NodeExecutionEnv`, host-filesystem fallbacks, and any gateway- or provider-host interpretation of
guest paths are forbidden.

Relative paths resolve from `/workspace`. Absolute paths address the guest filesystem, never the
gateway or a provider host. While a reachable environment boots or runs setup/resume, guest
operations wait cancellably. They fail explicitly while compute is stopped, and fail immediately,
without waiting, while the runner or provider is unreachable or the Environment Link is down, so the
agent can choose another approach while model work continues. The `environment` tool asks the
provider to start, stop, or restart compute even while the guest is unavailable, without pausing
the agent; it fails immediately when the provider is unreachable. Replacement VMs must not overlap
disk ownership.

Losing the Environment Link closes the Environment Daemon and kills the processes it started, as
upstream does; tools interrupted this way report possible partial execution.

`publish_media` reads bounded allowlisted image/video bytes from `/workspace/.openorb/artifacts`
over the Environment Link. The Session DO validates them and writes them to the R2 bucket under
`workspaces/{workspaceId}/sessions/{sessionId}/media/`, recording metadata and quota (64 MiB per
artifact, 1 GiB per Session) in its SQLite storage. Browser media access goes through an
authenticated, Workspace-scoped gateway route with a MIME allowlist, `nosniff`, and Range support,
and works while the runner is offline. Arbitrary guest paths and remote embeds are not transcript
mounts.

### 14.3 Trusted registry and resource boundary

Only OpenOrb-owned tools and prompt sections are installed in the Durable registry. Neither project
nor global Pi settings, packages, extensions, skills, prompts, themes, context files, or system-prompt
fragments are discovered in the gateway or on the runner host. Trusted prompt preparation never
requires a ready guest.
It explains guest-only tools, independent Environment Control, disk-only persistence, and Git policy.

Repository files such as `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and `.pi/**` remain untrusted
guest files. The model can inspect them through guest tools and execute associated scripts only
inside the guest. Security tests must reject host discovery and host tool fallbacks.

Once per Session, as soon as the first checkout of the session branch exists, the Session DO
asynchronously discovers `/workspace/.agents/skills/**/SKILL.md` through the guest filesystem over
`ExecutionEnv`, reading only passive YAML frontmatter metadata. The OpenOrb-owned
`repository-skills` prompt section advertises validated names, descriptions, and guest paths; the
model reads full instructions on demand. The catalog stays fixed for the rest of the Session,
regardless of environment state, so the system prompt and the model's cached prompt prefix do not
change; skills added or edited later are not re-advertised. Its only record is the conversation
transcript's system prompt section, which the Session DO replays on reopen. Before the
first successful load the section says discovery is pending; a failed or interrupted first load is
retried at the next start or reopen. Discovery never gates model work or Environment Control. Scans are bounded to eight directory levels,
64 KiB per skill file, and ten seconds, with no entry-count cap. Skill roots own their supporting files;
hidden directories and `node_modules` are skipped. Invalid, unreadable, disabled, or duplicate-name
skills are skipped deterministically. No repository scripts, extensions, settings, or global
resources are loaded in the gateway or on the runner host.

A future centrally managed **Agent Profile** may add explicitly approved resources from trusted
configuration/storage. Its registry integration still needs design; it must not enable executable
checkout discovery or host execution of scripts referenced by passive skill metadata.

### 14.4 Conversation View projection

Consume Durable's complete Conversation Views, not deltas replayed into a second source replica.
Redact secrets and project media references before diffing the browser-facing view. Send an initial
`conversation.snapshot` followed by `conversation.ops` containing Chord structural operations.
Slow viewers coalesce to the latest view and receive a delta from their own last-delivered view.
Reconnect replaces the baseline, with no transcript replay cursor.
The active view includes queued input and live progress, but is not a pre-compaction archive.

The Session DO projects the view and serves it to browsers. Inline model images retain their bytes
in Harness State/model context; browser stream frames carry Session artifact references only, and
the authenticated media route serves those images from the Session DO's Harness State rather than
through runner storage or the bulk socket. Unsupported images or publication failures become
placeholders, never inline-byte fallback. Session infrastructure state remains separate Session
Events that the Session DO emits itself, from its clone and setup/resume work and from the
environment changes the runner reports through the Runners DO. Neither the Workspace DO,
the Runners DO, nor the Session Journal maintains a second conversation transcript.

## 15. Gondolin integration

This section describes the runner provider, apart from §15.3, which applies to every provider.
The runner declares a durable root disk, Egress Secret Mediation, and a hibernatable link.

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
- For explicit and idle Stop Session, the Session DO closes Durable recoverably, collects the final
  Git Snapshot over `ExecutionEnv`, and then asks the runner to stop compute; the runner runs guest
  `/bin/sync`, then stops and closes the VM without deleting the disk.
- Abort cancels agent work and queued inputs without stopping compute; Environment Control stops
  or restarts compute without pausing the harness.
- The runner calls host `fsync` on the disk and Session directory before journaling
  `stop.completed`.
- A runner interrupted in `Stopping` cannot confirm guest sync and VM exit, so it preserves the
  disk and fails with `restart-environment`.
- Wake creates a new VM object over the same disk; the Session DO then runs `.agents/resume`.
- RAM, processes, and tmpfs-backed paths such as `/root`, `/tmp`, and `/var/log` do not persist.
- The Session remains pinned to the matching Gondolin guest assets/build ID.

Setup documentation must tell projects not to rely on persistence under tmpfs-backed paths.

### 15.3 Setup hooks

The Session DO runs both hooks over `ExecutionEnv` for every provider; the runner does not run
them.

- Run executable `.agents/setup` once after the Session DO's fresh clone and initial boot.
- Stream stdout/stderr to viewers as Session Events from the Session DO. Whether hook output is
  retained beyond the live stream is To be decided.
- Surface a non-zero setup exit as a visible warning and release guest readiness so the agent can diagnose or repair the project.
- Run executable `.agents/resume` on every environment wake before guest tools become ready; model
  work may already be running concurrently in the Session DO.
- Use a bounded blocking period; surface failure rather than silently continuing.
- Hooks execute inside the guest from `/workspace`.

### 15.4 Guest image

Gondolin currently implements an Alpine boot-image pipeline, but it accepts an OCI rootfs. The OpenOrb guest image uses a pinned Debian OCI userspace with Gondolin's Alpine kernel/initramfs boot layer. Its shared development environment contains:

- Shell, text, archive, editor, network, and media utilities comparable to a fresh Amp orb
- Git, `gh`, GCC/G++, Make, Autoconf, Automake, and pkg-config
- Python/pip, Node.js/npm/Corepack/pnpm/Yarn, Bun, and Perl
- `apt` for repository-specific setup
- The pinned native agent-browser CLI and browser runtime libraries
- Gondolin guest helpers and its minimal init
- The unmodified static pi-env Environment Daemon at `/usr/local/libexec/openorb/pi-env`, extracted from the SHA-256-pinned `@earendil-works/pi-env` npm tarball whose version matches the vendored client. The runner starts one daemon per Environment Link under the guest login shell, so commands see the same profile environment as before

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
- OpenAI Codex device login, with encrypted credentials and alarm-driven polling in Workspace DO

Workspace owns OpenAI Codex exchange, refresh, revocation, and persisted device-login checkpoints.
The public Worker has no OAuth callback endpoint. Additional provider-specific OAuth/subscription
flows remain deferred.

### 16.2 Distribution

1. Gateway stores encrypted provider configuration.
2. Browser lists only redacted metadata.
3. The browser selects one `provider/model` reference and no credential value. For the first
   prompt, later prompts, or Wake, the Session DO resolves the Session's selection, splits the
   reference only at its first `/`, and resolves the credential from the Workspace DO through
   gateway-internal RPC.
4. The Session DO keeps credentials in memory only.
5. The Session DO configures Pi AI's in-memory credential store and the Durable conversation's model.
6. Model credentials are never sent to runners or other providers and never enter the guest.
7. The gateway's bundled Pi model metadata determines supported model choices; runners no longer
   report Pi/model catalog compatibility.

## 17. Git and repository handling

### 17.1 Absolute execution boundary

The complete session checkout, including `.git`, is untrusted guest data (on the runner, on the
Persistent Root Disk). A repository or agent can modify executable Git configuration such as:

- Credential helpers
- `core.sshCommand`
- `core.hooksPath` and hooks
- Diff and textconv drivers
- Clean/smudge filters
- `core.fsmonitor`
- URL rewrites, remote helpers, aliases, and include files

Consequently, **neither the gateway nor a provider host (including the runner) may run native Git against a session workspace**. This applies to clone, status, log, diff, fetch, commit, push, cleanup, and any future Git operation. It also applies when the VM is stopped. Otherwise a later host-side Git command could execute guest-controlled code with gateway or runner privileges.

All Git operations against session data execute inside the guest, issued by the Session DO over
`ExecutionEnv`. The runner handles the opaque root-disk file only for lifecycle and durability
operations. The Session DO consumes only bounded serialized Git Snapshots and Git results returned
by the guest.

### 17.2 Clone and branch creation

1. The provider creates or opens the Session's environment (the runner: its persistent root disk and Gondolin VM) and opens the Environment Link.
2. Over `ExecutionEnv`, the Session DO runs guest Git to clone the configured repository into `/workspace` through mediated credentials, or opted-in guest credentials on a provider without Egress Secret Mediation.
3. Automatic recursive submodule initialization is disabled.
4. The clone command permits only the configured network protocol and canonical repository URL.
5. Guest Git returns the exact base commit to the Session DO.
6. Guest Git creates the session working branch.
7. The Session DO stores base commit, branch, and remote metadata in its SQLite storage, outside the workspace; these values are untrusted data, not trusted instructions.

By default, the working branch is the Project's default ref. The user may instead provide a custom
branch name, for example:

```text
openorb/<sanitized-session-name>-<short-session-id>
```

The branch can change until its first successful push and is fixed afterward.

### 17.3 Controlled Git operations

Gateway Git actions are project behaviour: the Session DO executes a narrowly constructed command inside the guest over `ExecutionEnv`, not through a runner procedure. It does not shell-concatenate user data. Commands use `ExecutionEnv` argument arrays (no shell), a controlled working directory, a clean environment, bounded output, timeouts, and explicit safe overrides where applicable.

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

These controls make OpenOrb-owned actions deterministic, but the main privilege boundary remains the guest (Gondolin on the runner). An agent can intentionally run Git features that execute repository-controlled code, but that code stays inside the guest.

### 17.4 HTTPS credentials without guest exposure

This is the runner provider's Egress Secret Mediation. On a provider without it, the real GitHub
token enters the guest only when the Project has a Guest Credential Opt-in; without the opt-in the
Session runs without Git credentials, so private clone, fetch, and push fail. How opted-in
credentials are placed in the guest is To be decided.

1. A trusted helper included in the guest image returns generated placeholder username/token values.
2. Git encodes placeholders into HTTP authorization headers.
3. Gondolin host hooks substitute the real secret only for `github.com` and `api.github.com`.
4. Non-GitHub hosts never receive substitution; GitHub enforces the token's repository permissions.
5. The guest can print only placeholders, never the real token.

The real HTTPS credential is not placed in guest environment variables, files, process arguments, or `.git/config`.

### 17.5 SSH credentials without guest exposure

This applies to the runner provider. Elsewhere, SSH keys follow the same Guest Credential Opt-in rule
as the GitHub token.

- SSH private key is decrypted only on the trusted runner.
- Configure Gondolin’s host-side SSH proxy with the key and known-host policy.
- Use `execPolicy` to allow only Git operations for the configured repository.
- Permit `git-upload-pack` and `git-receive-pack` for that repository.
- Deny interactive SSH, SFTP, agent forwarding, port forwarding, and unrelated repositories.
- Agent-modified `core.sshCommand` may execute only inside the guest and cannot obtain the host-held key.

### 17.6 Git Snapshots and stopped sessions

The Session DO triggers Git Snapshot refreshes. During an Agent Run it executes controlled
status/diff commands inside the guest over `ExecutionEnv` at the tool and turn boundaries it observes
directly, every 15 seconds, and in a final awaited run-end flush. It debounces boundary bursts and
prevents overlapping inspections. Each refresh writes the full staged and unstaged patches to a guest
file under `/var/lib/openorb/git/<snapshotId>/` (outside `/workspace`, on persistent guest storage
where the provider has it, pruned to the latest snapshot). Only the bounded summary crosses the
Environment Link: file statuses, section sizes, file-boundary offsets, and the first 256 KiB of each
section. The Session DO stores that summary in its SQLite storage. The runner takes no part and needs
no boundary signals. The summary is served from the Session DO, including while the runner is
offline. When a viewer pages past a preview, `gitPatchChunk` asks the Session DO, which reads that
byte range of the guest file over `ExecutionEnv`. It never reads past the size recorded at capture,
and it never wakes compute to do so.

While the VM is stopped or the runner is unreachable:

- Show the last cached Git Snapshot summary and previews; paging past a preview reports that the
  full diff needs a running environment.
- Mark it stale if terminal, link, or VM failure prevented a final refresh.
- Wake the VM for an authoritative refresh when requested.
- Never run host Git against the checkout on the stopped VM's disk.

A future host-side implementation may use a deliberately non-executing parser over a sanitized immutable snapshot, but it must not use native Git, load `.git/config`, invoke hooks/drivers/filters/fsmonitor, or execute workspace-selected programs. This parser is not required for the MVP.

Read-only file browsing executes through bounded Session DO guest operations over `ExecutionEnv`
with path/symlink protections. It wakes a stopped VM rather than reading `root-disk.qcow2` through
host filesystem tools.

### 17.7 Commit and push

The agent may inspect history, create branches, commit, fetch, and push from inside the guest. System guidance says to push only when the user explicitly requests it.

The gateway **Commit & Push** action:

1. Wakes the VM if necessary.
2. Refreshes aggregate diff/status using controlled guest Git from the Session DO.
3. Preserves existing agent-created commits.
4. If dirty, commits inside the guest using explicit author name/email and a user-supplied/default message.
5. Pushes the explicit local ref to the configured canonical remote URL and branch.
6. Records reported remote ref and commit IDs in the Session DO, outside the workspace.

Never issue force flags from OpenOrb-owned UI/actions. Best-effort guest command policy should detect obvious force pushes, but true enforcement belongs in remote branch protection because raw Git protocol intent is difficult to police reliably at the HTTP/SSH transport boundary.

No patch download is part of the primary workflow.

## 18. Terminal

Terminals and previews (§19) are specified for the runner provider. Their support on other providers
is To be decided.

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
- On request while stopped: reserve resources, wake the same disk, let the Session DO run
  `.agents/resume`, restart the command, wait for readiness, and proxy.
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

The browser API is internal and may evolve before a stable public API is declared. It still uses shared runtime schemas and explicit response types. Session-list/catalog responses may come from the four persisted metadata fields. Conversation reads and commands (stream, prompt, abort, thinking level, Stop, Wake), media reads, and cached Git Snapshot reads go to the Session DO and work without a connected runner. Guest-backed Git mutations and file reads also go to the Session DO, which runs them over `ExecutionEnv` and fails them immediately while the environment is unreachable. Terminals and previews require the owning runner to be connected and are proxied to that runner.

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

Creation may also override the Project's Agent Environment Provider; that field is deferred until a
second provider exists, and its shape is To be decided. `runnerId` applies only when the runner
provider is selected.

`DELETE /api/sessions/:sessionId` is available while the runner is offline. After explicit confirmation, it atomically records the minimal deletion marker and removes the catalog row, then the Session DO deletes the Session's R2 media prefix and its environment and finally its own storage (including its Git Snapshot and Project Checkout facts). While the runner is offline, the Session DO's alarm retries environment deletion.

### 20.6 Conversation and delivery

```http
POST   /app/sessions/:sessionId/messages
POST   /app/sessions/:sessionId/thinking-level
POST   /app/sessions/:sessionId/abort
POST   /app/sessions/:sessionId/stop
POST   /api/sessions/:sessionId/wake
GET    /api/sessions/:sessionId/events
GET    /api/sessions/:sessionId/artifacts/:artifactId
```

The message form supplies a text prompt and optional thinking level. The gateway generates a
`clientRequestId` for that command and sends it to the Session DO, which resolves the Session's
model/credentials inside the gateway; successful admission identifies the Durable Submission.
Prompt, abort, and thinking-level commands go to the Session DO, not the runner, so a disconnected
runner does not reject them; ambiguous command outcomes are shown rather than automatically
retried. Queued inputs belong to Harness State, not a separate pending-message API.

Abort targets the Session's conversation. Stop is a Session DO-orchestrated recoverable pause plus
durable compute stop by the runner. Opening the session page separately sends a CSRF-protected Wake
request. Subscribing to or reconnecting the event stream never sends Wake or enables harness
scheduling. Planned steering and edit-last controls need Durable-based contracts before routes are
added.

The artifact route serves Published Media from R2 and inline conversation images from Harness
State through the Session DO, with Workspace-scoped authentication, a fixed non-scriptable image and
video MIME allowlist, `nosniff`, and Range support. It works while the runner is offline.

### 20.7 Workspace and Git

```http
GET  /api/sessions/:sessionId/git-snapshot
GET  /api/sessions/:sessionId/files?path=<relative-path>
GET  /api/sessions/:sessionId/file?path=<relative-path>
GET  /api/sessions/:sessionId/git/status
POST /api/sessions/:sessionId/git/commit
POST /api/sessions/:sessionId/git/push
```

All paths are relative, normalized, symlink-safe, and constrained to the session workspace. The
Session DO serves the cached Git Snapshot even while the runner is offline; the other routes run
guest commands over `ExecutionEnv`.

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
- The Session DO serves the stream: its Conversation View plus Session infrastructure state it emits, including environment changes the runner reports
- Reconnect replaces the entire browser baseline from Session DO Harness State, whether or not the runner is connected
- Coalesce pending conversation updates to the latest view; compute each viewer's next delta from its last-delivered view
- Keep infrastructure events in a separate bounded queue; overflow fails only that watch and SSE reconnect supplies a fresh baseline
- Redact secrets and project inline images to private artifact references before diffing
- Keep harness ownership serialized in the Session DO; observation never starts compute or resumes work
- Harness State is the only conversation store; do not persist conversation/event history in the Workspace DO, Runners DO, or a runner transcript
- Carry queue, usage, configuration, and progress in the Conversation View; keep infrastructure events separate
- Browser snapshot replacement and validated structural application must not duplicate messages

The session list may use a separate lightweight global SSE stream for runner/session status, or poll initially. Do not overload every session stream with unrelated status.

## 22. Runner Effect RPC API

Effect Schema declarations in `@openorb/protocol` are the sole runner wire contract. Effect RPC
owns JSON framing, runtime decoding, in-connection correlation, stream acknowledgement, remote
interruption, and ping/pong. OpenOrb does not maintain a parallel wire contract or runtime path.

The application protocol version is 27. ADR 0005 bumped it from 25 to 26, and completing ADRs 0005
and 0006 bumped it to 27, removing every `session.*` procedure. Neither bump is backward compatible:
a v27 gateway rejects v26 runners at admission, and runner-hosted Sessions are not migrated.

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
| `runner.watch` | Stream | Deliver `snapshot.environment` elements and a `snapshot.complete` boundary (revision, environment count, observation time, capacity), then `runner.observed`, `environment.updated`, and `environment.removed` |
| `environment.create` | Unary | Idempotently create runner-owned environment state (Persistent Root Disk, Session Journal) for a Session after an authoritative capacity check; no clone or setup |
| `environment.control` | Unary | Start, stop, or restart compute, with transient credentials for Egress Secret Mediation and optional recovery |
| `environment.attach` | Unary | Start an Environment Daemon and dial the Session's Environment Link with a one-time attach nonce |
| `environment.delete` | Unary | Stop compute and remove the environment's runner-owned data |

There are no `session.*` runner procedures. Prompt, thinking-level, and Abort commands go to the
Session DO; it caches Git Snapshots and runs clone, setup/resume, stage/unstage, and other guest Git
over `ExecutionEnv`, so the former provision, wake, stop, delete, watch, Git Snapshot, Git file,
Git patch, and artifact procedures are removed. The Session DO reaches the `environment.*`
procedures through the Runners DO, which routes them by the runner's current connection
generation.

Later archive and terminal/preview operations join the same typed RPC
group. They are domain procedures, not generic command/result messages.

### 22.3 Identity, retry, and handoff

Effect RPC request IDs are transport correlation only. Stable domain identifiers remain explicit:
the Session ID of each environment command, each prompt `clientRequestId`, and each Durable
`submissionId`.
None is derived from an RPC request ID. There is no OpenOrb Agent Run identifier or transcript cursor.

`environment.create` performs one short idempotent acceptance transaction: check capacity and
conflicts, journal the environment definition under the process-owned EnvironmentSupervisor, and
return an environment snapshot. Clone and setup are not part of it; the Session DO runs them once
the environment is started and its Environment Link is up. A disconnect after dispatch reports
uncertain delivery. The gateway does not blindly retry; an explicit same-Session retry is reconciled
against the runner's durable state, and a later `WatchRunner` snapshot can reveal successful
acceptance.

Prompt admission is serialized per Session by its Session DO. The Session DO prompt command returns
the admitted `submissionId`; Durable request-ID deduplication replaces custom receipt documents and
admission observers. Duplicate acknowledgements only read the persisted Submission: calling even a
duplicate `submit` would enable scheduling. The Session DO abort command takes only the Session and
acts on the conversation.
Neither command is automatically retried after timeout/disconnect. Surface uncertainty for explicit
reconciliation. Checkpoint recovery on Wake is distinct from retrying an ambiguous gateway command;
model requests may repeat and interrupted unsafe tools may report partial execution. There is no
exactly-once execution guarantee or reconstruction of harness queues from gateway state.

### 22.4 `WatchRunner`

The runner subscribes to state changes before taking its bounded initial snapshot. The stream emits
individual `snapshot.environment` elements, one `snapshot.complete` boundary carrying revision,
environment count, observation time, and capacity, periodic `runner.observed` elements, and later
`environment.updated`/`environment.removed` elements. The gateway accumulates and validates the
initial elements, rejecting duplicates, miscounts, out-of-order elements, and other Workspaces'
environments, and atomically commits the environment index only at the completion boundary. Invalid
data never becomes partially live. The Runners DO notifies each affected Session DO of updates and
removals, and marks a runner's environments unreachable when its watch ends. It never reads or writes
the Session catalog.

The gateway uses a stream inactivity timeout for domain liveness while Effect RPC ping/pong checks
socket responsiveness. On reconnect, the complete stream restarts and rebuilds only live routing
state in Runners DO; gateway storage is never used to reconstruct runner-owned environment data.

### 22.5 Session DO streams and SSE

The Session DO reads its complete current Conversation View under its own serialized harness
ownership and sends each viewer a projected snapshot plus infrastructure state. Live updates are
structural diffs of complete projected views. A stopped Session, or one whose runner is offline, can
be observed from Session DO SQLite without scheduling work or starting a VM; idle reads cannot race
a live owner or deletion.

Each browser owns a request-scoped Session DO stream; the Worker merges keepalive comments. The
Session DO keeps one shared latest projected view and a sliding one-slot change notification per
viewer. Each viewer computes its next delta on consumption, against its own last-delivered view;
intermediate conversation updates can be skipped without breaking the delta chain. Infrastructure
state and events come from the Session DO itself: its own provisioning work and the environment
notices (updated, removed, unreachable, revoked) that the Runners DO delivers. They are sent to each
viewer separately from conversation deltas; a stalled viewer reconnects for a fresh snapshot without
blocking the harness or other viewers. Read failure or disconnect closes SSE; native
`EventSource` reconnect gets a new snapshot, not a missing suffix. Browser cancellation interrupts
only the matching viewer stream, not agent work.

### 22.6 Environment Link

This section describes the runner provider's link. Other providers that run the static Environment
Daemon share the vendored `RemoteExecutionEnv` and supply only their own link transport; a provider
that returns its own `ExecutionEnv` needs no Environment Daemon link. A provider that cannot offer a
hibernatable link keeps the Session DO awake while its link is open; whether the Session DO closes
such links while the agent is idle is To be decided.

The runner's Environment Link is a dedicated per-Session WebSocket, separate from the control and bulk
sockets. The runner dials it outbound to the Session DO and authenticates with its runner token
plus a one-time attach nonce; it then relays Environment Daemon frames verbatim and never
interprets them. Revoking a runner closes its Environment Links through the Runners DO.

The link stays open while the Agent Environment runs. The Session DO accepts it as a hibernatable
WebSocket so it can sleep while the agent is idle, and liveness never wakes it: the runner relay
answers the daemon's pings locally, link pings use the Durable Object's automatic WebSocket
response, and the vendored client sends protocol pings only while it has requests in flight. Losing
the link closes the daemon and kills the processes it started; interrupted tools report possible
partial execution. Multiplexing environment traffic over the control socket was rejected: it would
route every tool byte through the single Runners DO, let large transfers delay control traffic,
couple in-flight tools to control-socket reconnects, and lose WebSocket backpressure across Durable
Object RPC.

## 23. Future runner binary data protocol

This section plans generic terminal/preview tunnels, not the Environment Link, or the control channel's SchemaBinary framing.

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

Use the current source contracts rather than parallel illustrative SDK interfaces. Under ADR 0005
and ADR 0006, harness-side and project-behaviour contracts live in the Session DO; the runner keeps
only environment contracts.

- [Agent Harness](packages/gateway/app/cells/session/agent.ts): the Session DO's Durable harness
  with an explicit registry, in-memory credentials, guest-backed tools, `publish_media`,
  `environment` control, and the `repository-skills` prompt section.
- [Agent Environment Provider](packages/gateway/app/cells/session/environment/provider.ts) (gateway
  side): binds a Session to its environment and supplies create, start/stop/restart control,
  delete, declared capabilities (persistence, Egress Secret Mediation, hibernatable link), and Pi's
  `ExecutionEnv` over the Environment Link. It carries no project behaviour. The
  [runner provider](packages/gateway/app/cells/session/environment/runner-provider.ts) is the only
  implementation.
- Vendored pi-env `RemoteExecutionEnv` client (`packages/pi-env`): the guest `ExecutionEnv` shared by
  every provider that runs the static Environment Daemon, with a provider-specific link transport;
  readiness-aware and failing immediately while the link is unreachable, plus a separate Session
  DO-side Environment Control callback that reaches the provider.
- Session DO project behaviour: clone and branch creation, `.agents/setup`/`.agents/resume`, Git
  Snapshot refresh and controlled Git operations, skill discovery, and Published Media, all over
  `ExecutionEnv`.
- [Runner Agent Environment](packages/runner/src/environment/agent-environment.ts): the runner's
  Gondolin compute over a durable root disk with Egress Secret Mediation. An `AgentEnvironment` only
  runs lifecycle commands, starts the Environment Daemon, and stops.
- [EnvironmentSupervisor](packages/runner/src/environment/session/supervisor.ts) and
  [EnvironmentActor](packages/runner/src/environment/session/actor.ts): one actor per
  `environments/<sessionId>/` directory, journaling infrastructure facts in the JSONL Session Journal
  and serving create, control, attach, and delete; the
  [environment lifecycle](packages/runner/src/environment/session/lifecycle.ts) owns readiness,
  guest operation cancellation, sync/stop, bounded restart, and exclusive disk attachment.
- [Environment Link dialer](packages/runner/src/environment/link/dial.ts) and
  [relay](packages/runner/src/environment/link/relay.ts): the runner side of each Environment Link.
- Git review and mutations execute only inside the guest, issued by the Session DO; cached
  snapshots are Session DO-owned. Planned file browsing must use bounded guest reads over
  `ExecutionEnv`, never a host checkout adapter.
- Planned terminal/preview services need scoped ownership, leases, bounded streams, and guest-only
  destinations. Their exact internal interfaces remain implementation work.

`RunnerApi` and the process-scoped runner connection own the transport boundary. Do not
introduce a generic OpenOrb transport abstraction or mirror Effect RPC types. Each Environment Link
relay is a separate scoped service; generic tunnels remain planned. These boundaries allow Pi, Gondolin, Git, RPC, and
data-plane details to be tested independently.

## 25. Persistence ownership

The native celld Workspace DO is the gateway's durable configuration authority. Its SQLite tables
are declared in `packages/gateway/app/cells/workspace/schema.ts` and created by committed SQL under
`packages/gateway/app/cells/workspace/migrations/`:

- `workspaces`
- `users`, with required direct `workspaceId` ownership
- `password_credentials`
- `browser_sessions`, with persisted `{userId, workspaceId}` auth consistent with the user's Workspace; anonymous sessions have no authenticated owner
- `encrypted_secrets`, with explicit purpose classification for each encrypted value
- `model_provider_credentials`
- `provider_authorizations`, with private device-login checkpoints and native alarm scheduling
- `git_credentials`
- `git_author_configuration`, owned by `userId`
- `projects`
- `runners`
- `runner_enrollment_tokens`
- `sessions`, restricted to `workspaceId`, `id`, `projectId`, `createdAt`, and `initialPromptPreview`
- `deleted_sessions`, restricted to `workspaceId`, `sessionId`, and `deletedAt`

Passkey, project-specific secret assignment, Agent Environment Provider selection (Workspace default and Project override), Guest Credential Opt-in, and audit-event tables or columns remain planned, not current schema.
Any future control-plane audit events must contain no Session content beyond the catalog identity.

It must not add other session columns or contain session routes, pending messages, conversation messages, tool calls/results, event streams, usage, diffs, files, logs, previews, Git session state, root-disk state, runner commands containing prompt content, or deletion records beyond the minimal `deleted_sessions` markers.

Each Session DO owns that Session's agent persistence in its own SQLite storage:

- Durable's Harness State, through pi-durable's `storage/sqlite/cloudflare` adapter: conversation
  entries, documents, Submissions, queued input, task checkpoints, usage, inline conversation
  images, and recovery.
- Published Media metadata and quota accounting (64 MiB per artifact, 1 GiB per Session); the bytes
  live in the R2 bucket under `workspaces/{workspaceId}/sessions/{sessionId}/media/`.
- Idle-timeout alarm and Stop Session orchestration state.
- The selected Agent Environment Provider kind, the Project's Guest Credential Opt-in as of
  creation, the runner placement, Project Checkout facts (base commit, branch, remote, pushed
  state), setup/resume progress, and the cached Git Snapshot. These replace the runner's former
  checkout and provisioning journal facts.

Runner-owned persistence has separate authorities:

- The JSONL Session Journal under `environments/<sessionId>/` owns infrastructure facts only:
  `environment.created` (the environment definition), `disk.initialized`, `environment.changed`, and
  `stop.completed`. It records no conversation facts, no provisioning, clone, setup, or checkout
  facts, and is not another agent task state machine.
- Root disks and logs retain their own private storage. The runner has no Harness State, artifact
  store, conversation media, or Git Snapshot.
- Planned preview definitions/capability hashes remain runner-local, never gateway conversation data.

Runners DO keeps a Workspace-scoped in-memory environment index populated by complete, validated `WatchRunner` snapshots. After restart/eviction its sockets and projections are lost and the index starts empty; runners reconnect and rebuild live state. It never writes the Session catalog. While the owning runner is offline, the Session DO still serves the transcript, queued input, media, and the cached Git Snapshot and keeps admitting prompts, but runner assignment, environment status, files, previews, and guest-backed actions are unavailable until it reconnects; guest tools fail immediately. Explicit deletion remains available and writes the Workspace-owned control-plane marker without waiting for the runner.

Workspace SQLite guidelines:

- Native celld storage owns the database and connection; do not add a PostgreSQL pool, Redis, or a second configuration database/KV service
- Store domain identifiers as `TEXT`; use application-generated UUIDs, with UUIDv7 for Workspace/user/runner/enrollment identity
- Foreign keys enabled
- Tenant-owned projects, secrets, provider/Git credentials, runners, enrollment credentials, catalog rows, and deletion markers use immutable `workspaceId`; uniqueness is tenant-relative and composite foreign keys prevent cross-Workspace references
- Workspace RPC methods require authenticated `workspaceId` for tenant list/read/write/delete operations and treat foreign-Workspace identifiers as not found; passwords and Git author configuration remain user-owned and require `userId`
- Explicit SQL migrations committed to source; Remix owns the journal/checksums inside one native transaction, and `blockConcurrencyWhile` gates initialization
- Use native storage transactions for atomic configuration changes; persist provider OAuth checkpoints and alarm changes together
- Secret ciphertext separate from searchable metadata
- Store timestamps in UTC
- Local celld state and original secret bindings must survive restarts; PostgreSQL, legacy Workspace KV records, and the former integer-ledger bootstrap are not imported/upgraded

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
- Durable queued input is visible through the Session DO's Conversation View, including while the runner is offline.
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
- Runner offline (agent available; guest tools fail immediately)
- Running without Git credentials or Workspace secrets (provider without Egress Secret Mediation and no Guest Credential Opt-in)
- Failed with retryable/non-retryable reason

Do not collapse these into a generic spinner.

## 27. Security model

### 27.1 Trust boundaries

Trusted:

- Gateway host, including Session DOs that host agent work and project behaviour (clone,
  setup/resume, Git Snapshots) and hold model credentials in memory
- Enrolled runner host, for compute lifecycle, Environment Link relay, and Egress Secret Mediation;
  it never receives model credentials or stores conversation content
- Other Agent Environment Providers, only for their declared capabilities; without Egress Secret
  Mediation they receive Git credentials and Workspace secrets only under a Project's Guest
  Credential Opt-in, and never model credentials
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
- All runner traffic, including each Environment Link, uses authenticated outbound TLS.
- Environment Links authenticate with the runner token plus a one-time attach nonce; revoking a runner closes its links.
- Model credentials are resolved from the Workspace DO inside the gateway, are never sent to runners or other providers, and never enter the guest.
- Git credentials remain gateway/runner-side; guest sees placeholders or an SSH proxy. On a provider without Egress Secret Mediation they enter the guest only under the Project's Guest Credential Opt-in; otherwise the Session runs without them.
- The session checkout and `.git` metadata are untrusted; native Git on the gateway or a provider host never consumes them.
- Every Git operation against a session checkout executes inside the guest, issued by the Session DO over `ExecutionEnv`, including status/diff while the VM is awake and clone/fetch/commit/push.
- Stopped-session review uses a Session DO-cached Git Snapshot generated inside the guest, not host Git.
- Workspace generic secrets use Gondolin placeholder substitution on the runner. Allowed
  destinations are optional; omission intentionally allows all public HTTP(S) hosts. The Guest
  Credential Opt-in rule applies to them on other providers.
- Pi Durable runs in the Session DO with an explicit trusted registry and a guest-only `ExecutionEnv` (the vendored pi-env client, or a provider's own guest-only implementation); host execution fallbacks are forbidden.
- Pi AI credentials are in Session DO memory with ambient environment/file authentication disabled; no workspace/global settings or packages are loaded.
- No project context, prompt, skill, theme, package, extension, or system-prompt resource is discovered in the gateway or on the runner host in the MVP.
- Pi/the model can access project files and skill-associated scripts only through the guest `ExecutionEnv`; untrusted paths are interpreted only by guest processes.
- Published Media and inline images are served only through the authenticated gateway route with a MIME allowlist and `nosniff`.
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

Only code inside the guest may interpret Git metadata. Session DO-cached Git Snapshots live outside the guest, are treated as untrusted display data, and are never evaluated as commands or configuration.

### 27.4 Pi resource-discovery boundary

Pi resource discovery is a host-code execution boundary, not a convenience feature. Default discovery can involve settings, packages, extension paths, system-prompt files, context files, skills, prompts, and themes. Filtering results after discovery is insufficient because executable extensions may already have been imported or initialized.

The Session DO therefore installs only explicit OpenOrb-owned tools and prompt sections in Durable's
registry. It never scans the workspace or global directories for Pi resources and never loads
`.pi/settings.json`. Host-provided prompt material is trusted and independent of guest readiness.

The sole repository discovery is the bounded passive skill-metadata scan described in §14.3,
using guest file operations over `ExecutionEnv` after the Session DO's project setup/resume. Its results remain untrusted guidance.

Project documentation remains accessible to the agent through guest-backed file tools. This preserves the VM boundary: reading or executing a script associated with a repository skill happens inside the guest, never through gateway- or provider-side Pi discovery.

### 27.5 Mediated workspace secrets

Generic secrets are centrally encrypted and supplied to newly started Agent Environments in their
Workspace. Project-scoped assignment remains deferred. On a provider without Egress Secret
Mediation they enter the guest only under the Project's Guest Credential Opt-in; otherwise the
Session runs without them. On the runner, when a VM needs them:

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
- Runner placement and capacity rejection rate
- Workspace RPC/SQLite transaction latency
- Pi run duration and failures (Session DO)
- Conversation stream resets and queued-work counts (Session DO)
- Open Environment Links, link losses, and interrupted tools
- Guest tool failures while the provider is unreachable
- Clone and setup/resume duration and failures (Session DO)
- Git Snapshot and controlled Git operation duration (Session DO)
- Published Media bytes and quota rejections

Runner:

- CPU/memory/disk total and free
- Running VMs and stopped sessions
- VM start/wake/Stop duration
- Open terminal/preview channels and Environment Link relays

### 28.3 Audit events

Gateway audit records contain only gateway-configuration actions:

- Login and passkey changes
- Secret/provider/Git credential changes
- Runner enrollment/revocation

Session-scoped audit records stay out of the Workspace DO. Whether each lives in the Session DO or
on the owning runner is To be decided under ADR 0005:

- Session creation/archive/delete
- Preview capability creation/revocation
- Git pushes
- Agent model changes

## 29. Failure handling

### Runner disconnect

- Mark the runner offline, remove its environments from the live index, and notify their Session DOs that the environments are unreachable.
- Environment Links are separate sockets and may outlive a control-connection loss; a link that closes ends its Environment Daemon, which kills the processes it started, and interrupted tools report possible partial execution. Revocation closes the runner's links.
- Session DOs keep serving the transcript, queued input, Published Media, inline images, and the cached Git Snapshot, and keep admitting prompts; model work continues. Guest tools and Environment Control fail immediately rather than waiting, so the agent can choose another approach. Files, Git mutations, terminals, previews, environment status, and other guest- or runner-backed actions become unavailable. Explicit deletion remains available through a control-plane deletion marker.
- Do not reassign pinned sessions.
- Return runner-offline status for environment-backed session and preview requests.
- Re-authenticate, consume a complete `WatchRunner` snapshot, rebuild the environment index, and notify Session DOs of the reported environments after reconnect. A lost Environment Link is re-established on demand: the next guest operation while the environment runs makes the Session DO request a new `environment.attach` with a fresh nonce.

### Gateway restart

- Runner reconnects automatically with exponential backoff and jitter, answers `IdentifyRunner`, and starts a fresh `WatchRunner` stream.
- Workspace DO retains configuration, minimal catalog rows, deletion markers, and provider OAuth checkpoints/alarms. Session DOs retain Harness State, Published Media records, Git Snapshots, Project Checkout facts, and idle alarms. Runners DO loses ephemeral sockets/projections and rebuilds its Workspace-scoped environment index after a complete validated `WatchRunner` snapshot; it never reconstructs runner-owned environment state or RPC operations from gateway storage, and never touches the catalog.
- Browser SSE reconnect replaces its baseline with a fresh Conversation View from the Session DO; it does not Wake the Session.
- Stable domain IDs, Session DO Harness State, and runner-owned environment state support reconciliation; ambiguous prompt/Abort handoffs remain explicit.

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

- The Session DO streams hook output and shows the exact failed hook.
- Failed `.agents/setup` or `.agents/resume` emits a visible warning and releases guest readiness
  so the agent can diagnose or repair the project. Session DO model work need not wait for either hook.
- If the Environment Link drops during clone or a hook, the Session DO reports it as interrupted;
  whether it retries clone/setup or requires an explicit action is To be decided.

### Pi/model failure

- Preserve Durable Harness State; no second normalized conversation log exists.
- Surface provider errors and retry status.
- Derive activity from Durable's current view, including unfinished work, before declaring the Agent Run settled.

### Tunnel failure

- Reset only the affected logical channel.
- Keep the Effect RPC connection alive.
- Bound buffers and cancel upstream work on browser disconnect.

### Message handoff, Session DO eviction, or runner-process crash

- Admitted Submissions, Follow-ups, and task checkpoints survive in Session DO SQLite.
- A runner-process crash closes its Environment Links and stops guest work started over them; it does not affect admitted Harness State.
- Session DO restart and read-only observation do not automatically resume work; Wake does.
- Never reconstruct harness queues from the gateway projection or the Session Journal.
- Resolve duplicate request IDs by reading existing Submissions, without scheduling through `submit`.
- Report ambiguous command outcomes for explicit reconciliation rather than silently retrying.
- Recovery is not exactly-once: model requests may repeat; interrupted unsafe tools report possible
  partial execution rather than being blindly replayed. Guest processes and RAM do not survive.

### Disk pressure

- Runner advertises disk safety threshold.
- Refuse new environments before exhaustion.
- Never auto-delete sessions.
- Show per-session and runner disk use.
- Allow archive/delete cleanup from the UI.

## 30. Testing strategy

### 30.1 Unit tests

- Effect runner RPC schema validation
- Runner selection and capacity filtering
- Resource accounting
- Session state transitions
- Deleted-session marker transaction and anti-resurrection guard
- Durable request-ID deduplication and stable Submission identity, including Follow-ups
- Duplicate acknowledgement does not call `submit` or enable scheduling
- Recoverable Stop versus Abort versus independent Environment Control
- Provider selection precedence: Session override, then Project override, then Workspace default
- Credential delivery by provider capability and Guest Credential Opt-in
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
- Idempotent `environment.create` reconciliation after a dropped RPC result
- Ambiguous prompt outcomes remain explicit without automatic command resubmission
- Durable admission deduplication and checkpoint recovery in the Session DO
- Environment Link attach with runner token plus one-time nonce, nonce reuse rejection, revocation closing links, and hibernation-safe liveness
- Environment Link loss kills daemon-started processes and interrupted tools report possible partial execution
- Guest tools and Environment Control fail immediately, without waiting, while the runner is unreachable
- Shared `RemoteExecutionEnv` conformance to Pi's `ExecutionEnv` contract, independent of link transport
- Runner protocol v26 is rejected by a v27 gateway
- Complete `WatchRunner` snapshot validation and atomic in-memory environment index rebuilding, including rejection of duplicate, miscounted, out-of-order, or foreign-Workspace environments
- Binary open/data/window/end/reset behavior
- Conversation updates coalesce for slow viewers; infrastructure overflow and SSE reconnect replace the baseline
- Observation never wakes compute
- Session DO harness ownership, idle reads, close, and deletion are serialized
- Preview HTTP header/body streaming
- Preview WebSocket tunneling

### 30.3 Integration tests

Use real Pi Durable with a fake deterministic model where possible and real Gondolin/QEMU in Linux CI where available.

Scenarios:

- Enroll runner behind an outbound-only network boundary
- Clone public HTTPS repository
- Clone/push private HTTPS repository with guest-visible placeholder only
- Clone/push private SSH repository through Gondolin proxy
- Every clone/status/diff/fetch/commit/push process runs inside the guest, issued by the Session DO over `ExecutionEnv`, never on the gateway or runner host
- Stopped-session diff uses a final guest-generated Git Snapshot cached by the Session DO, survives runner absence, and wakes for refresh
- Session DO clone and setup hook over `ExecutionEnv`; resume hook after Wake
- Prompt → tools → settled → Stop → wake same disk → continue
- Stop during active work → reopen → Wake resumes checkpoints and queued Follow-ups
- Abort cancels queued inputs and owned background work but leaves compute running
- Model generation and environment control do not wait for guest boot/setup/resume
- Environment stop/restart leaves the harness running and prevents overlapping disk attachment
- With the runner offline, the Session DO still serves the conversation, queued input, media, and cached Git Snapshot and admits prompts; model work continues, guest tools fail immediately, and runner-backed actions are unavailable
- Ambiguous command handoff is visible; interrupted unsafe tools are not blindly repeated
- Planned edit last without workspace rollback, once its Durable interface is settled
- Diff review and wake-for-file browsing while the VM is stopped
- Browser terminal through data tunnel
- Managed preview wake/restart
- Live-only preview expiration
- Capability revocation
- Deletion removes Session DO storage, the Session's R2 media prefix, and the runner environment; offline deletion removes the catalog card, records a minimal marker, and the Session DO's alarm deletes the environment once the runner reconnects

### 30.4 Security tests

- A hostile workspace containing `.pi/extensions`, `.pi/settings.json`, package resources, prompt/system-prompt files, context files, skills, and themes cannot execute host code or alter trusted resources/policies; only validated passive skill metadata is advertised through the guest-only loader
- Gateway and runner source/build checks forbid host project discovery, ambient auth, and host execution adapters
- Provider credentials never appear in runner RPC payloads, runner storage, or runner logs
- Environment Link attach fails without a valid runner token and unused attach nonce, and for a revoked runner
- Published Media writes respect the 64 MiB/artifact and 1 GiB/Session quotas, stay under the Session's R2 prefix, and are served only with allowlisted MIME types and `nosniff`
- Pi/the model reaches workspace `AGENTS.md`, `CLAUDE.md`, and skill-associated scripts only through Gondolin-backed tools
- Project Checkout traversal and escaping symlink denied
- Preview cannot target runner LAN/loopback arbitrarily
- Gateway/preview cookies never reach guest
- Capability token removed from URL and stored hashed only on the owning runner
- Placeholder secret cannot be recovered in guest
- On a provider without Egress Secret Mediation, Git credentials and Workspace secrets never enter the guest without the Project's Guest Credential Opt-in
- Git credentials absent from process args, env, files, logs, and tool output
- Hostile `.git/config`, hooks, textconv/diff drivers, filters, fsmonitor, and `core.sshCommand` cannot create a gateway- or runner-host marker during any OpenOrb Git/review action
- A test process monitor confirms no native host Git process is launched with a session workspace in its arguments, environment, repository/work-tree options, or current working directory
- Internal/cloud metadata addresses blocked
- Invalid or revoked `IdentifyRunner` credentials and claimed-runner mismatches are rejected
- A stale or restored runner snapshot cannot recreate a deleted Session's catalog entry

### 30.5 UI tests

- Server route/controller tests first, following Remix 3 guidance
- Desktop and mobile viewport coverage
- Reconnect while assistant streams
- Durable queued input and distinct Stop/Wake/Abort controls
- Planned steering/edit-last controls only after their Durable contracts are defined
- Provider, runner, and resource selection before first send
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
- Add architecture decision records for trust model, outbound tunnels, native celld Worker/DO ownership, Pi placement (now the Session DO, ADR 0005), Agent Environment Providers behind `ExecutionEnv` (ADR 0006), runner file storage, and the no-workspace-resource-discovery boundary.
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
- Capacity-checked runner selection, `environment.create` capacity acceptance, and draft runner selection
- Runner list/status UI

**Exit:** A NATed runner enrolls with URL+PSK, reports free resources, and accepts/rejects `environment.create` for the selected runner.

### Milestone 3 — Workspace and Gondolin lifecycle

- Session storage layout
- Guest image build and distribution, including the Environment Daemon
- Per-session VM creation with CPU/memory
- Persistent `root-disk.qcow2` with `/workspace` inside the guest
- Runner provider lifecycle and Environment Link
- Session DO guest-side public repository clone over `ExecutionEnv`, with no native host Git against the workspace
- Session DO `.agents/setup`/`.agents/resume` over `ExecutionEnv`
- Stop/wake lifecycle and interrupted-Stop reconciliation
- Clone/setup output and infrastructure events

**Exit:** First prompt provisioning can boot Gondolin, have the Session DO clone inside the guest and
run setup, Stop, wake from the same root disk, and preserve workspace state without model work yet.

### Milestone 4 — Pi runtime and conversation

- Pi Durable Agent Harness hosted in the per-Session Session DO
- Gateway-internal model credential resolution, never sent to runners
- Milestone 0's trusted registry and in-memory credentials, with no workspace/global discovery
- Gondolin-backed Pi tools through the vendored pi-env client, Environment Link, and guest Environment Daemon
- Session DO SQLite Harness State; separate runner infrastructure/configuration journal
- Complete Conversation View projection, snapshots and Chord operations, no second durable transcript
- HTTP prompt API and Session DO SSE stream
- Submission identity, durable Follow-ups, request-ID deduplication, and conversation-wide Abort
- Recoverable Session DO-orchestrated Stop/Wake, idle alarm, and independent Environment Control
- Model work concurrent with guest startup; cancellable guest readiness waits
- Conversation and media available while the runner is offline
- Ambiguous-command reporting, checkpoint recovery, and partial unsafe-tool execution warnings
- Model/thinking controls
- Planned steering and edit-last semantics, pending Durable interface decisions

**Exit:** User can complete, pause, Wake, and continue a streamed Durable Session from desktop/mobile,
with queued work retained and reconnect replacing the Conversation View. Only the Workspace owner
plus four live-session catalog fields and minimal Workspace/session/time deletion markers are
stored by the Workspace DO; conversation content is stored only in the Session DO. Steering and edit-last remain explicit planned gaps until their contracts land.

### Milestone 5 — Review surfaces

- Aggregate Git status/diff generated inside the guest and cached by the Session DO
- Hostile `.git/config` regression tests
- Changed-file navigation
- Read-only file browser
- Session DO-owned active Conversation View without waking compute
- Explicit unavailable state for guest- and runner-backed surfaces while the runner is offline
- Session archive on the online owning runner, online/offline deletion with durable anti-resurrection markers, and disk reporting

**Exit:** The user can inspect the active Conversation View and the last guest-generated Git
Snapshot from the Session DO at any time, without a pre-compaction archive promise.
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
- Controlled in-guest Git commands from the Session DO and canonical-remote enforcement
- Guest Credential Opt-in configuration for providers without Egress Secret Mediation
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
7. Session starts Durable work in its Session DO concurrently with isolated Gondolin boot and the Session DO's guest clone and setup; guest tools wait cancellably for readiness while the environment is reachable.
8. Chat, thinking, tool calls, and tool output stream to desktop and mobile UI.
9. While the agent is running, normal sends become durable Follow-ups with stable Submission IDs and visible queue state. Explicit steering remains planned and requires a Durable contract; there are no current per-item queue mutation controls.
10. The Session DO admits sends, continues model work, and serves the conversation, media, and cached Git Snapshot while the assigned runner is offline; guest tools fail immediately instead of waiting. Admitted input and unfinished work persist in Session DO Harness State; request-ID deduplication does not promise exactly-once execution, and ambiguous commands are not silently retried.
11. After 15 minutes idle, the Session DO alarm triggers Stop Session, which closes the harness recoverably and then has the runner durably stop compute; Wake resumes checkpointed work and the same root disk. Abort cancels conversation work without stopping compute, and Environment Control does not pause the agent.
12. The user can review the Session DO-cached guest-generated aggregate diff while the VM is stopped or the runner is offline, and wake the VM to browse files, without native host Git interpreting the checkout.
13. Browser terminal works without any inbound runner port.
14. On the runner provider, the agent can fetch, commit, and push to a private repository without obtaining the real credential in the guest.
15. User can choose the pushed branch name.
16. Agent can publish a private managed preview that supports HTTP/WebSockets over the outbound tunnel.
17. Managed preview wakes and restarts after Stop; live-only preview clearly expires.
18. Capability preview links are revocable and do not expose gateway authentication to the guest.
19. Archive operates on the online owning runner. Explicit deletion is available online or offline, atomically removes the five-column Workspace-owned catalog row, stores only a Workspace/session/time deletion marker, removes the Session DO storage and the Session's R2 media prefix, and has the Session DO delete the runner environment, retrying while the runner is offline; a later stale runner report never resurrects the Session.
20. Pi never discovers project settings, packages, extensions, skills, prompts, themes, context files, or system-prompt fragments in the gateway or on the runner host; Pi/the model accesses project files and scripts only through the guest `ExecutionEnv`.
21. Model provider credentials never reach a runner.

## 33. Known risks and mitigations

### Remix 3 release-candidate churn

**Risk:** APIs and UI conventions may change.

**Mitigation:** Pin exact versions, follow current Remix 3 skill/docs, isolate adapters, and upgrade intentionally with route/component tests.

### Gondolin maturity and limitations

**Risk:** Experimental APIs, Alpine-only image builder, persistent-disk lifecycle, and serialized guest exec behavior.

**Mitigation:** Pin versions/build IDs and Debian OCI inputs, own a tested guest image, keep services explicitly process-managed, and maintain real-QEMU integration tests.

### Pi discovery defaults

**Risk:** A future harness or registry refactor could introduce project/global resource discovery,
ambient authentication, or a host execution adapter in the Session DO.

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

### Provider capability divergence

**Risk:** Sandbox-vendor providers may lack the runner's durable root disk, Egress Secret
Mediation, or hibernatable link, and project behaviour could drift if each provider reimplemented
it.

**Mitigation:** Keep project behaviour in the Session DO over `ExecutionEnv`, share the vendored
`RemoteExecutionEnv` wherever the static Environment Daemon runs, have providers declare
capabilities rather than promise the runner's guarantees, and admit credentials into unmediated
guests only through an explicit per-Project Guest Credential Opt-in.

### Pinned runner availability

**Risk:** A dead runner makes its sessions' compute, checkout, Git operations, terminals, and previews unavailable. The conversation, Published Media, and last Git Snapshot remain available from the Session DO and R2, and the agent keeps working with guest tools failing immediately.

**Mitigation:** Show an explicit unavailable state, reject runner-backed session operations while offline, permit marker-backed offline deletion, add runner-side backups/exports later, and defer migration rather than implementing unsafe partial movement.

### Workspace contention and runner persistence growth

**Risk:** The single Workspace DO serializes configuration/catalog operations, so slow work can delay
other calls. Session DO Durable databases, R2 media, and runner journals grow; a journal append may be incomplete after a crash.

**Mitigation:** Keep full Session data and live runner connections out of Workspace; Session DOs own
agent data, Runners owns live routing, and native SQLite transactions stay short. Environment
traffic uses per-Session Environment Links rather than the single Runners DO. Let Durable own database recovery/compaction; keep infrastructure journal appends
crash-checked and separate from conversation data. Do not claim the active view archives compacted
entries. Broader retention and journal compaction remain explicit future policies.

### Disk growth

**Risk:** Persistent root disks, Git objects, caches, and logs accumulate.

**Mitigation:** Disk reporting, a disk safety threshold, bounded logs/caches, archive/delete UI, and no surprise automatic deletion.

## 34. Deferred roadmap

- Centrally managed Pi Agent Profiles with trusted extensions
- Sandbox-vendor Agent Environment Providers (vendor link transport for the Environment Daemon, or a native `ExecutionEnv`), including their terminal/preview support
- Additional provider OAuth/subscription credentials beyond OpenAI Codex
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
- Production celld fleet provisioning, storage/replication, and backup/restore interfaces
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
