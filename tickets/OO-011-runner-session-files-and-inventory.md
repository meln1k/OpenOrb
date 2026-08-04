# OO-011 — Runner session files and inventory

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-005

## Outcome

The runner owns durable session data in the agreed file formats and advertises enough inventory to rebuild live routing after reconnect.

## Scope

- Create per-session storage with atomic `metadata.json`, Pi-owned `pi/session.jsonl`, append-only `events.jsonl`, `logs/`, `reports/`, and `workspace/`.
- Define only metadata and event fields required by current tickets and `MVP.md`.
- Add monotonic per-session event cursors and crash-safe append behavior.
- Advertise runner-owned session inventory over the connected runner socket.
- Build the control panel's session-to-runner route index only in memory.
- Treat all workspace bytes, including `.git`, as untrusted.

## Acceptance criteria

- Restarting the runner reloads valid sessions and advertises them.
- A partial/corrupt final append is detected and handled visibly without silently inventing state.
- The control-panel route index is rebuilt from inventory and is not persisted.
- No runner SQLite database is added.
- The control panel has no session transcript, event, state, route, branch, model, runner assignment, diff, or log persistence.

## Tests

- Atomic metadata update and interrupted-write behavior.
- Event cursor append/reload.
- Inventory after runner restart.
- Control SQLite schema assertion limiting `sessions` to the four catalog fields once that table exists.

## Not included

Session provisioning, model calls, event compaction, archives, or queued messages.
