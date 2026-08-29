# OO-019 — Session deletion

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-018

## Outcome

The user explicitly deletes a session while its runner is online or offline. The gateway removes the catalog card immediately and a durable minimal deletion marker prevents stale runner state from resurrecting it.

## Scope

- Add destructive confirmation in the browser.
- Reject online deletion while Pi or provisioning/setup/resume-hook/checkpoint/Git Snapshot work is active; the user must wait for work to settle rather than having deletion implicitly stop it.
- In one PostgreSQL transaction, write `deleted_sessions(user_id, session_id, deleted_at)` and remove the five-column catalog row matching the authenticated user. Remove the user-scoped in-memory route immediately afterward.
- If the runner is online and idle, request idempotent removal of runner metadata, workspace, Pi JSONL, Git Snapshots, current/candidate/obsolete VM checkpoints, and logs.
- If the runner is offline or permanently lost, complete the control-plane deletion without waiting for runner cleanup.
- On any later snapshot from a runner with the same owner containing a deleted session ID, do not recreate its catalog row or route. Request runner cleanup repeatedly; if runner work, including checkpoint resume or replacement, is still active, wait until it settles rather than interrupting it.
- Retain the minimal deletion marker after cleanup so a stale runner disk or restored backup cannot resurrect the session.
- Make partial runner filesystem deletion visible in runner/gateway diagnostics and safely retryable without restoring the catalog card.

## Acceptance criteria

- Deletion requires explicit confirmation.
- Online deletion is rejected during active work and succeeds once the session is idle.
- Online or offline deletion atomically records the marker and removes the catalog card.
- Offline deletion succeeds even if the runner host has been permanently lost.
- A failed or interrupted runner cleanup remains hidden by the marker and is retried idempotently when that runner reports the session again.
- A runner session manifest cannot recreate or route a tombstoned session.
- A user cannot inspect or delete another user's session, and one user's tombstone cannot suppress or clean up another user's session.
- Successful online cleanup removes all session-owned runner paths; deleted session IDs are not advertised after runner restart.
- The gateway retains no deleted-session data beyond `user_id`, `session_id`, and `deleted_at`.

## Tests

- Successful idle online deletion.
- Active online deletion rejection.
- Offline and revoked-runner deletion.
- Gateway crash after marker/catalog transaction but before or during runner cleanup.
- Injected partial runner filesystem failure followed by snapshot-driven retry.
- Stale snapshot and restored-runner fixture cannot resurrect a tombstoned session.
- PostgreSQL schema assertion limiting deletion markers to user ID, session ID, and deletion time.
- Two-user deletion, tombstone, stale-snapshot, and cleanup separation.

## Not included

Archive, retention policies, trash/restore, migration, automatic deletion, or purging anti-resurrection markers.
