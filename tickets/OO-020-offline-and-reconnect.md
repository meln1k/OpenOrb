# OO-020 — Offline and reconnect behavior

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-019

## Outcome

Runner connection loss, gateway restart, and runner restart produce explicit unavailable and recovery behavior without migrating sessions or mirroring runner-owned data in the gateway.

## Existing baseline

- The Effect RPC transport already owns transient reconnect backoff, `IdentifyRunner`, complete `WatchRunner` admission, make-before-break connection generations, route removal, and delivery-uncertain command results.
- PostgreSQL catalog reconciliation already upserts valid five-column rows, derives ownership from the authenticated runner, and filters user-scoped deletion markers. Runner-backed browser routes already report offline errors, and an active `EventSource` already reconnects after interruption.
- Runner startup already reconciles `created`/`provisioning` to `error` and `running` to `ready`; ready workers reopen Pi JSONL and restore lazily.
- Preserve those contracts. This ticket completes process-level restart/reconnect coverage and integrates OO-018 checkpoint state plus OO-019 deletion cleanup; it does not replace the transport or add another recovery store.

## Scope

- On runner socket loss, remove only that connection generation and its sessions from the gateway's in-memory routing index and mark the runner offline. Keep the five-column catalog cards; do not remove catalog rows based on connection loss or snapshot absence.
- Treat socket lifetime and runner work lifetime separately. Closing a gateway/runner connection finalizes its RPC requests and browser watches but does not cancel process-owned provisioning or Pi work on a still-running runner. Report an in-flight command whose acknowledgement was lost as delivery-uncertain and never retry it automatically.
- While the runner is offline, disable transcript/history replay, prompt, Abort, Stop, Git Snapshot/Changes, and other runner-backed actions. Explicit marker-backed deletion remains available. A page already watching a session reports interruption and lets native `EventSource` reconnect; a page loaded while offline recovers after reload once the runner route exists again.
- Let the runner reconnect transient socket failures with bounded exponential backoff. Admit a replacement connection only after `IdentifyRunner` authentication and one complete, runtime-validated `WatchRunner` snapshot. Subscribe before reading runner files, reconcile the entire snapshot, and atomically install the new connection generation and user-scoped routes only after `snapshot.complete`; a stale generation cannot remove or overwrite replacement routes.
- During snapshot reconciliation, derive tenant ownership from the authenticated runner, upsert missing non-tombstoned five-column catalog rows for valid user-owned projects, and reject catalog conflicts, cross-user references, and user-scoped tombstoned IDs. Request idempotent tombstoned-session cleanup only after provisioning/setup/resume-hook/checkpoint/Git Snapshot/Pi work settles.
- On gateway restart, retain only PostgreSQL catalog rows and deletion markers. Runners reconnect and rebuild live routes through the same admission path; browsers then reload or reconnect history from Pi JSONL through the runner. Do not reconstruct or persist runner assignment, session state, transcript, diff, logs, or event cursors in the gateway.
- On runner process restart, load ordinary runner session files and reconcile durable lifecycle state before accepting commands: `created` or `provisioning` becomes `error` and requires explicit provisioning retry; `running` becomes `ready`; `ready` and `error` remain unchanged. Recreate ready workers lazily, reopen Pi JSONL rather than reconstructing Pi queues, and never replay an interrupted prompt automatically.
- Incorporate OO-018 checkpoint state into runner restart reconciliation. Preserve a valid published current checkpoint for a stopped session, remove invalid candidates, finish idempotent obsolete-checkpoint cleanup, and never publish or resume a partial candidate. An interrupted checkpoint/resume or a lost active VM follows OO-018's no-silent-stale-resume rule and OO-021's explicit recovery flow.

## Acceptance criteria

- Offline session cards reveal no runner assignment, branch, transcript, diff, or runner-owned lifecycle status beyond the fact that the session is offline.
- Prompt, Abort, Stop, history, events, Git Snapshot/Changes, and other runner-backed actions clearly report runner unavailability; explicit deletion remains available and removes the catalog card.
- Socket loss does not cancel process-owned runner work, and commands with ambiguous acknowledgement are not retried.
- The same authenticated runner reconnects through a complete `WatchRunner` snapshot, restores access to non-deleted sessions, and repairs a missing catalog row without exposing a partial snapshot.
- Replacement admission is make-before-break, and events or finalizers from stale connection generations cannot change current routes.
- A reconnecting runner cannot restore or route a session with a deletion marker.
- A reconnecting runner cannot claim, expose, suppress with a tombstone, or clean up another user's session.
- Gateway restart rebuilds routes without writing any runner-owned session data to gateway persistence.
- Runner restart applies the specified durable-state transitions, lazily restores ready sessions from Pi JSONL/workspace, and does not replay interrupted prompts.
- Stopped sessions retain only a valid published checkpoint; partial candidates are never advertised or resumed, and restart cleanup converges without deleting the current checkpoint.
- No session is reassigned or migrated.

## Tests

- Real transient runner disconnect/reconnect with active, ready, stopped, and tombstoned sessions; active runner work survives while gateway commands/watches settle unavailable or delivery-uncertain.
- Complete-snapshot admission, make-before-break replacement, stale-generation finalization, malformed/partial snapshot rejection, and missing-catalog-row repair.
- Gateway process restart followed by runner and browser recovery, including Pi JSONL cursor replay and persistence/schema inspection before and after route rebuilding.
- Runner process restart state reconciliation, lazy ready-worker restoration, and no prompt/Pi-queue replay.
- Interrupted checkpoint publication/resume, invalid-candidate removal, obsolete cleanup, and valid stopped-checkpoint preservation across runner restart.
- Tombstone/snapshot race, cleanup after active work settles, restored-runner anti-resurrection, and two-user ownership isolation.
- Offline browser routes for prompt, Abort, Stop, history/events, Git Snapshot/Changes, and explicit deletion.

## Not included

Offline queues, automatic replay, exactly-once delivery, migration, high availability, or control-plane command durability.
