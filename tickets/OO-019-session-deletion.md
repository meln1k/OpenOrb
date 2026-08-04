# OO-019 — Session deletion

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-018

## Outcome

The user explicitly deletes an online runner-owned session and its minimal control-panel catalog entry.

## Scope

- Add destructive confirmation in the browser.
- Require the owning runner to be connected.
- Stop any active Pi run/VM through an explicit, visible sequence before deletion; ask if a product conflict arises rather than choosing silent behavior.
- Remove runner metadata, workspace, Pi JSONL, normalized events, reports, and logs.
- Remove the four-field catalog row and in-memory route only after runner deletion succeeds.
- Make partial filesystem deletion fail visibly and safely retryable while the runner is online.

## Acceptance criteria

- Deletion requires explicit confirmation.
- Offline deletion is rejected and creates no control-panel tombstone.
- Successful deletion removes all session-owned runner paths and then the catalog card.
- A failed runner deletion leaves the catalog row intact for retry.
- Deleted session IDs are no longer advertised after runner restart.

## Tests

- Successful stopped/idle session deletion.
- Active/offline deletion behavior.
- Injected partial runner filesystem failure and retry.
- Control catalog ordering and no-tombstone schema assertion.

## Not included

Archive, retention policies, trash/restore, migration, or automatic deletion.
