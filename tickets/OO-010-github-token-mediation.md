# OO-010 — GitHub token mediation

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-004, OO-008, OO-009

## Outcome

Git/`gh` inside Gondolin can access an authorized GitHub repository while seeing only a placeholder `GH_TOKEN`.

## Scope

- Give the guest a per-VM placeholder `GH_TOKEN`, never the real value.
- Use Gondolin HTTP hooks to mediate only the GitHub endpoints and canonical repository paths actually required by observed `gh`/Git behavior.
- Support unauthenticated public clone and mediated private clone/fetch/push over HTTPS.
- Fail closed for other hosts, repositories, redirect targets, and unsupported protocols.
- Ensure every Git process that consumes the workspace runs inside Gondolin.
- Add a host process monitor/regression harness for the host-Git prohibition.

## Acceptance criteria

- Real public and private GitHub repositories clone from inside Gondolin.
- A controlled push to the configured test repository succeeds from inside Gondolin.
- Printing environment/config/process data from the guest reveals only the placeholder.
- The real token is absent from guest files, process arguments/environment, output, logs, errors, and workspace bytes.
- The placeholder does not authorize a different repository or non-GitHub host.
- No native host Git process consumes or runs with the session workspace.

## Tests

- Automated public clone test.
- Secret-enabled private clone/push test that skips clearly when credentials are unavailable.
- Token leakage scan across guest-visible surfaces and logs.
- Wrong repository/host/redirect rejection.
- Host Git process-monitor regression test using hostile `.git` configuration.

## Not included

SSH, non-GitHub hosts, force push, GitHub Apps, pull requests, or browser session creation.
