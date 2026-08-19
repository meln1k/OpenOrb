# OO-011 — Runner session files and inventory

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-005

## Outcome

The runner owns durable session data in the agreed file formats and advertises enough inventory to rebuild live routing after reconnect.

## Scope

- Create per-session storage with atomic `metadata.json`, Pi-owned `pi/session.jsonl`, append-only `events.jsonl`, `logs/`, `reports/`, and `workspace/`.
- Define only metadata and event fields required by current tickets and `MVP.md`.
- Add monotonic per-session event cursors and crash-safe append behavior.
- Send a complete runner-owned session snapshot on connect/reconnect. Each entry includes the four catalog data fields plus the live routing/state data required by current tickets; it does not choose tenant ownership.
- Runtime-validate the snapshot, derive immutable `user_id` from the authenticated runner, upsert missing non-tombstoned five-column catalog rows, and build the gateway's user-scoped session-to-runner route index only in memory. Snapshot absence alone does not delete catalog rows because runner assignment is not persisted; a user-scoped deletion marker prevents upsert and routing.
- Treat all workspace bytes, including `.git`, as untrusted.

## Acceptance criteria

- Restarting the runner reloads valid sessions and sends a complete snapshot.
- A snapshot restores a missing five-column catalog row for a valid, non-tombstoned runner-local session under the authenticated runner's owner without importing transcript or runtime state into gateway persistence.
- A runner cannot report, route, resurrect, or clean up a session in another user's tenant, including by supplying another user's project or session identifier.
- A partial/corrupt final append is detected and handled visibly without silently inventing state.
- The gateway route index is rebuilt from inventory and is not persisted.
- No runner-local database is added; runner session state remains in ordinary files/directories, with restrictive permissions for sensitive files.
- The gateway has no session transcript, event, state, route, branch, model, runner assignment, diff, or log persistence.

## Tests

- Atomic metadata update and interrupted-write behavior.
- Event cursor append/reload.
- Snapshot and catalog upsert after runner restart or gateway crash before catalog insertion, including user-scoped rejection of tombstoned IDs and cross-user project references.
- Gateway PostgreSQL schema assertion limiting `sessions` to `user_id` plus the four catalog data fields once that table exists.

## Not included

Session provisioning, model calls, event compaction, archives, or queued messages.
