# OO-008 — Gondolin-backed Pi tools

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-007

## Outcome

Pi's `read`, `write`, `edit`, and `bash` operations execute in a real Gondolin VM against `/workspace`, never against unrestricted host facilities.

## Scope

- Mount a host-owned session workspace into Gondolin with `RealFSProvider` at `/workspace`.
- Implement the four Pi tool operation adapters using current Pi and Gondolin APIs.
- Map paths to `/workspace`, reject path escape, preserve abort/timeouts, and stream bash output.
- Ensure tool subprocesses run in the guest and VM lifecycle cleanup is reliable.
- Add process/file markers that distinguish guest execution from host execution.

## Acceptance criteria

- A real Pi tool invocation can read, write, edit, and run a command in the mounted workspace.
- Relative/absolute traversal and escaping symlinks cannot access runner-host files outside the mounted workspace.
- Bash commands cannot execute on the runner host.
- Abort and timeout stop guest work and leave the runner usable.
- No default Pi filesystem or shell tool remains enabled alongside the replacements.

## Tests

- Real Gondolin/QEMU smoke test on the current Mac.
- Read/write/edit behavior and errors.
- Traversal/symlink escape fixtures.
- Guest-vs-host process marker assertion.
- Streaming output, abort, and timeout.

## Not included

Git credentials, cloning, model calls, checkpoints, terminal, or previews.
