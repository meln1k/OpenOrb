# OO-011 — Runner session files and inventory

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-005

## Outcome

The runner owns durable session data in the agreed file formats and advertises enough inventory to rebuild live routing after reconnect.

## Scope

- Create per-session storage with atomic `metadata.json`, Pi-owned `pi/session.jsonl`, append-only `events.jsonl`, `logs/`, `reports/`, and `workspace/`.
- Define only metadata and event fields required by current tickets and `MVP.md`.
- Add monotonic per-session event cursors and crash-safe append behavior.
- Send a complete runner-owned session snapshot on connect/reconnect. Each entry includes the four catalog fields plus the live routing/state data required by current tickets.
- Runtime-validate the snapshot, upsert missing non-tombstoned four-field catalog rows, and build the control panel's session-to-runner route index only in memory. Snapshot absence alone does not delete catalog rows because session ownership is not persisted; a deletion marker prevents upsert and routing.
- Treat all workspace bytes, including `.git`, as untrusted.

## Acceptance criteria

- Restarting the runner reloads valid sessions and sends a complete snapshot.
- A snapshot restores a missing four-field catalog row for a valid, non-tombstoned runner-local session without importing transcript or runtime state into control persistence.
- A partial/corrupt final append is detected and handled visibly without silently inventing state.
- The control-panel route index is rebuilt from inventory and is not persisted.
- No runner-local database is added; runner session state remains in ordinary files/directories, with restrictive permissions for sensitive files.
- The control panel has no session transcript, event, state, route, branch, model, runner assignment, diff, or log persistence.

## Tests

- Atomic metadata update and interrupted-write behavior.
- Event cursor append/reload.
- Snapshot and catalog upsert after runner restart or control crash before catalog insertion, including rejection of tombstoned IDs.
- Control PostgreSQL schema assertion limiting `sessions` to the four catalog fields once that table exists.

## Not included

Session provisioning, model calls, event compaction, archives, or queued messages.
