# Store the project checkout on a persistent session root disk

**Status:** Accepted

Each session uses one private, sparse 40 GiB qcow2 root disk at the stable runner-owned path
`root-disk.qcow2`. `/workspace` is an ordinary directory on that disk. OpenOrb does not mount a host
workspace through Gondolin's VFS, and Pi filesystem tools execute guest commands instead of using
Gondolin's host-side `vm.fs` shortcut.

## Durability contract

A successful guest `fsync` must survive a guest, QEMU, runner-process, or host crash, assuming the
runner's filesystem and storage honor `fsync`. QEMU attaches the retained disk without volatile
snapshot mode, forwards guest flushes to the host storage stack, and never deletes the disk when the
VM closes.

Initial provisioning creates the disk in the session directory, file-syncs it, publishes it at the
stable path with an atomic hard link, and syncs the directory. Restore and recovery only attach an
existing disk and fail rather than recreate a missing one. Only one VM may attach the writable disk
at a time.

Stop takes a final Git Snapshot, runs guest `/bin/sync`, closes Pi, and explicitly stops and closes
the VM while retaining `root-disk.qcow2`. The runner then calls host `fsync` on that file and its
session directory before appending `stop.completed` to the Session Journal. Wake creates a new VM
over the same disk and runs `.agents/resume` before continuing.

If the runner restarts while a Session is `Stopping`, it cannot prove that guest sync and VM exit
finished. The Session therefore enters a failed state offering the explicit `restart-environment`
recovery action instead of recording a completed Stop. Recovery reopens the preserved disk; it does
not silently create or substitute a disk.

## Consequences

- Repository and dependency filesystem traffic uses the VM block device rather than per-operation
  FUSE RPC, removing the former `RealFSProvider` performance and path-race boundary.
- `/workspace` and other non-tmpfs root paths persist together. `/root`, `/tmp`, `/var/tmp`,
  `/var/cache`, and `/var/log` remain ephemeral by guest-image policy.
- The checkout is opaque to ordinary host file tools. Git inspection and file operations must run
  inside Gondolin; host-owned Git Snapshots remain separate bounded artifacts.
- RAM and guest processes do not survive Stop. Services that must return need an idempotent
  `.agents/resume` hook.
- The sparse disk consumes host capacity as blocks change and remains until the Session is
  explicitly deleted.
