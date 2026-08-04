# OO-018 — Stop, idle destruction, and cold continuation

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-014, OO-016

## Outcome

A session VM can be explicitly stopped or destroyed after 15 minutes idle, then recreated cold with the same workspace and Pi conversation.

## Scope

- Record the latest accepted user-message time. Allow idle destruction only after at least 15 minutes have passed since that message and no agent, provisioning, setup, or report work is active.
- Before destruction, create a final controlled Git report and flush workspace writes.
- Destroy the VM without checkpointing while retaining workspace, Pi JSONL, metadata, events, reports, and logs.
- Add the browser Stop action. Reject Stop while Pi or another provisioning/setup/report operation is active; the user must wait or Abort the active run first.
- On the next idle prompt, create a clean VM, remount the existing workspace, restore mediation, rerun `.agents/setup`, reopen Pi JSONL, and then dispatch.
- Make `.agents/setup` idempotence requirement visible in project/session UI or documentation.

## Acceptance criteria

- Stop closes the real VM and does not delete session files.
- Stop is unavailable during active work and succeeds once the session is idle.
- Test-configured short timeout exercises the same eligibility rule as the production 15-minute timeout.
- Guest root/process changes disappear; workspace changes persist.
- `.agents/setup` runs again before continuation and failure blocks the prompt visibly.
- The continued model response has prior conversation context and current workspace state.
- No checkpoint, lease system, `.agents/resume`, or process restoration is introduced.

## Tests

- Manual stop rejection during active work, successful idle stop, and shortened idle timeout.
- Root-vs-workspace persistence fixture.
- Setup rerun success/failure.
- Pi JSONL continuation after process/VM recreation.

## Not included

Gondolin checkpoints, service restoration, terminal leases, previews, or archive semantics.
