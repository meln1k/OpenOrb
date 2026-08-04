# OO-020 — Offline and reconnect behavior

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-019

## Outcome

Runner and control-panel restarts produce the explicit unavailable/recovery behavior required by the lean MVP without migrating or mirroring sessions.

## Scope

- Remove a disconnected runner's sessions from the in-memory routing index and mark its runner offline.
- Keep catalog cards limited to project, creation time, and initial-prompt preview.
- Disable full session reads and actions until the same runner reconnects.
- On reconnect, ingest runner inventory, rebuild routes, and restore runner-backed history/event access.
- Exercise control-panel restart while runner/browser reconnect automatically.
- Mark interrupted active work failed instead of reconstructing in-memory Pi state or replaying prompts.

## Acceptance criteria

- Offline session cards reveal no runner assignment, status, branch, transcript, diff, or other runner-owned data.
- Prompt, stop, delete, history, events, and changes clearly report runner unavailability.
- The same runner reconnect restores access to its sessions.
- No session is reassigned or migrated.
- Control restart writes no full session data while recovering routes.

## Tests

- Runner disconnect/reconnect with active and stopped sessions.
- Control-panel restart and inventory race.
- Interrupted-run failure state after runner restart.
- Persistence/schema inspection before and after recovery.

## Not included

Offline queues, migration, high availability, or control-plane command durability.
