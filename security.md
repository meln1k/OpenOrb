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
- Each Session owns one Project Checkout and one isolated Agent Environment. Only the checkout,
  runner-owned Harness State, Session Journal, Git Snapshots, logs, and current Environment Snapshot
  persist when the environment stops; RAM and processes do not.
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

## Deferred Gondolin `RealFSProvider` path race

**Status:** Known, unresolved risk while OpenOrb uses Gondolin's host-backed VFS adapter.

Gondolin 0.12.0's `RealFSProvider` checks that a path resolves beneath its root and then performs
the corresponding asynchronous, pathname-based host filesystem operation. Its containment check and
filesystem operation are not atomic.

Gondolin's guest `sandboxfs` daemon processes its own FUSE requests one at a time, so a single guest
cannot exercise this race using two concurrent FUSE requests alone. OpenOrb nevertheless has two
independent paths to the same provider: `bash` accesses the workspace through guest FUSE, while the
Pi `read`, `write`, and `edit` adapters use Gondolin's host-side `vm.fs` shortcut. Gondolin does not
serialize direct `vm.fs` calls against guest FUSE requests, and a detached guest process can
continue running after the shell that launched it exits. A malicious `bash` invocation could
therefore leave a workspace mutator running while a later Pi filesystem tool calls `vm.fs`,
potentially replacing a checked path or parent directory with an escaping symlink between validation
and use. Another VM or host process sharing the workspace would provide the same concurrent mutation
path.

Static traversal and symlink checks do not cover this TOCTOU interleaving. We have confirmed the
vulnerable provider shape and the independent OpenOrb access paths, but have not demonstrated a
successful end-to-end escape from a real Gondolin guest.

OpenOrb intentionally does not serialize every provider operation as a workaround. Global
serialization could materially degrade filesystem-heavy guest workloads such as dependency
installation and repository tooling. Consequently, the current `RealFSProvider` mount must not be
treated as a proven containment boundary against concurrent rename/symlink attacks.

Before relying on Gondolin's VFS adapter as that boundary:

1. Re-evaluate whether OpenOrb still needs a writable host-backed workspace mount.
2. If it does, avoid mixing direct `vm.fs` operations with guest FUSE access, or otherwise
   coordinate those paths without serializing unrelated guest filesystem work.
3. Reproduce and measure a detached guest mutator racing a direct `vm.fs` operation on supported
   runner platforms, and benchmark any mitigation.
4. Prefer an upstream Gondolin fix that performs descriptor-relative, beneath-root operations
   atomically, or otherwise enforces the invariant inside `RealFSProvider`.
5. Add race tests for reads, writes, creates, and parent-directory mutations, including shared
   workspaces if multiple VMs may mount the same host directory.

If OpenOrb stops using the host-backed VFS adapter for untrusted workspaces, this specific risk does
not apply.
