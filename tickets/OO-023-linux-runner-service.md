# OO-023 — Linux runner service

**Slice:** 8 — Linux release path  
**Depends on:** OO-020

## Outcome

The same runner used by the temporary macOS harness installs and runs as a native systemd service on supported Linux x86-64 and ARM64 hosts.

## Scope

- Add the supported Linux runner CLI/service packaging path.
- Implement `doctor` checks for architecture/kernel, Node, QEMU/KVM, virtualization access, CPU/memory/disk, control-panel reachability, image availability, and writable data directory.
- Add systemd unit/install instructions and secure runner data/token permissions.
- Configure runner-wide VM CPU/memory and maximum concurrent sessions.
- Ensure service reconnect and session inventory behavior matches the tested harness.
- Keep macOS code as an explicitly temporary development harness, not a release artifact.

## Acceptance criteria

- Fresh supported Linux x86-64 and ARM64 environments receive actionable `doctor` output.
- A passing host enrolls using only control URL and PSK and requires no inbound port/VPN.
- Service restart preserves identity and runner-owned sessions.
- Fixed VM resources and concurrency are reported accurately.
- Installation does not require container orchestration or a containerized runner.

## Tests

- Linux x86-64 and ARM64 packaging/startup tests where CI capacity exists.
- `doctor` success and each major failed prerequisite.
- systemd restart/reconnect/inventory smoke test.
- File ownership/mode checks.

## Not included

First-class macOS/Windows support, containerized primary install, auto-update, package repositories, or per-session resource scheduling.
