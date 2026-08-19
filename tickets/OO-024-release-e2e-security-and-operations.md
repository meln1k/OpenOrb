# OO-024 — Release E2E, security, and operations

**Slice:** 8 — Linux release path  
**Depends on:** OO-022, OO-023

## Outcome

The lean MVP has one repeatable supported-Linux acceptance run, enforced security regressions, and enough operations documentation for another user to deploy it.

## Scope

- Automate the complete `MVP.md` end-to-end path with real Gondolin, Pi, OpenCode Go, and a disposable GitHub repository; secret-required jobs must fail/skip transparently according to documented CI policy.
- Run the full hostile workspace/Git/token security suite, verify no host Git consumes a session workspace, and verify a deleted-session marker prevents stale runner snapshots from resurrecting a session.
- Add deployment, HTTPS, PostgreSQL backup/restore, external `OPENORB_MASTER_KEY` and session-cookie signing-secret backup/restore, runner session-file backup limitations, runner installation, GitHub token scope, OpenCode Go key, and troubleshooting documentation. The gateway must require no persistent local volume and no Redis/secondary persistence service.
- Document pinned gateway/runner/protocol/Gondolin/image/Pi/Remix versions and intentional upgrade process.
- Verify all explicit MVP deferrals remain absent.

## Acceptance criteria

- A new user can follow documentation to deploy the password-protected gateway and enroll a NATed Linux runner.
- The acceptance run configures browser credentials/project, provisions a private GitHub repository, streams a real code change, reviews it, pushes a branch, stops, cold-continues, and deletes.
- Security tests cover every invariant in `MVP.md` section 20.
- Backup documentation states that the gateway PostgreSQL database, externally managed `OPENORB_MASTER_KEY`, and session-cookie signing secret are required to preserve encrypted secrets and valid browser sessions; the gateway owns no durable local files, and runner session-file backup limitations are explicit.
- All 18 acceptance criteria in `MVP.md` are linked to passing tests or a documented manual release check.

## Tests

- Full supported-Linux E2E acceptance suite.
- x86-64/ARM64 smoke coverage available to the project.
- Security regression suite.
- Documentation command/link validation where practical.

## Not included

Any post-MVP item, public API stability, HA, migration, telemetry platform, terminal, previews, or passkeys.
