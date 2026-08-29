# SessionWorker idle lifecycle with environment suspension

**Status:** Future architecture note. The current runner keeps the Gondolin environment alive while
its `SessionWorker` is alive. This note applies once the Gondolin-backed `AgentEnvironmentProvider`
supports best-effort root-disk snapshots and suspension or shutdown.

## Decision

`SessionWorker` owns the idle policy for one Session. After an Agent Run has settled and its event
stream has been fully consumed, the worker keeps both the live Agent Harness conversation and Agent
Environment warm for five minutes. If no new Agent Run starts during that interval, the worker:

1. disposes the live harness conversation;
2. asks the Agent Environment Provider to preserve the environment root disk on a best-effort basis;
   and
3. shuts down the live environment so an idle Session consumes no VM resources.

Snapshot failure must not block shutdown, mark the Session failed, or reject its next prompt. The
Project Workspace and Harness State remain sufficient for continuation.

This is a follow-on to OO-018, which currently specifies a 15-minute idle timeout and destruction
without checkpointing. Its acceptance criteria must be reconciled before this five-minute
snapshot-aware policy is implemented.

## Ownership and scopes

The worker controls _when_ resources expire. The adapters control _how_ their resources are acquired
and released.

```text
SessionWorker scope
|-- Agent Environment child scope
|   `-- Gondolin VM and mounted Project Workspace
`-- Agent Harness conversation child scope
    |-- live provider session (currently Pi AgentSession)
    `-- Agent Run scope
        |-- prompt and event-processing fibers
        `-- finite event stream subscription
```

The worker should create closeable child scopes with `Scope.fork`. Closing the worker scope closes
all children immediately. Closing an idle child scope releases only that resource and lets the
worker remain available for cold continuation.

The five-minute timer is an Effect fiber owned by the worker scope. It sends an expiration command
through the worker mailbox rather than closing resources directly. The command carries a lease
generation so a stale timer cannot close resources reused by a newer prompt.

## Activity rules

- No idle timer runs during provisioning, setup, Git Snapshot generation, an Agent Run, or Abort
  processing.
- The timer starts only after the Agent Run's finite stream has settled. This avoids shutting down a
  long-running model or tool operation merely because the last user input is old.
- A new prompt before expiration cancels the timer and reuses the warm harness conversation and
  environment.
- A follow-up belongs to the active Agent Run and therefore postpones the start of the idle timer
  until the complete run settles.
- Explicit worker shutdown bypasses the timer and closes all resources immediately.

## Cold continuation

After idle expiration, the `SessionWorker` remains the process-owned authority for the Session but
holds no live harness conversation or VM. On the next prompt it:

1. reacquires an Agent Environment, restoring the last root-disk snapshot when one is available;
2. remounts the existing host-backed Project Workspace;
3. opens a new harness conversation from the existing Harness State; and
4. starts the new Agent Run.

The Environment Snapshot contains only the Gondolin root disk. It does not contain the Project
Workspace or Pi JSONL. Workspace edits persist through the host-backed mount, while conversation
context persists through Harness State. A successful snapshot keeps guest root-disk details aligned
with that context; a missing or failed snapshot is recoverable context for the agent, not a reason
to block continuation.

## Required harness lifetime change

The current `AgentHarness.start` scope owns one live provider session and disposes it when that
run's stream ends. Five-minute warm retention requires separating two lifetimes:

- a worker-owned harness conversation, reusable across sequential Agent Runs; and
- a run-owned finite event stream, disposed as soon as that Agent Run settles.

The provider-neutral harness boundary should expose a scoped conversation handle capable of starting
sequential runs. `SessionWorker` retains that handle in its child scope until idle expiry; the Pi
adapter remains responsible for creating, reopening, and disposing the underlying Pi `AgentSession`.
