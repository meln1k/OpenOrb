# OO-020 — Offline and reconnect behavior

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-019

## Outcome

Runner and control-panel restarts produce the explicit unavailable/recovery behavior required by the lean MVP without migrating or mirroring sessions.

## Scope

- Remove a disconnected runner's sessions from the in-memory routing index and mark its runner offline.
- Keep catalog cards limited to project, creation time, and initial-prompt preview.
- Disable full session reads and runner-backed actions until the same runner reconnects; explicit marker-backed deletion remains available.
- On reconnect, ingest the runner's complete session snapshot, derive ownership from the authenticated runner, upsert missing non-tombstoned five-column catalog rows, rebuild user-scoped routes, and restore runner-backed history/event access only for the matching authenticated browser user. Do not remove catalog rows based only on snapshot absence. Reject matching user-scoped tombstoned entries and request idempotent runner cleanup after active work settles.
- Exercise control-panel restart while runner/browser reconnect automatically.
- Mark interrupted active work failed instead of reconstructing in-memory Pi state or replaying prompts.

## Acceptance criteria

- Offline session cards reveal no runner assignment, status, branch, transcript, diff, or other runner-owned data.
- Prompt, stop, history, events, and changes clearly report runner unavailability; explicit deletion remains available and removes the catalog card.
- The same runner reconnect restores access to non-deleted sessions and repairs a missing catalog row from the runner snapshot.
- A reconnecting runner cannot restore or route a session with a deletion marker.
- A reconnecting runner cannot claim, expose, suppress with a tombstone, or clean up another user's session.
- No session is reassigned or migrated.
- Control restart writes no full session data while recovering routes.

## Tests

- Runner disconnect/reconnect with active, stopped, and tombstoned sessions.
- Control-panel restart and snapshot/deletion-marker race.
- Two-user reconnect and snapshot/deletion-marker isolation.
- Interrupted-run failure state after runner restart.
- Persistence/schema inspection before and after recovery.

## Not included

Offline queues, migration, high availability, or control-plane command durability.
