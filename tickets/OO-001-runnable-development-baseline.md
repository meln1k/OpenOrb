# OO-001 — Runnable development baseline

**Slice:** 0 — Runnable development baseline  
**Depends on:** None  
**Status:** Completed, then migrated in place by [OO-001A](OO-001A-deno-migration.md)

## Outcome

A contributor can resolve dependencies and start the real Remix control application plus a temporary macOS runner harness from this repository using the Deno-only baseline established by OO-001A.

## Final baseline after OO-001A

- The original Node.js/pnpm workspace was intentionally replaced rather than retained in parallel.
- Deno 2.9.5 is the exact development runtime, workspace manager, checker, formatter, linter, test runner, and runner compiler.
- `packages/control`, `packages/runner`, and `packages/protocol` use Deno-native manifests and exact dependency imports.
- Remix remains pinned to `3.0.0-beta.5`.
- The control application runs with `Deno.serve()` and keeps `/healthz` plus the browser shell at `http://localhost:44100`.
- The temporary macOS harness uses the same runner entry point intended for Linux and reports actionable QEMU errors without starting a VM.
- QEMU is the runner's external executable prerequisite. Linux releases are standalone GNU-target executables and require neither Node.js nor an installed Deno executable.
- `gh` belongs in the guest image introduced by OO-009, not on the runner host.

## Acceptance criteria

- A clean checkout has documented Deno install and start commands.
- The control page opens in a browser on the current Mac.
- The runner harness starts and reports actionable prerequisite errors; it does not fake enrollment or a session.
- Remix and Deno are pinned exactly.
- Deno format, lint, type-check, and tests pass from the workspace root.
- No speculative domain or service packages are introduced.

## Tests

- Deno workspace format/lint/type-check/test commands.
- Deno-native control health/request smoke test.
- Runner harness startup/prerequisite test that does not require a VM.

## Not included

Authentication beyond the already completed OO-002 baseline, runner connection, sessions, or fake end-to-end behavior.
