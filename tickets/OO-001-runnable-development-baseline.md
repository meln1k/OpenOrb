# OO-001 — Runnable development baseline

**Slice:** 0 — Runnable development baseline  
**Depends on:** None

## Outcome

A contributor can install dependencies and start the real Remix control application plus a temporary macOS runner harness from this repository.

## Scope

- Create the minimal pnpm/TypeScript workspace required for `packages/control`, `packages/runner`, and shared runtime-validated wire types.
- Scaffold Remix 3 with `npx remix@next new`, then lock the generated Remix dependencies to their exact resolved versions. Record the resolved Remix version used.
- Add only formatting, type-check, test, and development commands needed by current code.
- Provide a control-page shell and process health output.
- Provide a temporary macOS runner entry point using the same runner code intended for Linux, without claiming macOS support.
- Document Node and pnpm as repository tooling and QEMU as the runner's only external executable prerequisite. Install Gondolin as a pinned runner package dependency; `gh` belongs in the guest image introduced by OO-009, not on the runner host.

## Acceptance criteria

- A clean checkout has documented install and start commands.
- The control page opens in a browser on the current Mac.
- The runner harness starts and reports actionable prerequisite errors; it does not yet fake enrollment or a session.
- Remix is not left on a floating branch/tag after installation.
- Type-check and tests pass from the workspace root.
- No speculative domain or service packages are introduced.

## Tests

- Workspace type-check/test command.
- Control health/request smoke test.
- Runner harness startup/prerequisite test that does not require a VM.

## Not included

Authentication, persistence, runner connection, sessions, or fake end-to-end behavior.
