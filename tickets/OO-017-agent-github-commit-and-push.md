# OO-017 — Agent GitHub commit and push

**Slice:** 5 — Review and push  
**Depends on:** OO-010, OO-016

## Outcome

When explicitly asked, the real agent commits workspace changes and pushes the session branch to the configured GitHub repository.

## Scope

- Add trusted OpenOrb prompt guidance to commit/push only on explicit request, use the session branch, and never force-push.
- Make the configured branch and Git author identity available to guest Git operations without exposing the real token.
- Ensure network Git/`gh` operations use the canonical configured GitHub repository rather than an agent-modified remote destination.
- Refresh the guest-generated report after commit/push and expose reported branch/head state from the connected runner.
- Add a real end-to-end acceptance path against a disposable GitHub test repository.

## Acceptance criteria

- An ordinary coding prompt does not cause OpenOrb to request a push.
- An explicit browser prompt results in a commit and new remote session branch.
- Existing agent-created commits are preserved.
- The real token remains outside the guest-visible surfaces covered by OO-010.
- OpenOrb-owned behavior never issues force flags; remote branch protection remains authoritative.
- Push to a changed host/repository is denied even if workspace Git metadata is modified.

## Tests

- Real opt-in GitHub branch push test with cleanup.
- Canonical repository restriction and modified-origin fixture.
- Prompt guidance regression.
- Credential leakage and host-Git prohibition suites remain green.

## Not included

Commit & Push UI, force-push enforcement at raw protocol level, pull requests, SSH, or non-GitHub remotes.
