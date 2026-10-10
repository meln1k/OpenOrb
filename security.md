# Security notes

## Workspace tenant boundary

Each user belongs directly to one Workspace. Browser authentication resolves `{userId, workspaceId}`
from persisted user and session records and rejects mismatches; request fields cannot choose tenant
ownership. Passwords and Git author identity remain user-owned. Projects, encrypted secrets,
provider/Git credentials, runners, enrollment credentials, session catalog rows, and deletion
markers are scoped by immutable Workspace IDs, with tenant-relative uniqueness and reference checks
in the Workspace Durable Object. Cross-Workspace identifiers are treated as not found. Runner tokens
resolve ownership from trusted persistence, never from runner-supplied manifests. Encryption AAD
binds `workspaceId`, credential key, and key version.

First setup atomically creates one Workspace and the single administrator; concurrent attempts must
not leave an orphan Workspace or create another administrator.

## Product security boundaries

- Session repositories, files, and Git metadata are untrusted. Native host Git never consumes a
  session checkout; clone, branch, status, diff, fetch, commit, and push execute inside Gondolin.
- Pi Durable runs on the trusted runner host with an explicit registry and in-memory credentials. It
  discovers no host project or global Pi resources. OpenOrb reads passive repository skill metadata
  from `/workspace/.agents/skills/**/SKILL.md` through Gondolin only after project setup or resume.
  The bounded background scan publishes names, descriptions, and guest paths for the next model
  request; full instructions are read on demand. Skill content remains untrusted guidance, never
  host code or policy. Stop cancels discovery and clears the catalog; start/restart and harness
  reopen refresh it. File and shell tools are Gondolin-backed; model work and host-side environment
  control never wait for skill discovery or guest readiness.
- Each Session owns one Project Checkout and one isolated Agent Environment. Its private root disk,
  including the checkout and non-tmpfs guest state, persists together with runner-owned Harness
  State, Session Journal, Git Snapshots, and logs; RAM and processes do not.
- Provider credentials persist encrypted in the Workspace DO; gateway and trusted runner commands
  receive transient values. GitHub operations receive a guest-visible placeholder that is
  substituted only for `github.com` and `api.github.com`; the real token must not enter guest files,
  environment values, process arguments, logs, or tool output.
- Durable conversation content is not scanned or redacted for credentials. Input, model responses,
  and tool output are persisted as supplied; a credential echoed into that content can be stored and
  shown to Session viewers. Credential isolation, not output filtering, is the boundary.
- Workspace generic secrets remain encrypted at rest and transient in runner commands. Gondolin
  exposes only guest placeholders and substitutes real values in outbound HTTP headers. Configured
  host patterns restrict substitution; omitting allowed hosts permits substitution for any public
  HTTP(S) host and therefore permits guest code to exfiltrate that secret. Secret changes apply when
  an Agent Environment next starts, not to an already-running VM.
- Runners initiate one authenticated outbound connection to the gateway and require no inbound
  listener. Guest egress denies loopback, private, link-local, cloud-metadata, redirected, and
  DNS-rebinding targets while preserving guest-local loopback.
- The celld Workspace Durable Object owns SQLite-backed configuration, browser sessions, runner
  enrollment records, the minimal Session catalog, and deletion markers. Complete Session state
  remains runner-owned. The gateway webapp is the public Worker and no longer opens PostgreSQL.
- The public Worker enforces browser authentication, Workspace ownership, and CSRF before calling
  Workspace/Runners native RPC. There is no public generic Workspace RPC endpoint. The Runners DO
  owns live control/bulk sockets, authenticates runner tokens against Workspace persistence, and
  isolates live state by Workspace ID. Replacement/revocation closes connection scopes and sockets;
  viewer stream cancellation closes only that subscription. Its live projections are reconstructed
  from runner manifests after restart, not treated as durable Session state. OpenAI Codex device
  authorization, alarm-driven polling, exchange, refresh, and revocation remain in Workspace; the
  Worker does not handle OAuth callbacks. PostgreSQL-to-DO data import is not implemented.
- Published Media is copied from `/workspace/.openorb/artifacts` into private Session storage on the
  runner, limited to 64 MiB per artifact and 1 GiB total per Session, with no artifact-count cap.
  Browsers can read it only through the authenticated, Workspace-scoped gateway route. The route
  serves a fixed allowlist of non-scriptable image and video MIME types with `nosniff`; arbitrary
  guest paths, SVG, HTML, and remote image embeds are not mounted in the transcript.
- Ambiguous command handoffs are reported rather than retried automatically. Durable deduplicates
  admitted inputs by request ID and recovers checkpointed work on Wake. Model requests may repeat;
  interrupted unsafe tools report possible partial execution. OpenOrb does not claim exactly-once
  execution.
- Conversation streams carry snapshots and structural updates. Reconnect replaces the baseline;
  subscribing alone never wakes compute. Opening a session page separately sends a CSRF-protected
  Wake request; stream updates and reconnects do not repeat it. Live and offline harness ownership
  is serialized. Inline conversation images retain their bytes in Durable/model context but cross
  the control stream only as Session artifact references. The same bounded private media store, MIME
  allowlist, authenticated gateway route, and chunked bulk WebSocket serve those images without
  waking compute. Conversation images use Pi's declared MIME type, checked against the image
  allowlist without inspecting byte signatures again; raw guest files still use signature detection.
  Unsupported images or failed publication produce placeholders, never inline-byte fallback. Control
  RPC uses UTF-8 JSON with bounded SchemaBinary reassembly across binary WebSocket chunks (1 MiB per
  chunk, 16 MiB per logical frame). JSON is decoded only after frame reassembly; malformed UTF-8 and
  JSON are rejected. Chunking is transport-only: it does not bypass RPC validation or per-field
  limits. Disconnect discards partial frames; no partial RPC payload is dispatched. The control
  channel has no CBOR decoder or tagged-bignum expansion; application bigints use the RPC schema's
  string representation. Identification still requires decoding bounded input before authentication.

The executable release criteria and regression evidence for these boundaries are maintained in the
[release acceptance guide](docs/release-acceptance.md).

## Gondolin persistent root disk

**Status:** The former `RealFSProvider` workspace path race is resolved by removing the host-backed
workspace mount.

Each session checkout lives at `/workspace` on a private qcow2 root disk under runner-owned session
storage. Shell and Pi filesystem tools access it through guest processes; untrusted paths are never
interpreted by a host filesystem adapter. The runner does not invoke native host Git against the
disk or expose the disk as a shared writable mount.

Root disk files use mode 0600 and their session directories use mode 0700. A guest `fsync` reaches
the QEMU block device, whose flushes are enabled, and therefore reaches the host storage stack. This
durability guarantee still depends on the runner filesystem and physical storage honoring host
`fsync` correctly.

The root disk always has the stable session path `root-disk.qcow2`. Its initial sparse 40 GiB file
is file-synced and atomically published before first use. Stop Session closes the harness
recoverably before recording the final Git Snapshot. It then runs guest `/bin/sync`, stops the VM,
and calls host `fsync` on `root-disk.qcow2` and its directory before journaling `stop.completed`.
Abort cancels agent work, queued inputs, and owned background work without stopping compute. Agent
environment control leaves the harness running. Forced restart may lose unsynced writes and does not
claim a graceful Stop; disk ownership is retained until the previous VM has closed.

After a runner interruption in `Stopping`, reconciliation cannot prove that the guest sync and VM
exit finished, so the Session fails with the explicit `restart-environment` recovery action. The
runner does not replace or delete the disk. Wake opens the same disk in a new VM and runs
`.agents/resume`. RAM, processes, and tmpfs-backed paths such as `/root`, `/tmp`, `/var/tmp`,
`/var/cache`, and `/var/log` never persist across Stop.
