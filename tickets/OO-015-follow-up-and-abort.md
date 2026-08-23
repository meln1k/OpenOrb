# OO-015 — Native follow-ups and Abort while running

**Slice:** 4 — Run a coding conversation
**Depends on:** OO-014

## Outcome

The user can queue native Pi follow-ups or abort the active Pi run. Follow-ups remain visibly live and process-local until Pi delivers them; Abort clears that queue before stopping the run.

## Scope

- Keep normal prompt submission available while Pi is running and label the action as a follow-up.
- Route an idle prompt to `session.prompt()` and a prompt received during an active run to `session.followUp()`, with the runner choosing authoritatively from Pi's current state.
- Show Pi-native queue updates for accepted follow-ups while the runner remains connected.
- Preserve submission order while prompt and Abort commands race at the runner.
- Surface an acknowledgement timeout or disconnect as uncertain delivery and never retry a prompt automatically.
- Propagate delivered follow-ups and their resulting assistant/tool records through the existing Pi JSONL projection and session stream.
- Add an authenticated, CSRF-protected browser Abort action and runner protocol messages for Abort command, acceptance, and rejection.
- Bind Abort to the exact active run observed by the gateway so a stale command cannot stop a newer run.
- On Abort, reject new prompts, clear all Pi-native queued follow-ups, then call `session.abort()` and return the session to ready after Pi settles.
- Treat a user-requested Pi `aborted` stop reason as controlled completion rather than a session failure.
- Keep Abort live-only and non-retriable. An acknowledgement timeout or disconnect reports that the run may still be stopping.

## Acceptance criteria

- A prompt submitted during an active run is accepted through `session.followUp()` rather than rejected or passed to `session.prompt()`.
- Multiple accepted follow-ups are delivered according to Pi's native follow-up ordering.
- The browser shows accepted follow-ups from Pi's live queue state while connected and removes them as Pi delivers them.
- A delivered follow-up and its completed response are replayable from Pi JSONL after reconnect.
- If the runner process fails after Pi may have accepted a follow-up, OpenOrb surfaces delivery uncertainty and does not replay it automatically.
- Abort is available only for the exact active Pi run and is rejected once that run is idle or has been replaced.
- Abort clears every queued follow-up before interrupting the current model/tool operation, so queued work cannot continue afterward.
- Once Abort starts, further prompt and Abort submissions are rejected until the run settles.
- An aborted initial or continuation run returns to ready rather than entering the failed state.
- No steering action, durable post-handoff queue, pending-message editor, queue-item mutation API, or exactly-once claim is introduced.

## Tests

- Browser/controller and runner coverage for submitting a follow-up during model streaming and during a guest tool.
- Runner state-race coverage proving dispatch uses Pi's authoritative current state to choose `prompt()` or `followUp()`.
- Multiple follow-ups preserve Pi-native ordering and live queue updates.
- Delivered follow-ups replay from Pi JSONL after reconnect.
- Runner process failure around follow-up handoff produces explicit delivery uncertainty and no automatic replay.
- Browser/controller and runner coverage for Abort during an active run, queue clearing before interruption, and prompt rejection while Abort settles.
- Protocol/gateway coverage for Abort acceptance, rejection, timeout/disconnect uncertainty, and active-run identity.
- Race coverage proving a stale Abort cannot affect a settled or newer run.

## Not included

Steering, durable post-handoff queues, editing/cancelling/promoting individual Pi queue items, editing prior messages, and automatic command retry.
