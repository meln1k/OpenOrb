# OO-023 — Linux runner service

**Slice:** 8 — Linux release path  
**Depends on:** OO-020

## Outcome

The same runner used by the temporary macOS harness installs and runs as a native systemd service on supported Linux x86-64 and ARM64 hosts.

## Scope

- Package the OO-001A standalone `openorb-runner-linux-x64` and `openorb-runner-linux-arm64` executables plus checksums; target glibc 2.27+ Linux only. Runner hosts require neither Node.js nor an installed Deno executable.
- Implement `doctor` checks for architecture/kernel, glibc (with actionable musl rejection), QEMU/KVM, virtualization access, CPU/memory/disk, gateway reachability, verified pinned image availability, and writable data directory.
- Add systemd unit/install instructions under a dedicated service user. Set `WorkingDirectory=/var/lib/openorb-runner`, preserve the no-`--data-dir` rule, and secure runner data/token permissions.
- Apply systemd hardening compatible with KVM/QEMU, including `NoNewPrivileges`, narrowly selected `ProtectSystem`/`ReadWritePaths`, and explicit device access. QEMU children are outside Deno's permission sandbox.
- Configure runner-wide maximum per-VM CPU/memory and maximum concurrent sessions.
- Ensure service reconnect and session inventory behavior matches the tested harness.
- Keep macOS code as an explicitly temporary development harness, not a release artifact.

## Acceptance criteria

- Fresh glibc 2.27+ Linux x86-64 and ARM64 environments receive actionable `doctor` output; musl hosts are rejected.
- A passing host enrolls using only gateway URL and PSK and requires no inbound port/VPN.
- Service restart preserves identity and runner-owned sessions.
- Fixed VM resources and concurrency are reported accurately.
- Installation does not require Node.js, Deno, container orchestration, or a containerized runner.
- The service runs the compiled permission profile without `--allow-all` or FFI and can spawn only the architecture-appropriate QEMU suite through OpenOrb-owned Gondolin VM construction.

## Tests

- Linux x86-64 and ARM64 no-Node/no-Deno artifact startup tests on glibc 2.27+ hosts where CI capacity exists.
- Checksum, architecture, glibc baseline, and `doctor` success/failed-prerequisite tests, including musl rejection.
- systemd restart/reconnect/inventory and QEMU/KVM smoke tests.
- File ownership/mode, working-directory, systemd sandbox, and permitted-subprocess checks.

## Not included

First-class macOS/Windows support, containerized primary install, auto-update, package repositories, or per-session resource scheduling.
