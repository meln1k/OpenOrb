# Release acceptance and traceability

This document is the release gate and acceptance contract for the supported Linux release. It
connects the browser-to-runner acceptance run, security suites, and each release criterion to
executable evidence. Production deployment and recovery are covered by the
[operations guide](operations.md), which distinguishes the supported local celld runtime from the
still-undecided production fleet and data-transfer procedure.

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

The x64 Gondolin job requires `/dev/kvm` and runs real VMs without credentials. When nested KVM is
available, its guest smoke test also verifies that the nested device responds to the KVM API. Tests
that need a private repository or paid model are explicitly reported as skipped when their opt-in
variables and secrets are absent. Regular pull-request CI **does not run** the secret-gated release
acceptance and does not silently claim that it did.

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
export OPENORB_RUN_DURABLE_MODEL_TESTS=1
export OPENORB_GITHUB_TEST_REPOSITORY=https://github.com/owner/private-test-repository.git
export OPENORB_GITHUB_TEST_TOKEN=<fine-grained-token>
export OPENCODE_API_KEY=<opencode-go-key>

deno task build:image x86_64
deno task test:gondolin
deno task release:acceptance
```

`release:acceptance` additionally requires Linux x64, writable hardware KVM, the pinned celld 0.6.2
and esbuild 0.28.2 tools installed by `bash scripts/install-celld.sh`, and Chromium installed for
Playwright 1.55.0. No PostgreSQL server/client or database URL is required. The script builds the
production gateway task, copies `packages/gateway/wrangler.jsonc`, `dist/worker.js`, and
`dist/assets` into a private temporary gateway directory, and runs a real `celld dev --no-watch`
process there so runtime cache writes cannot trigger rebuilds. Its mode-0600 `.dev.vars` has
independently random `SESSION_SECRET`/`OPENORB_MASTER_KEY`, the acceptance origin, and local HTTP
cookie policy. celld's `.celld/dev` state stays beside that copied config; production `.dev.vars`,
`.celld`, and the old PostgreSQL data are never modified or cleaned. The build does update
replaceable gateway `dist` output.

The gateway and runner start with credential-separated environments; first-run setup, settings,
enrollment, session creation, Stop, continuation, push, and deletion are driven through Chromium.
The GitHub API is used only for fixture setup, assertions, and branch cleanup. Cleanup closes the
browser, stops runner/celld processes, checks logs for leaks, removes both branches, and deletes
only the acceptance temporary directory. Do not run this command as a read-only smoke check: it
performs external writes and paid model calls. CI installs the same pinned runtime; the release
workflow remains manual and secret-gated.

The runner artifact smoke workflow is manually dispatchable and runs automatically for `v*` tags. It
compiles and executes x64 on `ubuntu-24.04` and ARM64 on the native `ubuntu-24.04-arm` runner. Each
artifact is checked for its ELF machine and glibc baseline, then executed with an empty environment
and an unusable `PATH` to prove that installed Node.js and Deno runtimes are not needed.

## Full lifecycle checks

`scripts/release-acceptance.ts` verifies one connected path rather than a set of mocked halves:

1. validates Linux x64, KVM, celld/esbuild, all three secrets, and a private test repository;
2. creates executable `.agents/setup` and `.agents/resume` hooks on a unique fixture branch;
3. starts the production Worker and native Workspace/Runners DOs with isolated config, assets,
   secrets, and SQLite state, then completes password setup;
4. configures OpenCode Go, GitHub, Git author, and project values through the browser;
5. starts an outbound-only runner without either external credential in its host environment;
6. provisions a tiny Gondolin VM from the fixture branch and runs a real Pi turn;
7. observes the guest-created file in the cached Changes review surface;
8. manually stops the idle session and requires the stable `root-disk.qcow2` to remain;
9. submits a continuation, proving that wake opens the same root disk, runs `.agents/resume` without
   rerunning `.agents/setup`, and preserves the Project Checkout and prior Pi transcript;
10. has Pi commit and push the exact session branch, then verifies file contents through GitHub;
11. requires that no host Git process touched the runner workspace and checks the transcript and
    process output for the GitHub and model credentials;
12. confirms deletion removes the catalog view and complete runner session directory, including the
    persistent root disk, then stops processes, removes both remote branches, and removes the
    temporary gateway/runner directory.

## Release acceptance matrix

|  # | Release criterion                                                                                  | Required evidence                                                                                                                                                                                                                                     |
| -: | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  1 | First-run password setup; protected Remix gateway; browser session survives restart                | Browser setup/login in the release lifecycle; `packages/gateway/test/auth.test.ts`, Workspace reactivation/session tests in `packages/gateway/test/workspace/workspace.test.ts`, and credential tests in `packages/gateway/test/credentials.test.ts`. |
|  2 | NATed runner enrolls with URL and PSK                                                              | Release lifecycle enrollment plus `packages/gateway/test/runner-registry.test.ts`.                                                                                                                                                                    |
|  3 | Runner needs no inbound port or VPN                                                                | Release lifecycle starts only the runner's outbound gateway connection; deployment topology is documented in `docs/operations.md`.                                                                                                                    |
|  4 | Configure provider key, GitHub token, and Git author                                               | Browser configuration in the release lifecycle and `packages/gateway/test/credentials.test.ts`.                                                                                                                                                       |
|  5 | Create project and start on an available runner                                                    | Release lifecycle and the browser provisioning test in `packages/gateway/test/session-provisioning-browser.test.ts`.                                                                                                                                  |
|  6 | Clone inside Gondolin and never use host Git on the workspace                                      | Release host-process monitor; public/private/hostile Git tests in `packages/runner/test/environment/gondolin/github-mediation.integration.test.ts`.                                                                                                   |
|  7 | `.agents/setup` runs inside Gondolin                                                               | Executable fixture hook in the release lifecycle; provisioning tests in `packages/runner/test/session/supervisor.test.ts`.                                                                                                                            |
|  8 | Durable uses an explicit registry, in-memory credentials, and guest-independent prompt preparation | `packages/runner/test/harness/durable/layer.test.ts` and `scripts/security-boundaries.test.ts`.                                                                                                                                                       |
|  9 | Pi read/write/edit/bash tools execute through Gondolin                                             | `packages/runner/test/harness/durable/tools.test.ts`, real VM tool tests in `packages/runner/test/environment/gondolin/environment.test.ts`, and the security source audit.                                                                           |
| 10 | Text, thinking, tools, results, and status stream to the browser                                   | Real Pi release lifecycle plus projection/replay tests in `packages/runner/test/session/events.test.ts` and browser tests.                                                                                                                            |
| 11 | Durable input admission, follow-ups, recovery and Abort                                            | Harness recovery tests, runner actor tests, RPC tests, and browser session tests.                                                                                                                                                                     |
| 12 | Minimal gateway catalog/deletion marker; authoritative snapshots from runner                       | Schema and tombstone assertions, registry reconciliation, and snapshot/reconnect/overflow tests in `packages/runner/test/session/events.test.ts`.                                                                                                     |
| 13 | View the latest guest-generated Git diff                                                           | Changes assertion in the release lifecycle and `packages/runner/test/session/git-snapshot.test.ts`.                                                                                                                                                   |
| 14 | Private clone/commit/push without the real GitHub token                                            | Credential-enabled private Git and real Pi tests plus the release branch-content, environment, file, transcript, and log assertions.                                                                                                                  |
| 15 | Stop Session pauses Durable and retains the stable disk and checkout                               | Stop in the release lifecycle; actor Stop/Abort tests and persistent-root-disk durability tests.                                                                                                                                                      |
| 16 | Wake resumes checkpointed work while booting the same root disk                                    | Release resume-hook and transcript assertions; harness reopen and concurrent actor startup tests.                                                                                                                                                     |
| 17 | Pinned session remains unavailable while its runner is offline                                     | Runner disconnect/reconnect tests in `packages/gateway/test/runner-registry.test.ts` and `packages/runner/test/connection/rpc.test.ts`.                                                                                                               |
| 18 | Stop and explicit deletion; offline deletion prevents resurrection                                 | Release Stop/deletion directory assertion; browser tombstone test and stale-snapshot cleanup tests in `packages/gateway/test/session-provisioning-browser.test.ts` and `packages/gateway/test/runner-registry.test.ts`.                               |
| 19 | Workspace generic secrets appear as mediated placeholders in newly started Agent Environments      | Release Settings-to-Gondolin probe on initial and resumed VMs; gateway lifecycle, runner propagation, mediation, and real-VM placeholder tests.                                                                                                       |

## Security invariant matrix

Every invariant below is part of `deno task test:security`, `deno task test:gondolin`, or the manual
release lifecycle.

| Security invariant                                                                                                 | Enforced by                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No native host Git consumes a session workspace                                                                    | Linux process monitors in the release lifecycle and `github-mediation.integration.test.ts`; the security source audit forbids runner-host Git spawning.                                                                                                       |
| Hostile Git config, hooks, helpers, filters, textconv, fsmonitor, and external commands cannot execute on the host | Hostile private/public Git mediation tests and the real hostile Git Snapshot test.                                                                                                                                                                            |
| `DefaultResourceLoader` is forbidden in runner session code                                                        | `scripts/security-boundaries.test.ts` scans runner sources; the coding-agent dependency has been removed.                                                                                                                                                     |
| Hostile `.pi` resources/settings cannot execute or alter Pi                                                        | Durable's explicit registry has no host resource discovery; `skills.test.ts` exercises bounded, passive guest-only metadata loading, readiness, cancellation, and refresh. Harness tests exercise in-memory credential isolation and guest-only capabilities. |
| All Pi file and shell tools execute through Gondolin                                                               | Tool-adapter source assertions, no-host-filesystem permission tests, real VM cancellation/path tests, and Git Snapshot guest-command tests.                                                                                                                   |
| Git credentials remain mediated; model credentials are not supplied to the guest                                   | Credential-enabled Gondolin tests exercise GitHub request mediation; release acceptance checks for accidental credential exposure. The model key is delivered only to trusted host-side Pi. Conversation content has no credential-redaction filter.          |
| `GH_TOKEN` substitution is restricted to `github.com` and `api.github.com`; repository access is provider-enforced | `packages/runner/test/environment/gondolin/github-mediation.test.ts` and private integration tests against the token's selected repository.                                                                                                                   |
| Generic secret values stay host-side and substitution obeys each optional host policy                              | Gateway ciphertext/browser assertions, runner journal assertions, and scoped/unrestricted cases in `packages/runner/test/environment/gondolin/github-mediation.test.ts`. Omitting hosts intentionally allows every public HTTP(S) host.                       |
| Agent paths, including traversal and symlinks, remain in the guest namespace and cannot access runner-host files   | Guest path mapping and real host-shaped path/symlink tests in `packages/runner/test/environment/gondolin/environment.test.ts`, plus tool tests with host read/write denied.                                                                                   |

## Failure and recovery matrix

| Failure                               | Automated evidence and release expectation                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner disconnect during provisioning | `disconnect after provisioning dispatch reports uncertain delivery` in `packages/gateway/test/runner-registry.test.ts`; no automatic retry or premature catalog claim.                                   |
| Runner disconnect during a prompt     | Runner RPC and session stream disconnect tests; delivery is visibly uncertain and runner-local work remains authoritative.                                                                               |
| Gateway restart during a session      | `transient gateway restart preserves runner work and reconnects from durable state` in `packages/runner/test/connection/rpc.test.ts`; local celld state/key recovery boundaries in `docs/operations.md`. |
| Setup failure                         | `clone and setup failures remain bounded warnings and still dispatch the stored prompt` in `packages/runner/test/session/supervisor.test.ts`.                                                            |
| Non-fatal clone failure               | The same supervisor test requires a usable Pi session and bounded visible diagnostics.                                                                                                                   |
| Model failure                         | State and supervisor tests require a failed prompt to return to an explicitly recoverable ready state; credential resolution failures are covered in `packages/gateway/test/credentials.test.ts`.        |
| Runner process crash                  | Supervisor crash/reconstruction and interrupted-provisioning tests recover durable state without replaying in-memory queues.                                                                             |
| Interrupted Stop or disk sync failure | Reconciliation marks the Session failed with explicit `restart-environment` recovery because guest sync and VM exit cannot be confirmed; no prompt is dispatched.                                        |
| Deleted session in a stale manifest   | Tombstoned reconnect and unknown-session tests never republish a route and repeatedly request idempotent cleanup.                                                                                        |

## Scope audit

The source audit in `scripts/security-boundaries.test.ts`, protocol tests, route inventory,
Workspace persistence tests, and the review below keep deferred surfaces out of the release:

- Git repositories remain canonical GitHub HTTPS URLs; generic Git hosts and SSH credentials are
  rejected.
- Durable owns admitted inputs and queued follow-ups. There is no steering UI, queue-item mutation,
  pending-message editing, or automatic command-handoff retry. Wake recovers checkpointed work;
  unsafe interrupted tools are not automatically rerun.
- Passkeys, shared package caches, browser terminals, private/managed previews, project-scoped
  secret assignment, resource reservation/scoring, archives, retention workflows, centrally managed
  agent profiles, HA, migration, and telemetry-platform integration remain absent.
- The standalone Linux runner artifact added for the release path is not a browser terminal or a new
  runner transport; it speaks the version-25 WebSocket/RPC protocol.
- One persistent `root-disk.qcow2` per Session and `.agents/resume` are supported. RAM/process or
  tmpfs restoration, services, leases, disk history, and Session portability remain absent.

Any change to these results requires a scoped design, schema/protocol review where applicable, and
an update to this matrix before release.
