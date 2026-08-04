# OO-018 — Stop, idle destruction, and cold continuation

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-014, OO-016

## Outcome

A session VM can be explicitly stopped or destroyed after 15 minutes idle, then recreated cold with the same workspace and Pi conversation.

## Scope

- Start the 15-minute timer only after Pi settles; relevant prompt/setup work prevents idle destruction.
- Before destruction, create a final controlled Git report and flush workspace writes.
- Destroy the VM without checkpointing while retaining workspace, Pi JSONL, metadata, events, reports, and logs.
- Add the browser Stop action.
- On the next idle prompt, create a clean VM, remount the existing workspace, restore mediation, rerun `.agents/setup`, reopen Pi JSONL, and then dispatch.
- Make `.agents/setup` idempotence requirement visible in project/session UI or documentation.

## Acceptance criteria

- Stop closes the real VM and does not delete session files.
- Test-configured short timeout exercises the same path as the production 15-minute timeout.
- Guest root/process changes disappear; workspace changes persist.
- `.agents/setup` runs again before continuation and failure blocks the prompt visibly.
- The continued model response has prior conversation context and current workspace state.
- No checkpoint, lease system, `.agents/resume`, or process restoration is introduced.

## Tests

- Manual stop and shortened idle timeout.
- Root-vs-workspace persistence fixture.
- Setup rerun success/failure.
- Pi JSONL continuation after process/VM recreation.

## Not included

Gondolin checkpoints, service restoration, terminal leases, previews, or archive semantics.
