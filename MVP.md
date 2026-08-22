# OpenOrb Lean MVP

> This document defines the first implementable OpenOrb release. It intentionally overrides the broader MVP scope in `MASTER_PLAN.md`. The master plan remains the longer-term product direction.

## 1. Goal

Prove the core OpenOrb workflow with the smallest useful system:

1. Deploy a gateway.
2. Enroll outbound-only Linux runners.
3. Configure a Pi provider API key and a public or private GitHub repository.
4. Start a session on an available runner.
5. Clone the repository inside a Gondolin VM.
6. Run host-side Pi with tools backed by Gondolin.
7. Stream conversation and tool activity to the browser.
8. Review workspace changes.
9. Ask the agent to commit and push a branch.
10. Stop and later continue the session.

The MVP is successful if a user can safely use spare Linux compute behind NAT as a remote coding-agent runner without configuring inbound networking.

## 2. Core principles

1. **Outbound-only runners.** Runners require no public IP, forwarded port, VPN, or SDN.
2. **One session, one VM, one checkout.** Each session has an independent workspace and Gondolin VM.
3. **Pi on the trusted runner host.** All agent tools execute through Gondolin-backed implementations.
4. **Untrusted workspace.** Repository files and `.git` metadata must never execute on the runner host.
5. **Git runs inside Gondolin.** Native host Git never consumes a guest-writable checkout.
6. **No Pi workspace discovery.** Pi uses an explicit empty `ResourceLoader` and in-memory settings.
7. **One prompt at a time.** Do not implement durable follow-up queues or editable pending Pi messages.
8. **Cold VM lifecycle.** Preserve the workspace and Pi JSONL, not guest root/process state.
9. **Runner-owned session data.** Complete live-session state lives on the assigned runner. The gateway keeps only a minimal user-owned catalog row—user ID, session ID, project, creation time, and a trimmed initial-prompt preview—plus user/session/time deletion markers that prevent stale runner resurrection.
10. **Prefer explicit failure.** If a runner disconnects or an operation becomes ambiguous, show an error and let the user retry.
11. **Tenant ownership from the start.** The MVP creates only one administrator, but every user-owned control-plane row and persistence operation is scoped by immutable `user_id`; uniqueness and foreign keys must not cross users.

## 3. Included features

### Gateway

- Single-administrator password authentication over a multi-row `users` schema
- PostgreSQL as the gateway's only durable persistence, covering gateway configuration, the minimal live-session catalog, and deleted-session markers
- Project configuration
- One encrypted API-key credential per configured Pi provider, with session model selection represented as one `provider/model` reference
- GitHub token configuration using a mediated guest-visible `GH_TOKEN` placeholder
- Per-user Git author name and email configuration
- Runner enrollment and revocation
- Runner online/offline status
- Minimal live-session catalog containing only user owner, project, creation time, and trimmed initial prompt
- Minimal user/session/time deletion markers
- Session creation, stop, continuation, and online/offline deletion
- Responsive chat UI
- Streaming assistant text, thinking, tool calls, and results
- Session status and provisioning logs
- Aggregate Git status/diff and changed-file view while the runner is online
- Live proxying of runner-owned session history and events; no gateway session mirror

### Runner

- Native Linux x86-64 and ARM64 service
- Simple enrollment with gateway URL and enrollment PSK
- One persistent outbound WebSocket
- Heartbeat and basic capacity reporting
- Automatic or manual runner selection before provisioning
- Predefined per-session orb sizes, defaulting to `medium`
- One Gondolin VM and checkout per session
- Host-side Pi SDK runtime
- Gondolin-backed `read`, `write`, `edit`, and `bash` tools
- Guest-side GitHub clone, status, diff, commit, fetch, and push using Git/`gh`
- GitHub `GH_TOKEN` mediation; the real token remains outside the guest
- Pi JSONL as the sole conversation transcript, plus metadata, reports, and workspace persistence
- Idle VM destruction and cold recreation

### Conversation

- Send a prompt only while Pi is idle
- Disable the composer during active work
- Abort the active run
- Continue an idle session with another prompt
- Persist completed messages and tool results on the runner
- No native follow-up or steering queue in the required MVP

A best-effort “Steer now” action may be added later if trivial, but it is not part of MVP acceptance.

## 4. Explicitly deferred

- Browser terminal
- HTTP/WebSocket previews and portals
- Binary runner data connection
- Wildcard preview DNS and TLS
- Capability links
- Managed guest services
- Durable offline prompt queue
- Pi follow-up queue UI
- Steering queue UI
- Queued-message edit, cancel, or promotion
- Exactly-once message delivery
- Gondolin checkpoints
- `.agents/resume`
- Aggregate CPU/memory reservation accounting and free-resource scoring
- Custom CPU and memory values outside the predefined orb sizes
- Runner labels and draining workflows
- Passkeys/WebAuthn
- Project environment secrets
- Provider credential testing UI
- Non-GitHub Git hosts and generic Git credentials
- SSH repository credentials and transport
- Gateway Commit & Push workflow
- Shared package caches
- Archive semantics
- Session migration
- Automatic pull requests
- Additional user account creation, organizations, sharing, and collaborative permissions
- Stable public API commitments
- Project Pi settings, packages, extensions, skills, prompts, themes, or context discovery

## 5. High-level architecture

```text
Browser
  │
  │ HTTPS + SSE
  ▼
Gateway
  ├── Remix 3 web UI and HTTP API
  ├── Password authentication
  ├── PostgreSQL
  ├── Encrypted model/Git credentials
  └── Runner registry, minimal session catalog, and live routing
          ▲
          │ one outbound authenticated WebSocket
          │
Runner behind NAT
  ├── Heartbeat, session inventory, and command handling
  ├── Complete session metadata, transcripts, events, reports, workspaces, and Pi JSONL
  ├── Host-side Pi SDK
  └── Gondolin manager
          │
          ▼
Per-session Gondolin VM
  ├── /workspace via RealFSProvider
  ├── Agent tool execution
  ├── Repository Git operations
  └── Mediated HTTP/HTTPS egress for GitHub
```

There is no browser-to-runner connection and no runner listener exposed to the network.

## 6. Technology choices

### Monorepo

- TypeScript throughout
- Deno 2.9.5 workspace with Deno-native package manifests, exact `npm:`/`jsr:` imports, `nodeModulesDir: "auto"`, and committed `deno.lock`; Deno owns the generated local `node_modules` tree needed by Remix browser-asset resolution, while no OpenOrb `package.json` or pnpm files are retained
- Suggested initial packages:

```text
packages/
  gateway/
  runner/
  protocol/
  pi-runtime/
  gondolin-runtime/
```

Do not create additional abstraction packages until they are justified by working code.

### Gateway

- Remix 3
- Resolve Remix 3 from the current `preview/main` source when scaffolding and pin the exact resolved commit in the lockfile
- Deno 2.9.5 server using `Deno.serve()` around Remix's Fetch-oriented router
- Remix routes/controllers/actions and middleware for browser request handling
- `remix/data-table` with its PostgreSQL adapter and explicit committed migrations; `pg` is an explicit application dependency
- Remix session/auth/CSRF primitives (`remix/middleware/session`, `remix/auth`, `remix/middleware/auth`, and `remix/middleware/csrf`)
- A narrow PostgreSQL adapter for Remix `SessionStorage`; no Redis, KV store, cookie-only production sessions, or application-owned durable local files
- No custom auth/session framework; only application-owned credential verification and persistence adapters
- The gateway process may keep only rebuildable in-memory routing/live state; no Redis, KV store, or application-owned durable local files
- HTTP commands and SSE session events
- No browser WebSocket requirements in the MVP

### Runner

- Native Linux service
- Ordinary file-backed persistence only; no runner database. Sensitive identity/token files use restrictive filesystem permissions.
- A temporary macOS development harness may run the same runner workflow locally; macOS is not a supported release target
- Standalone Deno-compiled GNU Linux x86-64/ARM64 executable; runner hosts need neither Node.js nor an installed Deno executable
- glibc 2.27 or newer for the current Deno 2.9.5 artifacts; reject musl with an actionable error
- QEMU/KVM and pinned Gondolin 0.12.0
- One JSON WebSocket to the gateway
- systemd service for normal deployment

Release artifacts are exactly `dist/openorb-runner-linux-x64` and `dist/openorb-runner-linux-arm64`, built with Deno's GNU targets and accompanied by SHA-256 checksums. The startup CWD is the canonical runner working directory; development uses ignored `.openorb-runner-dev/`, production systemd sets `WorkingDirectory=/var/lib/openorb-runner`, and the MVP has no `--data-dir` option.

The one compiled runner process has working-directory-only read/write permission, unrestricted Deno network permission, architecture-appropriate QEMU-suite-only subprocess permission, narrow environment/system permission, and no FFI or `--allow-all`. Public network permission is not an SSRF boundary: application/Gondolin egress policy must deny loopback, private, link-local, cloud-metadata, redirected, and DNS-rebinding targets. QEMU is outside Deno's sandbox, so OpenOrb exposes no raw QEMU argv/path/device interface and creates VMs only with trusted OpenOrb-owned options passed to the pinned Gondolin `VM` API.

Guest assets are separate from the executable. Runner release metadata pins one exact image build ID and per-architecture URL, size, and SHA-256 values. Downloads install atomically into `images/<build-id>/`; only verified real files may reach Gondolin/QEMU. Production never resolves `latest` or embeds VM images with `deno compile`.

## 7. Authentication and credentials

### User authentication

- First-run setup creates one admin user.
- User IDs are application-generated UUIDv7 values stored in PostgreSQL `uuid` columns.
- Use Remix's credentials-auth primitives: `createCredentialsAuthProvider()`, `verifyCredentials()`, and `completeAuth()`.
- Password creation and verification use asynchronous Web Crypto PBKDF2-HMAC-SHA-256 with exactly 600,000 iterations, a unique random 16-byte salt, and a 256-bit derived key. Accept only this fixed profile. The unreleased Argon2 development database is explicitly reset; no Argon2 or dual-KDF compatibility path exists.
- Use Remix session middleware and `auth()`/`createSessionAuthScheme()` for request identity; protect authenticated routes with `requireAuth()`.
- Browser sessions use opaque signed session IDs in secure, HTTP-only, host-only cookies; session data and expiry are stored in PostgreSQL through a narrow Remix `SessionStorage` adapter.
- Login rotates the session ID and logout destroys the session.
- State-changing requests use Remix CSRF middleware.
- Require a deployment-injected session-cookie signing secret outside tests; local development may omit `Secure` only when not serving HTTPS.
- Passkeys are deferred.

### Secret storage

The gateway encrypts:

- Provider API keys, stored as one separately encrypted credential per Pi provider
- The GitHub token

Require the application master key through `OPENORB_MASTER_KEY` or an equivalent deployment-time secret injection. The gateway never generates or persists the master key to local disk or PostgreSQL. It fails startup if the key is missing or invalid. Import the 256-bit key with Web Crypto and use `@std/crypto`'s `encryptAesGcm()`/`decryptAesGcm()` directly. Persist their returned bytes unchanged as one opaque value, store key version separately, and authenticate immutable user ID, credential key, and key version as AAD. Secret values are never returned to the browser after creation.

Every `encrypted_secrets` row has an immutable `user_id` and explicit required purpose. Provider keys use `provider-api-key` and are referenced by provider ID through `model_provider_credentials`; generic secrets use `generic-secret`; rows referenced by `git_credentials` use `git-credential`. Secret repositories select rows by user and purpose, not key-prefix conventions. Provider credential records use opaque secret keys and do not derive identity from environment-variable names.

### Runner enrollment

Use a simple bearer-token design:

1. The gateway always provides the administrator's reusable enrollment PSK under **Settings → Runners**. It remains valid for additional enrollments until the administrator regenerates it. Regeneration atomically revokes the previous PSK and creates its replacement, and PostgreSQL enforces at most one active PSK per user. The current PSK is embedded in a visible, copyable runner-enrollment command with a regenerate action and no revoke or delete action.
   The gateway stores each PSK unencrypted in PostgreSQL. PostgreSQL read access therefore grants access to active enrollment PSKs.
2. Runner submits the PSK, name, architecture, and capabilities.
3. Gateway derives immutable runner ownership from the enrollment PSK's authenticated user, stores `user_id` on both enrollment and runner rows, and returns a random revocable runner token. Runner input cannot choose a tenant.
4. Runner stores the token with filesystem mode `0600`.
5. Runner authenticates its outbound WebSocket with that token.
6. Revocation immediately prevents reconnect.

Ed25519 challenge-response is deferred.

## 8. Runner connection

Each runner opens one connection:

```text
wss://openorb.example.com/api/runners/connect
```

The socket carries JSON messages for:

- Authentication and protocol version
- Heartbeats
- Session provisioning
- Prompt dispatch
- Abort
- Pi events
- Provisioning logs
- Session lifecycle state
- Git status/diff reports
- Command results

There is no binary multiplexing protocol in the MVP.

### Minimal envelope

```ts
interface RunnerMessage<T = unknown> {
  version: 1
  id: string
  type: string
  sessionId?: string
  correlationId?: string
  payload: T
}
```

Commands have IDs for logging and basic duplicate detection. The MVP does not promise exactly-once execution for non-idempotent commands.

## 9. Runner selection

Each runner advertises:

```ts
interface RunnerCapacity {
  maxConcurrentSessions: number
  activeSessions: number
  vmCpuCount: number
  vmMemoryMiB: number
  diskFreeMiB: number
}
```

The user selects one predefined orb size per session. `medium` is the default:

| Size | CPUs | Memory |
|---|---:|---:|
| `tiny` | 1 | 2 GB |
| `small` | 2 | 4 GB |
| `medium` | 4 | 8 GB |
| `large` | 8 | 16 GB |
| `xxlarge` | 16 | 32 GB |

The runner durably owns the selected size in its session metadata. The gateway carries it in validated provisioning traffic and live runner snapshots but does not add resource columns to the `sessions` catalog. A retry uses the original stored size.

`vmCpuCount` and `vmMemoryMiB` advertise the largest single-session request the runner can accept. The gateway rejects a selected size above those limits, and the runner re-checks the same limits authoritatively before creating durable session state. `activeSessions` counts provisioned VMs currently consuming a concurrency slot, including VMs that are provisioning or running. Stopped sessions with no VM do not count.

Selection algorithm:

1. Consider connected runners with `activeSessions < maxConcurrentSessions`.
2. Reject runners below a disk safety threshold or unable to host the selected orb size.
3. Honor a manually selected runner if available.
4. Otherwise choose the runner with the fewest active sessions.
5. Pin the session after provisioning begins.

No reservation handshake, labels, resource ratios, or migration are required.

If no runner is available, session creation is rejected with a clear error. The gateway does not queue work for an offline runner.

## 10. Session storage

Runner persistence uses ordinary files and directories, not a database. Sensitive runner identity/token files use restrictive filesystem permissions.

Suggested runner layout:

```text
/var/lib/openorb-runner/
  runner.json
  token
  images/
  sessions/
    <session-id>/
      metadata.json
      workspace/
      pi/
        session.jsonl
      reports/
        git-status.json
        diff.patch
      logs/
```

Persist only on the runner:

- Workspace and `.git`
- Pi JSONL
- Complete session metadata, including the selected orb size, and pinned-runner identity
- Provisioning and operation logs
- Last bounded Git status/diff report

The gateway stores only this minimal session catalog record:

```ts
interface SessionCatalogEntry {
  userId: string
  id: string
  projectId: string
  createdAt: string
  initialPromptPreview: string
}
```

`initialPromptPreview` is the initial textual prompt with whitespace collapsed and truncated to at most 200 Unicode code points. It excludes attachments and is never used to replay a prompt. No runner ID, title, status, branch, model, transcript, tool data, event cursor, diff, or other runtime state is persisted in the gateway.

On connect and reconnect, the runner sends a complete snapshot of its sessions, including the four catalog data fields and live routing/state data. The gateway derives ownership from the authenticated runner record rather than accepting a snapshot-supplied tenant, runtime-validates the snapshot, upserts any missing five-column catalog rows that are not marked deleted, and rebuilds its user-scoped in-memory routing index. This recovers a runner-local session created before a gateway crash could commit its catalog row. Existing catalog entries remain visible while their runner is offline. Snapshot absence alone does not delete a catalog row because the gateway does not persist runner assignment. A snapshot entry whose `(user_id, session_id)` has a gateway deletion marker is never reinserted or routed; the runner is instructed to remove it once any active work settles.

Do not persist:

- Running guest processes
- Guest memory
- Guest root filesystem changes
- Pi’s in-memory message queues

## 11. VM lifecycle

### First start

1. Select and pin an online runner.
2. Runner creates the session locally and stores the full initial prompt.
3. After runner confirmation, gateway stores the immutable user owner and four catalog data fields with the trimmed prompt preview.
4. Create an empty session workspace.
5. Resolve the session's selected predefined size and start a fresh Gondolin VM with its CPU/memory values.
6. Mount the workspace at `/workspace` with `RealFSProvider`.
7. Configure mediated network and Git credentials.
8. Clone the repository from inside Gondolin.
9. If cloning succeeds, create the session branch and run executable `.agents/setup` inside Gondolin if present.
10. If cloning fails, preserve and stream the bounded failure log, mark the checkout unavailable, and continue to Pi rather than failing the session. Do not run branch creation or `.agents/setup` without a valid checkout.
11. Create/open the host-side Pi session.
12. Send the initial prompt.

### While active

- Keep the VM running during agent, provisioning, setup, and report work.
- Record the latest accepted user-message time for idle shutdown.
- A normal prompt is allowed only when Pi is idle.
- Refresh the guest-generated Git report after Pi settles.
- Manual Stop is accepted only when Pi is idle and no provisioning, setup, or report operation is active; otherwise the user must wait or Abort the active run first.

### Idle stop

The VM may stop when at least 15 minutes have passed since the latest accepted user message and no agent, provisioning, setup, or report work is active:

1. Run a final Git status/diff inside Gondolin.
2. Store the bounded report outside the guest-writable workspace.
3. Destroy the VM.
4. Keep the workspace and Pi JSONL.

### Cold continuation

1. Start a clean Gondolin VM.
2. Remount the existing workspace.
3. Reconfigure egress and credential mediation.
4. Run `.agents/setup` again.
5. Reopen the existing Pi JSONL session.
6. Accept the next prompt.

`.agents/setup` must therefore be idempotent. Dependencies installed under `/workspace` persist; guest OS/root changes do not.

No checkpoint creation, compatibility management, `.agents/resume`, service restoration, or lease system is required.

### Delete

Deletion requires explicit confirmation. In one PostgreSQL transaction, the gateway writes a durable deleted-session marker containing only user ID, session ID, and deletion time and removes the five-column catalog row. It then removes the user-scoped live route before requesting runner cleanup. The marker is committed first so a gateway crash cannot resurrect a session after runner-side deletion.

- If the runner is online and idle, it removes the workspace, Pi JSONL, metadata, events, reports, and logs.
- If the runner is online but active, deletion is rejected; the user must wait for the work to settle. An offline deletion cannot determine live state, so if the runner later reconnects with active work, cleanup waits until that work settles rather than interrupting it.
- If the runner is offline or its host has been lost, the catalog card is still removed and the marker remains.
- If any runner later reports the deleted session ID in a complete snapshot, the gateway does not recreate the catalog row and repeatedly requests idempotent cleanup until the runner confirms removal.
- Deleted-session markers are retained so a stale runner disk or backup cannot resurrect a deleted session.

## 12. Pi integration

### Placement

Pi runs on the trusted runner host. It never receives unrestricted host filesystem or shell tools.

### Tools

Provide Gondolin-backed implementations for:

- `read`
- `write`
- `edit`
- `bash`

Additional file-search tools may be added only if they use the same Gondolin/path boundary.

### Resource loading

This security rule remains mandatory even in the lean MVP:

- Never use `DefaultResourceLoader` against the workspace.
- Use one audited `OpenOrbPiSessionFactory`.
- Pass an explicit `ResourceLoader` returning no project extensions, packages, skills, prompts, themes, agent files, or appended system prompts.
- Use `SettingsManager.inMemory(...)`.
- Never load `.pi/settings.json` or global Pi settings.
- Use only the trusted OpenOrb system prompt.
- Project files may be inspected by the model only through Gondolin-backed tools.

### Model credentials

- The gateway stores each Pi provider's API key as a separately encrypted credential referenced by that provider ID. Generic secrets remain independent and cannot be selected as model credentials.
- The browser selects one opaque `provider/model` reference from the models belonging to configured Pi API-key providers. Split the reference only at its first `/`; model IDs may contain additional `/` characters.
- Tests default to Pi's built-in `opencode-go/deepseek-v4-flash` model definition and thinking level `high`.
- The browser sends only the selected model reference. The gateway resolves its provider and sends the model reference, thinking level, and selected provider credential only to the pinned trusted runner.
- Runner supplies it through Pi runtime credential APIs.
- Model credentials never enter Gondolin.

### Persistence

- Pi JSONL lives in the session’s runner directory.
- Pi JSONL is the sole durable conversation transcript. The runner projects Pi's active branch into bounded wire/UI events and derives replay positions from that projection; it does not write an OpenOrb transcript or event log.
- The gateway relays history and events but does not persist session content or state.
- Token deltas may be streamed live; completed conversation history is replayed from Pi JSONL.

## 13. Messaging semantics

### Initial prompt

The initial prompt is stored with the session while provisioning occurs. If VM creation or another fatal provisioning step fails, show the session as failed and require an explicit retry. Retry destroys any current VM, creates a fresh VM, remounts the existing workspace, and reruns provisioning. A repository clone failure is a visible non-fatal warning: preserve its log and continue the Pi session with the checkout marked unavailable.

### Subsequent prompts

A prompt may be sent only when:

- Runner is connected
- Session VM is running or can be cold-started
- Pi is idle
- No other prompt dispatch is in progress

The composer is disabled otherwise.

### Active run

While Pi is running:

- Show streaming progress.
- Disable normal sending.
- Permit Abort.
- Do not call `followUp()` in the required MVP.
- Do not expose editable/cancellable Pi queue items.

### Failure semantics

- If a runner disconnects before prompt handoff, show an error and let the user retry.
- If a process crashes during prompt handoff, reconcile from Pi JSONL where obvious; otherwise show an ambiguous failure and require user retry.
- Do not claim exactly-once prompt execution.
- Do not silently replay an ambiguous prompt.

## 14. Git security and workflow

### Absolute boundary

The workspace and `.git` are guest-controlled. Never run native host Git against a session checkout, including for read-only-looking commands such as status, diff, or log.

All of these run inside Gondolin:

- Clone
- Branch creation
- Status
- Diff
- Log
- Fetch
- Commit
- Push

### GitHub token mediation

1. The guest receives a generated placeholder value as `GH_TOKEN` for GitHub CLI/Git operations.
2. Gondolin host hooks replace the placeholder only for the configured GitHub endpoints and canonical repository.
3. The real GitHub token remains in runner memory and never enters guest files, environment values, process arguments, logs, or tool output.
4. Other hosts and repositories receive no substitution.
5. Public repositories work without a credential; private clone/fetch/push use the same mediated token path.
6. Projects use their owning user's singleton GitHub credential when one is configured; credentials are not selected or persisted per project.

SSH repositories, private keys, and non-GitHub hosts are deferred.

### Agent workflow

There is no separate Commit & Push gateway workflow. The user asks the agent to commit and push.

The gateway requires a per-user Git author name and email. The runner supplies the owning user's identity to guest Git for OpenOrb session commits.

The trusted OpenOrb system prompt instructs the agent:

- Commit/push only when explicitly requested.
- Use the session branch.
- Never force-push.

Remote branch protection remains authoritative.

### Change review

After each settled run and before VM destruction:

1. Execute controlled `git status` and `git diff` inside Gondolin.
2. Disable external diff/textconv and configured filesystem monitors.
3. Bound output size.
4. Store a normalized report in the runner’s host-owned session directory outside the workspace.
5. Serve it through the gateway only while that runner is connected.

When the VM is stopped but the runner is online, display the runner’s cached report. Do not run host Git.

## 15. Browser UI

### Required screens

- Login/setup
- Projects
- Model credentials
- Git credentials and per-user Git author identity
- Runners
- Session list
- Session create
- Session conversation
- Session changes

### Session page

Show:

- Project, ref, branch, and pinned runner
- Provisioning/VM/agent status
- Conversation and tool calls
- Prompt composer while idle
- Abort while running
- Aggregate diff and changed files
- Stop and Delete actions

### Mobile

- Conversation is the primary view.
- Session list uses a drawer.
- Changes use a separate tab/sheet.
- Composer and Abort remain reachable without horizontal scrolling.

No terminal or embedded preview UI is required.

## 16. Browser API

The API is internal and unstable for the MVP.

```http
POST   /auth/setup
POST   /auth/login
POST   /auth/logout

GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId

GET    /api/models
POST   /api/models
DELETE /api/models/:modelId

GET    /api/git-credentials
POST   /api/git-credentials
DELETE /api/git-credentials/:credentialId

GET    /api/runners
POST   /api/runner-enrollment-tokens
POST   /api/runners/:runnerId/revoke

GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:sessionId
POST   /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/abort
POST   /api/sessions/:sessionId/stop
DELETE /api/sessions/:sessionId

GET    /api/sessions/:sessionId/events?after=<cursor>
GET    /api/sessions/:sessionId/diff
```

`DELETE /api/sessions/:sessionId` remains available while the runner is offline. After explicit confirmation, it commits the minimal deletion marker and removes the catalog row without waiting for runner cleanup.

Remix actions/controllers are the default implementation for browser flows. JSON/resource routes are used only where needed for commands, SSE, or browser-side interactions. The behavior matters more than preserving this exact route list.

## 17. Session events

Use SSE:

```http
GET /api/sessions/:sessionId/events?after=<cursor>
Accept: text/event-stream
```

Minimal events:

```ts
type SessionEvent =
  | { type: "session.state"; state: SessionState }
  | { type: "provisioning.log"; stream: "stdout" | "stderr"; text: string }
  | { type: "assistant.text.delta"; messageId: string; delta: string }
  | { type: "assistant.thinking.delta"; messageId: string; delta: string }
  | { type: "assistant.completed"; message: AssistantMessage }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCallId: string; result: ToolResult }
  | { type: "workspace.changed"; summary: DiffSummary }
```

The runner derives completed conversation events and monotonic positions from the active Pi JSONL branch. The gateway proxies SSE and asks the runner to replay events after the browser’s cursor. Neither the runner nor gateway stores a second event history.

If the runner is offline, session history and SSE replay are unavailable.

## 18. Minimal persistence model

Gateway PostgreSQL is the gateway's only durable persistence. It stores configuration plus the minimal session catalog:

- `users`
- `password_credentials`
- `browser_sessions` (the PostgreSQL backing store for Remix sessions, with nullable `user_id` for anonymous pre-login sessions and required owner consistency once authenticated)
- `encrypted_secrets` (uuid id primary key, immutable user owner, per-user unique credential key, required purpose, encrypted value)
- `model_provider_credentials`
- `git_credentials`
- Per-user Git author configuration
- `projects`
- `runners`
- `runner_enrollment_tokens`
- `sessions`, restricted to `user_id`, `id`, `project_id`, `created_at`, and `initial_prompt_preview`
- `deleted_sessions`, restricted to `user_id`, `session_id`, and `deleted_at`

It must not add any other session columns or contain message, tool-call, event, diff, file, log, preview, status, branch, model-selection, usage, or runner-assignment records. The separate deleted-session markers contain only user ownership, session identity, and deletion time. Session routing is a user-scoped in-memory index rebuilt from connected runner snapshots. Do not add Redis, another database/KV service, or application-owned durable gateway files.

Runner-local storage contains the complete session data, including the full metadata duplicated only in trimmed form by the catalog. Use Pi's JSONL as the sole durable conversation transcript, atomic JSON for session metadata, ordinary log files, and JSON/patch Git reports. Derive bounded replay/wire events from Pi JSONL instead of adding an OpenOrb event file. Do not add a runner-local database for the MVP.

Do not add gateway tables for:

- Session routes or additional session fields beyond `user_id` and the four catalog data columns
- Messages, tool calls, or events
- Diffs, files, or logs
- Preview capabilities
- Terminals
- Queued follow-ups
- Pending message editing
- Resource reservations
- Archives
- Any deletion record beyond the minimal `deleted_sessions` marker
- Agent profiles

## 19. Failure behavior

### Runner offline

- Mark the runner offline and remove its sessions from the live routing index.
- Keep minimal catalog cards visible using project, creation time, and initial-prompt preview.
- Session transcript, diff, files, status, Stop, and other runner-backed actions are unavailable because no gateway copy exists. Explicit deletion remains available because it records a gateway deletion marker and removes the catalog card without waiting for the runner.
- Disable prompt submission.
- Do not move sessions to another runner.
- Restore the session inventory and access after the same runner reconnects.

### Runner process crash

- Reopen Pi JSONL and workspace.
- Mark an interrupted run failed.
- Do not reconstruct Pi in-memory queues.
- Let the user send a new prompt after recovery.

### VM failure

- Preserve workspace, Pi JSONL, reports, and logs.
- Destroy the failed VM.
- Permit an explicit cold-start retry.

### Setup failure

- Show setup stdout/stderr.
- Emit a visible warning and continue to Pi so the prompt can diagnose or repair the project.

### Gateway restart

- Minimal catalog rows remain available.
- Runners reconnect automatically and send complete session snapshots; the gateway derives ownership from the authenticated runner, upserts missing non-deleted five-column catalog rows, rejects user-scoped tombstoned entries, and rebuilds user-scoped live routes.
- Browsers reload full history/state through the reconnected runner.
- No full session reconstruction occurs from gateway storage.
- In-flight operations may be marked failed and manually retried.

The MVP favors visible manual recovery over distributed exactly-once machinery.

## 20. Testing priorities

### Security invariants

- No native host Git process consumes a session workspace.
- Hostile `.git/config`, hooks, helpers, filters, textconv, fsmonitor, and configured external commands cannot execute on the runner host.
- `DefaultResourceLoader` is forbidden in runner session code.
- Hostile `.pi` resources/settings cannot execute or alter Pi configuration.
- All Pi file/shell tools execute through Gondolin.
- Real Git and model credentials never appear in guest files, environment variables, logs, process arguments, or tool output.
- `GH_TOKEN` placeholder substitution is restricted to the configured GitHub endpoints and canonical repository.
- Workspace path traversal and escaping symlinks are rejected.

### End-to-end path

1. Enroll a runner behind NAT.
2. Configure a Pi provider credential and a GitHub token.
3. Create a project.
4. Start a session.
5. Clone inside Gondolin.
6. Run `.agents/setup`.
7. Stream a real Pi response and tool calls.
8. Modify files.
9. Review the cached diff.
10. Ask the agent to commit and push.
11. Destroy the idle VM.
12. Cold-start and continue from the same workspace/Pi JSONL.
13. Delete the session.

### Failure tests

- Runner disconnect during provisioning
- Runner disconnect during a prompt
- Gateway restart during a session
- Setup failure
- Non-fatal clone failure with a usable Pi session and visible diagnostics
- Model failure
- VM start failure
- HTTPS Git authentication failure
- Private GitHub clone/push through the mediated `GH_TOKEN`
- Verification that the real GitHub token never enters the guest
- Idle cold restart
- Offline deletion followed by a stale runner reconnect cannot recreate the catalog row or route

## 21. Implementation milestones

### Milestone 0 — Foundation and security boundaries

- Deno 2.9.5 TypeScript workspace and lockfile
- Remix 3 resolved from current `preview/main` and pinned exactly
- Shared protocol schemas
- PostgreSQL user-owned gateway configuration, five-column live-session catalog, and minimal user/session/time deletion markers
- Explicit empty Pi `ResourceLoader`
- In-memory Pi settings
- Gondolin-backed tools
- Static prohibition of `DefaultResourceLoader`
- Host-Git prohibition tests

**Exit:** A hostile fixture workspace cannot execute code through Pi discovery or host Git.

### Milestone 1 — Gateway and runner connection

- Remix-backed password setup/login and PostgreSQL browser sessions
- Encrypted Pi provider and GitHub token credentials
- Per-user Git author name/email configuration
- Projects
- Runner enrollment bearer token
- Single outbound runner WebSocket
- Heartbeat/status UI
- Basic runner selection

**Exit:** A NATed runner enrolls and appears online using only the gateway URL and enrollment PSK.

### Milestone 2 — Session provisioning

- Session storage
- Gondolin developer image
- Predefined per-session orb sizes
- Guest-side public/private GitHub clone through mediated `GH_TOKEN`
- Session branch
- `.agents/setup`
- Provisioning events and logs

**Exit:** The browser can create a session that clones and prepares a private repository entirely inside Gondolin.

### Milestone 3 — Pi conversation

- Host-side Pi session factory
- Runtime model credentials
- Gondolin tools
- Persistent Pi JSONL
- HTTP prompt/abort
- SSE event streaming
- Pi JSONL conversation persistence and gateway live proxying
- One-prompt-at-a-time UI

**Exit:** The user can run and continue a streamed coding-agent conversation from desktop or mobile.

### Milestone 4 — Changes, push, and cold lifecycle

- Guest-side status/diff reports
- Changes UI
- Agent Git commit/push to GitHub through mediated `GH_TOKEN`
- 15-minute idle VM destruction
- Cold VM recreation
- Repeated idempotent setup
- Stop and delete
- Reconnect/failure polish

**Exit:** The agent can modify and push a private repository, the user can review changes, and the session continues after its VM is destroyed and recreated.

## 22. MVP acceptance criteria

The lean MVP is complete when:

1. A user can complete first-run password setup and use the Remix-backed password-protected gateway; valid sessions survive a gateway-process restart against the same PostgreSQL database.
2. A Linux runner behind NAT enrolls using a URL and enrollment PSK.
3. The runner needs no inbound port or VPN.
4. The user can configure Pi provider API keys, a GitHub token, and per-user Git author name/email.
5. The user can create a project and start a session on an available runner.
6. The repository is cloned inside Gondolin, never with host Git against the session workspace.
7. `.agents/setup` runs inside Gondolin.
8. Host-side Pi uses only the explicit empty resource loader and in-memory settings.
9. Pi tools read, write, edit, and execute commands through Gondolin.
10. Chat text, thinking, tool calls, results, and status stream to the browser.
11. The UI permits one normal prompt at a time and supports Abort.
12. The gateway stores only immutable user ownership, session ID, project, creation time, and a 200-code-point initial-prompt preview for live sessions, plus minimal user/session/time deletion markers; completed transcript data is replayed from the runner after reconnect.
13. The user can view the last guest-generated Git diff while the runner is connected.
14. The agent can clone, commit, and push a private GitHub repository without obtaining the real GitHub token.
15. Idle VMs are destroyed while workspace and Pi JSONL remain.
16. The session can cold-start and continue with the same checkout and conversation.
17. A pinned session remains unavailable rather than migrating while its runner is offline.
18. The user can stop and explicitly delete a session; offline deletion removes its catalog card and prevents a stale runner snapshot from resurrecting it.

## 23. Post-MVP order

After the lean MVP is stable, add major features in this order:

1. Generic HTTPS Git hosts and SSH repository credentials
2. Pi-native follow-up and steering UX
3. Passkeys
4. Shared package caches
5. Browser terminal and binary runner transport
6. Private live-only previews
7. Managed previews with restart commands
8. Project secret mediation
9. Aggregate resource reservations and free-resource scoring
10. Gondolin checkpoints if cold restarts prove inadequate
11. Archive/retention workflows
12. Centrally managed trusted Agent Profiles

Do not implement these opportunistically during MVP work. Each should be an explicit scope change.
