# Release acceptance and traceability

This document is the release gate for the supported Linux MVP. It connects the browser-to-runner
acceptance run, security suites, and every criterion in
[MVP section 22](../MVP.md#22-mvp-acceptance-criteria) to executable evidence. Production deployment
and recovery are covered by the [operations guide](operations.md).

## CI policy

Pull requests and pushes to `main` run `.github/workflows/ci.yml`:

```sh
deno task check
deno task check:docs
deno task test
deno task test:security
deno task build:image x86_64
deno task test:gondolin
```

The x64 Gondolin job requires `/dev/kvm` and runs real VMs without credentials. Tests that need a
private repository or paid model are explicitly reported as skipped when their opt-in variables and
secrets are absent. Regular pull-request CI **does not run** the secret-gated release acceptance and
does not silently claim that it did.

Before a release, manually dispatch `.github/workflows/release-acceptance.yml`. The workflow fails
at preflight and names every missing secret unless all of these repository secrets are configured:

- `OPENORB_GITHUB_TEST_REPOSITORY`: the canonical `https://github.com/owner/repository.git` URL of
  an existing, dedicated private repository;
- `OPENORB_GITHUB_TEST_TOKEN`: a fine-grained token restricted to that repository with **Contents:
  Read and write**;
- `OPENCODE_API_KEY`: an OpenCode Go API key accepted by the pinned Pi model.

The acceptance job never creates or deletes a repository. It creates a unique executable-hook
fixture branch and a unique `openorb/e2e-*` session branch in `OPENORB_GITHUB_TEST_REPOSITORY`, then
deletes both in cleanup. Do not point the variable at a repository containing data whose branch
namespace is not dedicated to this test.

The credential-enabled suite and complete lifecycle are equivalent to:

```sh
export OPENORB_RUN_GONDOLIN_TESTS=1
export OPENORB_RUN_GITHUB_WRITE_TESTS=1
export OPENORB_RUN_PI_MODEL_TESTS=1
export OPENORB_GITHUB_TEST_REPOSITORY=https://github.com/owner/private-test-repository.git
export OPENORB_GITHUB_TEST_TOKEN=<fine-grained-token>
export OPENCODE_API_KEY=<opencode-go-key>

deno task build:image x86_64
deno task test:gondolin
deno task release:acceptance
```

`release:acceptance` additionally requires Linux x64, writable hardware KVM, PostgreSQL client
tools, Chromium installed for Playwright 1.55.0, and a PostgreSQL administrative URL in
`OPENORB_E2E_POSTGRES_URL` (default `postgres://localhost/postgres`). It creates and drops a unique
database. The script starts isolated gateway and runner processes with credential-separated
environments; drives first-run setup, settings, enrollment, session creation, Stop, continuation,
push, and deletion through Chromium; and uses the GitHub API only for fixture setup and assertions.

The runner artifact smoke workflow is manually dispatchable and runs automatically for `v*` tags. It
compiles and executes x64 on `ubuntu-24.04` and ARM64 on the native `ubuntu-24.04-arm` runner. Each
artifact is checked for its ELF machine and glibc baseline, then executed with an empty environment
and an unusable `PATH` to prove that installed Node.js and Deno runtimes are not needed.

## Full lifecycle checks

`scripts/release-acceptance.ts` verifies one connected path rather than a set of mocked halves:

1. validates Linux x64, KVM, PostgreSQL, all three secrets, and a private test repository;
2. creates executable `.agents/setup` and `.agents/resume` hooks on a unique fixture branch;
3. creates an isolated PostgreSQL database and starts a password-protected gateway;
4. configures OpenCode Go, GitHub, Git author, and project values through the browser;
5. starts an outbound-only runner without either external credential in its host environment;
6. provisions a tiny Gondolin VM from the fixture branch and runs a real Pi turn;
7. observes the guest-created file in the cached Changes review surface;
8. manually stops the idle session and requires exactly one retained checkpoint generation;
9. submits a continuation, proving root-disk and workspace persistence, `.agents/resume` execution,
   no `.agents/setup` rerun, and prior Pi transcript continuity;
10. has Pi commit and push the exact session branch, then verifies file contents through GitHub;
11. requires that no host Git process touched the runner workspace and scans ordinary runner files,
    transcript, and process output for the GitHub and model credentials;
12. confirms deletion removes the catalog view and complete runner session directory, including the
    active checkpoint, then removes both remote branches and the temporary database.

## MVP acceptance matrix

The OO-018 lifecycle amendment supersedes criteria 15–16's clean-VM wording: Stop publishes one disk
checkpoint, continuation loads it with matching assets, runs `.agents/resume`, and does not rerun
`.agents/setup`.

|  # | MVP criterion                                                                       | Required evidence                                                                                                                                                                                                                                  |
| -: | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  1 | First-run password setup; protected Remix gateway; browser session survives restart | Browser setup/login in the release lifecycle; `packages/gateway/test/auth.test.ts`, `packages/gateway/test/postgres-session-storage.test.ts`, and the credential restart test in `packages/gateway/test/credentials.test.ts`.                      |
|  2 | NATed runner enrolls with URL and PSK                                               | Release lifecycle enrollment plus `packages/gateway/test/runner-registry.test.ts`.                                                                                                                                                                 |
|  3 | Runner needs no inbound port or VPN                                                 | Release lifecycle starts only the runner's outbound gateway connection; deployment topology is documented in `docs/operations.md`.                                                                                                                 |
|  4 | Configure provider key, GitHub token, and Git author                                | Browser configuration in the release lifecycle and `packages/gateway/test/credentials.test.ts`.                                                                                                                                                    |
|  5 | Create project and start on an available runner                                     | Release lifecycle and the browser provisioning test in `packages/gateway/test/session-provisioning-browser.test.ts`.                                                                                                                               |
|  6 | Clone inside Gondolin and never use host Git on the workspace                       | Release host-process monitor; public/private/hostile Git tests in `packages/runner/test/environment/gondolin/github-mediation.integration.test.ts`.                                                                                                |
|  7 | `.agents/setup` runs inside Gondolin                                                | Executable fixture hook in the release lifecycle; provisioning tests in `packages/runner/test/session/supervisor.test.ts`.                                                                                                                         |
|  8 | Pi uses the explicit empty resource loader and in-memory settings                   | `packages/runner/test/harness/pi/session.test.ts` and `scripts/security-boundaries.test.ts`.                                                                                                                                                       |
|  9 | Pi read/write/edit/bash tools execute through Gondolin                              | `packages/runner/test/harness/pi/tools.test.ts`, real VM tool tests in `packages/runner/test/environment/gondolin/environment.test.ts`, and the security source audit.                                                                             |
| 10 | Text, thinking, tools, results, and status stream to the browser                    | Real Pi release lifecycle plus projection/replay tests in `packages/runner/test/session/events.test.ts` and browser tests.                                                                                                                         |
| 11 | One normal prompt at a time and Abort                                               | Runner state/race tests in `packages/runner/test/session/supervisor.test.ts`, RPC tests, and browser session tests. OO-015's approved live-only Pi follow-up behavior is described in the deferral audit below.                                    |
| 12 | Minimal gateway catalog/deletion marker; replay from runner                         | Schema and tombstone assertions in `packages/gateway/test/session-provisioning-browser.test.ts`, reconciliation tests in `packages/gateway/test/runner-registry.test.ts`, and JSONL replay tests in `packages/runner/test/session/events.test.ts`. |
| 13 | View the latest guest-generated Git diff                                            | Changes assertion in the release lifecycle and `packages/runner/test/session/git-snapshot.test.ts`.                                                                                                                                                |
| 14 | Private clone/commit/push without the real GitHub token                             | Credential-enabled private Git and real Pi tests plus the release branch-content, environment, file, transcript, and log assertions.                                                                                                               |
| 15 | Idle VM stops while workspace and Pi JSONL remain                                   | Amended checkpoint Stop in the release lifecycle; real disk checkpoint and supervisor lifecycle tests.                                                                                                                                             |
| 16 | Continue with the same checkout and conversation                                    | Release `.agents/resume`, marker, pushed-file, and transcript assertions; checkpoint and Pi JSONL replay tests.                                                                                                                                    |
| 17 | Pinned session remains unavailable while its runner is offline                      | Runner disconnect/reconnect tests in `packages/gateway/test/runner-registry.test.ts` and `packages/runner/test/connection/rpc.test.ts`.                                                                                                            |
| 18 | Stop and explicit deletion; offline deletion prevents resurrection                  | Release Stop/deletion directory assertion; browser tombstone test and stale-snapshot cleanup tests in `packages/gateway/test/session-provisioning-browser.test.ts` and `packages/gateway/test/runner-registry.test.ts`.                            |

## Security invariant matrix

Every invariant in [MVP section 20](../MVP.md#20-testing-priorities) is part of
`deno task test:security`, `deno task test:gondolin`, or the manual release lifecycle.

| Security invariant                                                                                                 | Enforced by                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No native host Git consumes a session workspace                                                                    | Linux process monitors in the release lifecycle and `github-mediation.integration.test.ts`; the security source audit forbids runner-host Git spawning.                                                                                                     |
| Hostile Git config, hooks, helpers, filters, textconv, fsmonitor, and external commands cannot execute on the host | Hostile private/public Git mediation tests and the real hostile Git Snapshot test.                                                                                                                                                                          |
| `DefaultResourceLoader` is forbidden in runner session code                                                        | `scripts/security-boundaries.test.ts` scans runner sources and `packages/runner/test/harness/pi/session.test.ts` exercises the audited factory.                                                                                                             |
| Hostile `.pi` resources/settings cannot execute or alter Pi                                                        | Hostile fixture tests in `packages/runner/test/harness/pi/session.test.ts`; in-memory settings and empty resource-loader source assertions.                                                                                                                 |
| All Pi file and shell tools execute through Gondolin                                                               | Tool-adapter source assertions, no-host-filesystem permission tests, real VM cancellation/path tests, and Git Snapshot guest-command tests.                                                                                                                 |
| Real Git and model credentials do not appear in guest files/environment/process arguments/logs/tool output         | Credential-enabled Gondolin tests scan guest surfaces; the real Pi test scans persistence; release acceptance scans transcript, runner files, and gateway/runner output. The model key is delivered only to trusted host-side Pi and never enters Gondolin. |
| `GH_TOKEN` substitution is restricted to `github.com` and `api.github.com`; repository access is provider-enforced | `packages/runner/test/environment/gondolin/github-mediation.test.ts` and private integration tests against the token's selected repository.                                                                                                                 |
| Path traversal and escaping symlinks are rejected                                                                  | Path mapping and real symlink escape tests in `packages/runner/test/environment/gondolin/environment.test.ts`, plus tool tests with host read/write denied.                                                                                                 |

## Failure and recovery matrix

| Failure                               | Automated evidence and release expectation                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner disconnect during provisioning | `disconnect after provisioning dispatch reports uncertain delivery` in `packages/gateway/test/runner-registry.test.ts`; no automatic retry or premature catalog claim.                            |
| Runner disconnect during a prompt     | Runner RPC and session stream disconnect tests; delivery is visibly uncertain and runner-local work remains authoritative.                                                                        |
| Gateway restart during a session      | `transient gateway restart preserves runner work and reconnects from durable state` in `packages/runner/test/connection/rpc.test.ts`; PostgreSQL recovery procedure in `docs/operations.md`.      |
| Setup failure                         | `clone and setup failures remain bounded warnings and still dispatch the stored prompt` in `packages/runner/test/session/supervisor.test.ts`.                                                     |
| Non-fatal clone failure               | The same supervisor test requires a usable Pi session and bounded visible diagnostics.                                                                                                            |
| Model failure                         | State and supervisor tests require a failed prompt to return to an explicitly recoverable ready state; credential resolution failures are covered in `packages/gateway/test/credentials.test.ts`. |
| Runner process crash                  | Supervisor crash/reconstruction and interrupted-provisioning tests recover durable state without replaying in-memory queues.                                                                      |
| VM/checkpoint failure                 | Checkpoint publication/resume failure tests retain the last valid generation or require explicit clean recovery without dispatching the prompt.                                                   |
| Deleted session in a stale manifest   | Tombstoned reconnect and unknown-session tests never republish a route and repeatedly request idempotent cleanup.                                                                                 |

## Deferral audit

The source audit in `scripts/security-boundaries.test.ts`, protocol tests, route inventory, database
schema tests, and the review below keep deferred surfaces out of the release:

- Git repositories remain canonical GitHub HTTPS URLs; generic Git hosts and SSH credentials are
  rejected.
- There is no steering, durable post-handoff queue, queue-item mutation, pending-message editing, or
  automatic command retry. **OO-015 intentionally superseded the older MVP deferral for one narrow
  item:** Pi-native follow-ups are live and process-local while a run is active. They are not a
  durable queue or a steering API.
- Passkeys, shared package caches, browser terminals, private/managed previews, project-secret
  injection, resource reservation/scoring, archives, retention workflows, centrally managed agent
  profiles, HA, migration, and telemetry-platform integration remain absent.
- The standalone Linux runner artifact added for the release path is not a browser terminal or a new
  runner transport; it speaks the existing version-15 WebSocket/RPC protocol.
- **OO-018 intentionally superseded the checkpoint deferral:** one current Gondolin disk checkpoint
  and `.agents/resume` are supported. RAM/process restoration, services, leases, user-managed
  generations, and checkpoint portability remain absent.

Any change to these results requires a scoped ticket, schema/protocol review where applicable, and
an update to this matrix before release.
