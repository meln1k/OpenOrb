# Security notes

## Workspace tenant boundary

Each user belongs directly to one Workspace. Browser authentication resolves `{userId, workspaceId}`
from persisted user and session records and rejects mismatches; request fields cannot choose tenant
ownership. Passwords and Git author identity remain user-owned. Projects, encrypted secrets,
provider/Git credentials, runners, enrollment credentials, session catalog rows, and deletion
markers are scoped by immutable `workspace_id`, with tenant-relative uniqueness and composite
foreign keys. Cross-Workspace identifiers are treated as not found. Runner tokens resolve ownership
from trusted persistence, never from runner-supplied manifests. Encryption AAD binds `workspaceId`,
credential key, and key version.

First setup atomically creates one Workspace and the single administrator; concurrent attempts must
not leave an orphan Workspace or create another administrator.

## Product security boundaries

- Session repositories, files, and Git metadata are untrusted. Native host Git never consumes a
  session checkout; clone, branch, status, diff, fetch, commit, and push execute inside Gondolin.
- Pi runs on the trusted runner host with an explicit resource loader that discovers no project or
  global Pi resources and with in-memory settings. Its file and shell tools are Gondolin-backed.
- Each Session owns one Project Checkout and one isolated Agent Environment. Its private root disk,
  including the checkout and non-tmpfs guest state, persists together with runner-owned Harness
  State, Session Journal, Git Snapshots, and logs; RAM and processes do not.
- Provider credentials remain on the gateway and trusted runner. GitHub operations receive a
  guest-visible placeholder that is substituted only for `github.com` and `api.github.com`; the real
  token must not enter guest files, environment values, process arguments, logs, or tool output.
- Runners initiate one authenticated outbound connection to the gateway and require no inbound
  listener. Guest egress denies loopback, private, link-local, cloud-metadata, redirected, and
  DNS-rebinding targets while preserving guest-local loopback.
- PostgreSQL is the gateway's only durable persistence. Complete Session state remains runner-owned;
  the gateway stores only configuration, the minimal Session catalog, and deletion markers.
- Ambiguous prompt, Abort, Git, and lifecycle handoffs are reported to the user and are never
  retried automatically. OpenOrb does not claim exactly-once execution.

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
is file-synced and atomically published before first use. An explicit Stop cancels an active Agent
Run and closes Pi before recording the final Git Snapshot; an idle Stop has no active work to
cancel. Stop then runs guest `/bin/sync` and explicitly stops and closes the VM without deleting the
disk. The runner calls host `fsync` on `root-disk.qcow2` and its session directory before journaling
`stop.completed`.

After a runner interruption in `Stopping`, reconciliation cannot prove that the guest sync and VM
exit finished, so the Session fails with the explicit `restart-environment` recovery action. The
runner does not replace or delete the disk. Wake opens the same disk in a new VM and runs
`.agents/resume`. RAM, processes, and tmpfs-backed paths such as `/root`, `/tmp`, `/var/tmp`,
`/var/cache`, and `/var/log` never persist across Stop.
