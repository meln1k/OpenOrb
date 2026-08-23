# OO-015 — Follow-up prompts while running

**Slice:** 4 — Run a coding conversation  
**Depends on:** OO-014

## Outcome

The user can submit additional prompts while Pi is running. OpenOrb hands them to Pi as native follow-ups and clearly communicates that accepted follow-ups remain live, process-local queue items until Pi delivers them.

## Scope

- Keep normal prompt submission available while Pi is running and label the action as a follow-up.
- Route an idle prompt to `session.prompt()` and a prompt received during an active run to `session.followUp()`, with the runner choosing authoritatively from Pi's current state.
- Show Pi-native queue updates for accepted follow-ups while the runner remains connected.
- Preserve the runner-local pre-handoff and ambiguous-handoff behavior established by the messaging path, without silently replaying a follow-up that Pi may have accepted.
- Make the live-only semantics explicit in the UI: after Pi accepts a follow-up, it has no OpenOrb durability, edit, cancel, or promotion guarantee until Pi delivers it as a user message.
- Propagate delivered follow-ups and their resulting assistant/tool records through the existing Pi JSONL projection and session stream.

## Acceptance criteria

- A prompt submitted during an active run is accepted through `session.followUp()` rather than rejected or passed to `session.prompt()`.
- Multiple accepted follow-ups are delivered according to Pi's native follow-up ordering.
- The browser shows accepted follow-ups from Pi's live queue state while connected and removes them as Pi delivers them.
- A delivered follow-up and its completed response are replayable from Pi JSONL after reconnect.
- If the runner process fails after Pi may have accepted a follow-up, OpenOrb surfaces delivery uncertainty and does not replay it automatically.
- No Abort action, steering action, durable post-handoff queue, pending-message editor, queue-item mutation API, or exactly-once claim is introduced.

## Tests

- Browser/controller and runner coverage for submitting a follow-up during model streaming and during a guest tool.
- Runner state-race coverage proving dispatch uses Pi's authoritative current state to choose `prompt()` or `followUp()`.
- Multiple follow-ups preserve Pi-native ordering and live queue updates.
- Delivered follow-ups replay from Pi JSONL after reconnect.
- Runner process failure around follow-up handoff produces explicit delivery uncertainty and no automatic replay.

## Not included

Abort, steering, durable post-handoff queues, editing/cancelling/promoting Pi queue items, or editing prior messages.
