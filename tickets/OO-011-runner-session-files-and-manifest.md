# OO-011 — Runner session files and manifest

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-005

## Outcome

The runner owns durable session data in the agreed file formats and sends a session manifest that rebuilds live routing after reconnect.

## Scope

- Create per-session storage with atomic `metadata.json`, Pi-owned `pi/session.jsonl`, `logs/`, `snapshots/`, and `workspace/`.
- Define only metadata fields required by current tickets and `MVP.md`; Pi JSONL is the sole durable conversation transcript.
- Derive replay positions from the active Pi session branch instead of maintaining an OpenOrb event file.
- Sync a complete runner-owned session manifest on connect/reconnect. Each entry includes the four catalog data fields plus the live routing/state data required by current tickets; it does not choose tenant ownership.
- Runtime-validate the manifest, derive immutable `user_id` from the authenticated runner, upsert missing non-tombstoned five-column catalog rows, and build the gateway's user-scoped session-to-runner route index only in memory. Manifest absence alone does not delete catalog rows because runner assignment is not persisted; a user-scoped deletion marker prevents upsert and routing.
- Treat all workspace bytes, including `.git`, as untrusted.

## Acceptance criteria

- Restarting the runner reloads valid sessions and syncs a complete manifest.
- A manifest entry restores a missing five-column catalog row for a valid, non-tombstoned runner-local session under the authenticated runner's owner without importing transcript or runtime state into gateway persistence.
- A runner cannot report, route, resurrect, or clean up a session in another user's tenant, including by supplying another user's project or session identifier.
- Pi JSONL is interpreted using Pi's own parser and active-branch semantics; OpenOrb does not invent a second recovery or transcript format.
- The gateway route index is rebuilt from the session manifest and is not persisted.
- No runner-local database is added; runner session state remains in ordinary files/directories, with restrictive permissions for sensitive files.
- The gateway has no session transcript, event, state, route, branch, model, runner assignment, diff, or log persistence.

## Tests

- Atomic metadata update and interrupted-write behavior.
- Pi JSONL active-branch projection and replay-position reload.
- Manifest sync and catalog upsert after runner restart or gateway crash before catalog insertion, including user-scoped rejection of tombstoned IDs and cross-user project references.
- Gateway PostgreSQL schema assertion limiting `sessions` to `user_id` plus the four catalog data fields once that table exists.

## Not included

Session provisioning, model calls, event compaction, archives, or queued messages.
