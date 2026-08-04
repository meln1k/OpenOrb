# OO-019 — Session deletion

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-018

## Outcome

The user explicitly deletes a session while its runner is online or offline. The control panel removes the catalog card immediately and a durable minimal deletion marker prevents stale runner state from resurrecting it.

## Scope

- Add destructive confirmation in the browser.
- Reject online deletion while Pi or provisioning/setup/report work is active; the user must wait for work to settle rather than having deletion implicitly stop it.
- In one PostgreSQL transaction, write `deleted_sessions(session_id, deleted_at)` and remove the four-field catalog row. Remove the in-memory route immediately afterward.
- If the runner is online and idle, request idempotent removal of runner metadata, workspace, Pi JSONL, normalized events, reports, and logs.
- If the runner is offline or permanently lost, complete the control-plane deletion without waiting for runner cleanup.
- On any later snapshot containing a deleted session ID, do not recreate its catalog row or route. Request runner cleanup repeatedly; if runner work is still active, wait until it settles rather than interrupting it.
- Retain the minimal deletion marker after cleanup so a stale runner disk or restored backup cannot resurrect the session.
- Make partial runner filesystem deletion visible in runner/control diagnostics and safely retryable without restoring the catalog card.

## Acceptance criteria

- Deletion requires explicit confirmation.
- Online deletion is rejected during active work and succeeds once the session is idle.
- Online or offline deletion atomically records the marker and removes the catalog card.
- Offline deletion succeeds even if the runner host has been permanently lost.
- A failed or interrupted runner cleanup remains hidden by the marker and is retried idempotently when that runner reports the session again.
- A runner snapshot cannot recreate or route a tombstoned session.
- Successful online cleanup removes all session-owned runner paths; deleted session IDs are not advertised after runner restart.
- The control panel retains no deleted-session data beyond `session_id` and `deleted_at`.

## Tests

- Successful idle online deletion.
- Active online deletion rejection.
- Offline and revoked-runner deletion.
- Control crash after marker/catalog transaction but before or during runner cleanup.
- Injected partial runner filesystem failure followed by snapshot-driven retry.
- Stale snapshot and restored-runner fixture cannot resurrect a tombstoned session.
- PostgreSQL schema assertion limiting deletion markers to session ID and deletion time.

## Not included

Archive, retention policies, trash/restore, migration, automatic deletion, or purging anti-resurrection markers.
