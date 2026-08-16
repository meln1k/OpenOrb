# Security notes

## Deferred Gondolin `RealFSProvider` path race

**Status:** Known, unresolved risk while OpenOrb uses Gondolin's host-backed VFS adapter.

Gondolin 0.12.0's `RealFSProvider` checks that a path resolves beneath its root and then
performs the corresponding asynchronous host filesystem operation. Gondolin dispatches VFS
requests concurrently, so untrusted guest code may be able to replace a checked workspace path
or parent directory with an escaping symlink between validation and use. Static traversal and
symlink checks do not cover this TOCTOU interleaving. We have confirmed the vulnerable code
shape, but have not demonstrated a successful end-to-end escape from a real Gondolin guest.

OpenOrb intentionally does not serialize every provider operation as a workaround. Global
serialization could materially degrade filesystem-heavy guest workloads such as dependency
installation and repository tooling. Consequently, the current `RealFSProvider` mount must not
be treated as a proven containment boundary against concurrent rename/symlink attacks.

Before relying on Gondolin's VFS adapter as that boundary:

1. Re-evaluate whether OpenOrb still needs a writable host-backed workspace mount.
2. Reproduce and measure the race on supported runner platforms and benchmark any mitigation.
3. Prefer an upstream Gondolin fix that performs descriptor-relative, beneath-root operations
   atomically, or otherwise enforces the invariant inside `RealFSProvider`.
4. Add concurrent rename/symlink escape tests for reads, writes, creates, and parent-directory
   mutations.

If OpenOrb stops using the host-backed VFS adapter for untrusted workspaces, this specific risk
does not apply.
