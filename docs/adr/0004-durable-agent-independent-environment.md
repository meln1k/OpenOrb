# Let Pi Durable own agent work independently of the environment

**Status:** Accepted

Replace pi-coding-agent with Pi Durable, with no conversion or compatibility path for disposable
development sessions. Durable owns conversation entries, queued inputs, tasks, and recovery in a
private per-Session SQLite database. OpenOrb's journal owns infrastructure facts, not a second agent
task state machine. The gateway remains a metadata catalog, not a conversation store.

Prompt acknowledgements identify Durable Submissions, not OpenOrb run groups. Durable's request-ID
deduplication replaces custom receipt documents and admission observers. Duplicate acknowledgements
read the existing submission without calling `submit`, because even a duplicate `submit` enables
Durable scheduling. Abort targets the conversation, not a separately tracked run ID.

Consume Durable's complete Conversation Views internally, without replaying its deltas into another
source replica. Redact and project media references before diffing the browser-facing view. Stream
that view as an initial snapshot followed by Chord operations. Slow viewers coalesce to the latest
view and compute deltas from their own last-delivered view. Infrastructure events retain a separate
bounded queue; its overflow forces a reconnect. Reconnect replaces the baseline; there are no
transcript replay cursors. The active view is not an archive of entries before compaction. Observing
it never enables agent scheduling or starts a VM. One scoped owner serializes live harness access
and offline reads.

Agent and environment lifecycles are independent. Start or Wake opens the harness and starts the
model concurrently with environment boot and project setup/resume. The execution adapter is
available immediately; guest operations wait cancellably for readiness. Host credentials and trusted
prompt preparation never require a ready guest.

Stop Session closes Durable recoverably before stopping compute. Wake resumes checkpointed work;
Abort cancels queued inputs and owned background work without stopping the VM. This supersedes the
cancel-on-Stop behavior in ADR 0002, while preserving its disk identity and flush requirements.

A host-side `environment` tool can start, stop, or restart compute without pausing the agent.
Ordinary tools fail explicitly while the environment is stopped. Restart first attempts bounded
graceful shutdown and may force termination, reporting possible unsynced-data loss. No replacement
VM may attach until the previous instance has released the same persistent disk.

Recovery is not exactly-once execution: model requests may repeat and interrupted unsafe tools may
report partial execution. Guest RAM/processes do not survive. All agent file and shell capabilities
remain guest-only; neither NodeExecutionEnv nor project-discovered host extensions are permitted.
