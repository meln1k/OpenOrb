# OO-015 — One prompt at a time and Abort

**Slice:** 4 — Run a coding conversation  
**Depends on:** OO-014

## Outcome

The session enforces the lean MVP's explicit messaging semantics and lets the user abort an active real run.

## Scope

- Disable normal submission while Pi is running or prompt handoff is in progress.
- Validate the same rule authoritatively on the runner, not only in the browser.
- Add Abort from browser to runner to Pi and propagate the resulting state/completed records.
- Surface pre-handoff failure, post-handoff model failure, and ambiguous process failure without silent replay.
- Ensure the session returns to an explicit idle/failed state before another prompt.

## Acceptance criteria

- A second normal prompt during an active run is rejected and never queued.
- Abort stops the active Pi run and any active Gondolin tool through cancellation propagation.
- Completed/aborted Pi JSONL remains loadable.
- The user may send a new prompt after the aborted run reaches a settled state.
- No `followUp()`, `steer()`, pending-message editor, or exactly-once claim is introduced.

## Tests

- Concurrent prompt rejection at browser/controller and runner boundaries.
- Abort during model streaming and during a guest tool.
- Runner process failure around prompt handoff produces explicit ambiguous state and no automatic replay.

## Not included

Durable queues, follow-up, steering, or editing prior messages.
