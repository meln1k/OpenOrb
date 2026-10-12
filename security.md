# Security notes

## Workspace tenant boundary

Each user belongs directly to one Workspace. Browser authentication resolves `{userId, workspaceId}`
from persisted user and session records and rejects mismatches; request fields cannot choose tenant
ownership. Passwords and Git author identity remain user-owned. Projects, encrypted secrets,
provider/Git credentials, runners, enrollment credentials, session catalog rows, and deletion
markers are scoped by immutable Workspace IDs, with tenant-relative uniqueness and reference checks
in the Workspace Durable Object. Cross-Workspace identifiers are treated as not found. Runner tokens
resolve ownership from trusted persistence, never from runner-supplied snapshots. Encryption AAD
binds `workspaceId`, credential key, and key version.

First setup atomically creates one Workspace and the single administrator; concurrent attempts must
not leave an orphan Workspace or create another administrator.

## Product security boundaries

- Session repositories, files, and Git metadata are untrusted. Native Git on the gateway or a
  provider host never consumes a session checkout; clone, branch, status, diff, fetch, commit, and
  push execute inside the guest (Gondolin on a runner), issued by the Session DO over Pi's
  `ExecutionEnv`. A Session without a project, which every Sandbox Session is, has no checkout and
  loads no Git integration: no clone, project hooks, skill discovery, or Git Snapshots, and a runner
  guest gets no GitHub mediation. Guest-reported base commits, branches, and Git Snapshot summaries
  are cached by the Session DO as untrusted display data. Full Git Snapshot patches stay in a guest
  file outside `/workspace`. The Session DO reads them in byte ranges only while the environment is
  running, never past the section size recorded at capture, and the browser renders them as
  untrusted text.
- The Agent Harness sees only Pi's `ExecutionEnv`. An Agent Environment Provider (the OpenOrb
  runner, the built-in Sandbox, sandbox vendors later) supplies compute, lifecycle, persistence,
  network policy, and the Environment Link, never project behaviour: clone,
  `.agents/setup`/`.agents/resume`, Git Snapshots, skill discovery, and Published Media run in the
  Session DO. Providers declare persistence, credentials (mediated, opt-in, or none),
  hibernatable-link, and Git capabilities rather than inheriting the runner's guarantees; the
  Session DO reads Workspace credentials only for providers that receive them. The Session record
  stores its provider kind and the Project's Guest Credential Opt-in at creation; the user picks the
  provider in the composer, and Workspaces without runners default to the Sandbox. Workspace
  defaults and Project overrides are deferred.
- The Sandbox ([ADR 0007](docs/adr/0007-built-in-sandbox-provider.md)) runs just-bash's browser
  build in a celld Worker Loader isolate per Session, loaded with no bindings (`env: {}`), no
  network (`globalOutbound: null`), and a per-call CPU limit, as a facet of the Session DO with its
  own SQLite database. just-bash has no Python, JavaScript, network commands, or host filesystem
  adapters there. Paths are interpreted only in the sandbox; the Session DO relays them over RPC. It
  is for inspecting untrusted content: it never checks out a project and declares no credentials, so
  the Session DO reads no Workspace secrets or GitHub token for it. Its extract-only `tar` enforces
  just-bash's archive limits before buffering entries. The boundary is a V8 isolate in the gateway
  process, not a VM, and celld makes no V8 escape claim, so a V8 escape compromises the gateway.
  Work that needs secrets or a full toolchain belongs on a runner.
- Pi Durable runs in one gateway Session Durable Object per Session with an explicit registry and
  in-memory credentials, never on the runner host. It discovers no gateway, runner, project, or
  global Pi resources. The Session DO reads passive repository skill metadata (YAML frontmatter
  only) from `/workspace/.agents/skills/**/SKILL.md` over the provider's `ExecutionEnv` once, as
  soon as the first checkout of the session branch exists; nothing is executed. The bounded (10 s)
  background scan publishes names, descriptions, and guest paths in the `repository-skills` prompt
  section; full instructions are read on demand. The catalog stays fixed for the Session and is
  recorded only in the conversation transcript's system prompt section; a failed first load is
  retried at the next start or reopen. Skill content remains untrusted guidance, never gateway or
  host code or policy. Model work and Environment Control never wait for skill discovery or guest
  readiness.
- File and shell tools use a vendored copy of pi-env's `RemoteExecutionEnv` client served by the
  unmodified static pi-env Environment Daemon inside the guest; providers that run the daemon share
  this client and differ only in link transport. A provider may instead return its own
  `ExecutionEnv`, which must likewise interpret paths only in the guest. Untrusted paths are
  interpreted only by guest processes; neither the Session DO nor a provider relay interprets them,
  and `NodeExecutionEnv` or host-filesystem fallbacks are forbidden. While the runner or provider is
  unreachable, guest tools fail immediately rather than waiting; prompt admission and model work
  continue.
- Each Session owns one Project Checkout and one isolated Agent Environment. On a runner, its
  private root disk, including the checkout and non-tmpfs guest state, persists together with the
  runner-owned Session Journal (VM/disk lifecycle facts only) and logs; RAM and processes do not.
  Harness State, Git Snapshot summaries and previews, and checkout facts live only in the Session
  DO's SQLite storage; full Git Snapshot patches remain in the guest; runners store no conversation
  content.
- Provider credentials persist encrypted in the Workspace DO and are resolved inside the gateway
  into the Session DO's in-memory credential store; they are never sent to runners or other Agent
  Environment Providers. The GitHub token and generic secrets are still sent to trusted runner
  commands as transient values for Gondolin Egress Secret Mediation. GitHub operations receive a
  guest-visible placeholder that is substituted only for `github.com` and `api.github.com`; on the
  runner the real token must not enter guest files, environment values, process arguments, logs, or
  tool output.
- On a provider without Egress Secret Mediation, real Git credentials and Workspace secrets enter
  the guest only under the Project's explicit Guest Credential Opt-in; without it the Session runs
  without them. Opted-in values are readable by guest code, the agent, and repository scripts, and
  can be exfiltrated or echoed into tool output.
- Durable conversation content is not scanned or redacted for credentials. Input, model responses,
  and tool output are persisted as supplied; a credential echoed into that content can be stored and
  shown to Session viewers. Credential isolation, not output filtering, is the boundary.
- Workspace generic secrets remain encrypted at rest and transient in runner commands. On the
  runner, Gondolin exposes only guest placeholders and substitutes real values in outbound HTTP
  headers. Configured host patterns restrict substitution; omitting allowed hosts permits
  substitution for any public HTTP(S) host and therefore permits guest code to exfiltrate that
  secret. Secret changes apply when an Agent Environment next starts, not to an already-running VM.
- Runners initiate every connection to the gateway (control, bulk, and per-Session Environment
  Links) as authenticated outbound WebSockets and require no inbound listener. Guest egress denies
  loopback, private, link-local, cloud-metadata, redirected, and DNS-rebinding targets while
  preserving guest-local loopback.
- The celld Workspace Durable Object owns SQLite-backed configuration, browser sessions, runner
  enrollment records, the minimal Session catalog, and deletion markers. Each Session DO owns its
  Harness State, Conversation View, Published Media records, and Stop Session orchestration; runners
  own environment state. The gateway webapp is the public Worker and no longer opens PostgreSQL.
- The public Worker enforces browser authentication, Workspace ownership, and CSRF before calling
  Workspace/Runners/Session native RPC. There is no public generic Workspace RPC endpoint. The
  Runners DO owns live control/bulk sockets, authenticates runner tokens against Workspace
  persistence, tracks capacity, and isolates live state by Workspace ID. It routes Environment
  Control by connection generation and notifies Session DOs when environments update, disappear,
  become unreachable, or lose a revoked runner. It does not route Sessions, write catalog rows, or
  carry conversation streams or agent tool traffic; the bulk socket carries only identification and
  a heartbeat. Replacement/revocation closes connection scopes and sockets, including the runner's
  Environment Links. Its live projections are reconstructed from runners' environment snapshots
  after restart, not treated as durable Session state. OpenAI Codex device authorization,
  alarm-driven polling, exchange, refresh, and revocation remain in Workspace; the Worker does not
  handle OAuth callbacks. PostgreSQL-to-DO data import is not implemented.
- The runner's Environment Link is a dedicated per-Session WebSocket dialed by the runner to the
  Session DO and authenticated by the runner token plus a one-time attach nonce. Other providers
  supply their own link transport. The runner relays daemon frames verbatim. Revoking a runner
  closes its Environment Links through the Runners DO. The Session DO accepts the link as a
  hibernatable WebSocket; liveness never wakes it because the relay answers daemon pings locally,
  link pings use the Durable Object's automatic response, and the client sends protocol pings only
  while requests are in flight. Losing the link closes the daemon and kills the processes it
  started; interrupted tools report possible partial execution.
- Published Media is read from `/workspace/.openorb/artifacts` over the Environment Link, validated
  by the Session DO, and written to an R2 bucket under the Session's
  `workspaces/{workspaceId}/sessions/{sessionId}/media/` prefix. Limits are 64 MiB per artifact and
  1 GiB total per Session, with no artifact-count cap; metadata and quota live in Session DO SQLite.
  Browsers can read it only through the authenticated, Workspace-scoped gateway route, including
  while the runner is offline. The route serves a fixed allowlist of non-scriptable image and video
  MIME types with `nosniff` and Range support; arbitrary guest paths, SVG, HTML, and remote image
  embeds are not mounted in the transcript. Session deletion removes the Session's R2 prefix and its
  Agent Environment, retried by the Session DO's alarm while the runner is offline, and then the
  Session DO storage.
- Ambiguous command handoffs are reported rather than retried automatically. Durable deduplicates
  admitted inputs by request ID and recovers checkpointed work on Wake. Model requests may repeat;
  interrupted unsafe tools report possible partial execution. OpenOrb does not claim exactly-once
  execution.
- Conversation streams come from the Session DO and carry snapshots, structural updates, and Session
  infrastructure state, including environment changes the runner reports. Reconnect replaces the
  baseline; subscribing alone never starts compute or resumes harness scheduling. Opening a session
  page separately sends a CSRF-protected Wake request; stream updates and reconnects do not repeat
  it. Harness ownership is serialized in the Session DO. Inline conversation images retain their
  bytes in Harness State/model context but cross the stream only as Session artifact references; the
  Session DO serves them from Harness State through the same MIME allowlist and authenticated
  gateway route, without the runner or bulk socket. Conversation images use Pi's declared MIME type,
  checked against the image allowlist without inspecting byte signatures again; raw guest files
  still use signature detection. Unsupported images or failed publication produce placeholders,
  never inline-byte fallback. Runner control RPC uses UTF-8 JSON with bounded SchemaBinary
  reassembly across binary WebSocket chunks (1 MiB per chunk, 16 MiB per logical frame). JSON is
  decoded only after frame reassembly; malformed UTF-8 and JSON are rejected. Chunking is
  transport-only: it does not bypass RPC validation or per-field limits. Disconnect discards partial
  frames; no partial RPC payload is dispatched. The control channel has no CBOR decoder or
  tagged-bignum expansion; application bigints use the RPC schema's string representation.
  Identification still requires decoding bounded input before authentication.

The executable release criteria and regression evidence for these boundaries are maintained in the
[release acceptance guide](docs/release-acceptance.md).

## Gondolin persistent root disk

**Status:** The former `RealFSProvider` workspace path race is resolved by removing the host-backed
workspace mount.

On the runner provider, each session checkout lives at `/workspace` on a private qcow2 root disk
under runner-owned session storage. Shell and Pi filesystem tools access it through the guest
Environment Daemon; untrusted paths are never interpreted by a gateway or host filesystem adapter.
The runner does not invoke native host Git against the disk or expose the disk as a shared writable
mount.

Root disk files use mode 0600 and their session directories use mode 0700. A guest `fsync` reaches
the QEMU block device, whose flushes are enabled, and therefore reaches the host storage stack. This
durability guarantee still depends on the runner filesystem and physical storage honoring host
`fsync` correctly.

The root disk always has the stable session path `root-disk.qcow2`. Its initial sparse 40 GiB file
is file-synced and atomically published before first use. For Stop Session, including the idle
timeout driven by its alarm, the Session DO closes the harness recoverably and collects the final
Git Snapshot over `ExecutionEnv` before asking the runner to stop compute. The runner runs guest
`/bin/sync`, stops the VM, and calls host `fsync` on `root-disk.qcow2` and its directory before
journaling `stop.completed`. Abort cancels agent work, queued inputs, and owned background work
without stopping compute. Agent environment control leaves the harness running. Forced restart may
lose unsynced writes and does not claim a graceful Stop; disk ownership is retained until the
previous VM has closed.

After a runner interruption in `Stopping`, reconciliation cannot prove that the guest sync and VM
exit finished, so the Session fails with the explicit `restart-environment` recovery action. The
runner does not replace or delete the disk. Wake opens the same disk in a new VM, after which the
Session DO runs `.agents/resume` over `ExecutionEnv`. RAM, processes, and tmpfs-backed paths such as
`/root`, `/tmp`, `/var/tmp`, `/var/cache`, and `/var/log` never persist across Stop.
