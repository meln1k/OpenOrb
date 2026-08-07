# OpenOrb lean MVP tickets

These tickets split `MVP.md` into dependency-ordered vertical slices. The first iteration target is the completion of Slice 6: one real browser-to-GitHub coding session that can stop and cold-continue. Earlier slices are mergeable, demonstrable checkpoints, but they are not substitutes for that full path.

## Execution rules

- Use real Remix, runner transport, Gondolin, Pi, OpenCode Go, and GitHub components in acceptance paths. Test doubles are allowed only in lower-level tests.
- Preserve the security boundaries from the first executable implementation. Never defer the empty Pi resource loader, in-memory settings, Gondolin-backed tools, or host-Git prohibition.
- Do not invent system design, architecture, protocol, persistence, or code interfaces not settled by `MVP.md` or a ticket. Ask the user when a new decision is required.
- Always double-check the APIs/interfaces with the user, even if they're described in the `MVP.md`.
- Add only the packages and abstractions required by the ticket being implemented.
- Every ticket must merge with the repository runnable and tests passing.
- The temporary macOS harness is for local iteration only. Linux remains the release runner target.
- MVP Git support is GitHub HTTPS only. Public repositories require no credential; private operations use a guest placeholder `GH_TOKEN` mediated by Gondolin. SSH and non-GitHub hosts are deferred.
- The initial real model is Pi's `opencode-go/deepseek-v4-flash`, configured through the browser with an OpenCode Go API key.

## Remix control-panel conventions

Unless a ticket explicitly says otherwise:

- Define browser URLs in `apps/control/app/routes.ts` and implement them with Remix controllers/actions under `app/actions/`.
- Use `remix/data-schema` (and `remix/data-schema/form-data` for forms) at browser/request boundaries.
- Use the global Remix session, auth, and CSRF middleware established by OO-002; state-changing browser actions must not hand-roll cookie or CSRF handling.
- Use `remix/data-table` for control-panel PostgreSQL reads/writes and committed migrations. Keep persistence adapters narrow and app-owned only where Remix has no required PostgreSQL adapter.
- Prefer server-rendered Remix UI and normal form POST/redirect flows. Add `clientEntry()`/`remix/ui` browser behavior only when the workflow needs interactivity or streaming.
- Test route behavior with `router.fetch(...)`; use memory session storage only in isolated tests, never as production persistence.

## Slice 0 — Runnable development baseline

| Ticket | Outcome |
|---|---|
| [OO-001](OO-001-runnable-development-baseline.md) | Control app and temporary macOS runner harness start locally |

## Slice 1 — Configure and enroll

| Ticket | Outcome |
|---|---|
| [OO-002](OO-002-admin-setup-and-login.md) | First-run admin setup and authenticated browser shell |
| [OO-003](OO-003-encrypted-opencode-credential.md) | OpenCode Go key configured through the browser |
| [OO-004](OO-004-github-credential-and-project.md) | GitHub credential and project configured through the browser |
| [OO-005](OO-005-runner-enrollment-and-connection.md) | Real outbound runner enrollment and authenticated connection |
| [OO-006](OO-006-runner-status-selection-and-revocation.md) | Runner status, basic capacity, selection, and revocation |

**Slice exit:** A logged-in user can configure the required credentials/project, enroll the local runner harness, and see it online. No session is simulated.

## Slice 2 — Prove the security boundary

| Ticket | Outcome |
|---|---|
| [OO-007](OO-007-audited-pi-session-factory.md) | Pi cannot discover or execute workspace resources on the host |
| [OO-008](OO-008-gondolin-backed-pi-tools.md) | Pi file and shell tools execute only in a real Gondolin VM |
| [OO-009](OO-009-minimal-developer-image.md) | A pinned Gondolin image has the tools needed by the full path |
| [OO-010](OO-010-github-token-mediation.md) | Public/private GitHub operations work without exposing the token |

**Slice exit:** Local hostile fixtures cannot cross the Pi, filesystem, Git, or credential boundaries, and real GitHub access works inside Gondolin.

## Slice 3 — Provision a real repository

| Ticket | Outcome |
|---|---|
| [OO-011](OO-011-runner-session-files-and-inventory.md) | Runner-owned session files and reconnect inventory |
| [OO-012](OO-012-browser-to-gondolin-provisioning.md) | Browser creates a session that clones and sets up a real repository |

**Slice exit:** From the browser, a user provisions a public or private GitHub repository inside Gondolin and sees real setup logs.

## Slice 4 — Run a coding conversation

| Ticket | Outcome |
|---|---|
| [OO-013](OO-013-first-real-pi-run.md) | Initial prompt streams a real Pi run to the browser |
| [OO-014](OO-014-session-replay-and-continuation.md) | Completed history replays and an idle session accepts another prompt |
| [OO-015](OO-015-one-prompt-and-abort.md) | One-prompt-at-a-time behavior and Abort |

**Slice exit:** The user can run and continue a real coding-agent conversation that changes repository files.

## Slice 5 — Review and push

| Ticket | Outcome |
|---|---|
| [OO-016](OO-016-guest-git-report-and-changes-ui.md) | Guest-generated status/diff is reviewable in the browser |
| [OO-017](OO-017-agent-github-commit-and-push.md) | The agent commits and pushes a session branch to GitHub |

**Slice exit:** The user reviews changes and explicitly asks the agent to commit and push without exposing the real token.

## Slice 6 — Cold lifecycle and deletion

| Ticket | Outcome |
|---|---|
| [OO-018](OO-018-stop-idle-and-cold-continuation.md) | VM destruction and continuation preserve workspace and Pi JSONL |
| [OO-019](OO-019-session-deletion.md) | Online/offline deletion removes the catalog card and prevents stale runner resurrection |

**Slice exit — first runnable iteration:** The complete real workflow in `MVP.md` works locally from browser configuration through private GitHub push, VM destruction, cold continuation, and deletion.

## Slice 7 — Failure and UX hardening

| Ticket | Outcome |
|---|---|
| [OO-020](OO-020-offline-and-reconnect.md) | Offline/reconnect behavior and route rebuilding |
| [OO-021](OO-021-visible-failure-recovery.md) | Required failures are visible and manually recoverable |
| [OO-022](OO-022-responsive-session-ui.md) | Required workflow works at desktop and mobile widths |

## Slice 8 — Linux release path

| Ticket | Outcome |
|---|---|
| [OO-023](OO-023-linux-runner-service.md) | Linux x86-64/ARM64 runner doctor and systemd service |
| [OO-024](OO-024-release-e2e-security-and-operations.md) | Release E2E/security coverage and deployment documentation |

**MVP exit:** All acceptance criteria in `MVP.md` pass on the supported Linux release path.
