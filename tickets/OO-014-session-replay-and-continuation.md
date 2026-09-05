# OO-014 — Session replay and continuation

**Slice:** 4 — Run a coding conversation  
**Depends on:** OO-013

## Outcome

A reconnecting browser reloads completed history from its connected runner, and an idle session accepts a subsequent prompt using the same Pi JSONL.

## Scope

- Project and replay completed conversation events from the active branch of Pi JSONL after a derived runner-owned cursor through the unpersisted gateway proxy.
- Support `Last-Event-ID`/the MVP cursor request behavior without duplicating completed UI records.
- Reopen the exact runner-owned Pi session JSONL for continuation.
- Accept a subsequent prompt only when runner, VM, and Pi are ready and idle.
- Store the completed continuation only in Pi JSONL.
- Show unavailable history rather than a gateway copy when the runner is disconnected.

## Acceptance criteria

- Browser reload reconstructs completed user/assistant/tool history from the runner.
- Reconnect after a cursor does not duplicate completed records.
- A second prompt continues with prior Pi context and current workspace.
- Gateway restart does not create or import a session mirror.
- An unavailable runner makes history/continuation unavailable while the Workspace-owned five-column catalog row continues to provide the four display fields.

## Tests

- Pi-derived cursor replay from the beginning and from the middle.
- Browser/SSE reconnect deduplication.
- Pi JSONL reopen and context continuation.
- Gateway persistence/schema assertion after replay.

## Not included

Offline prompt queueing, exactly-once delivery, follow-up, steering, or cold VM recreation.
