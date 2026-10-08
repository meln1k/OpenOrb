# OpenOrb Runner

The OpenOrb Runner hosts durable agent sessions while acquiring isolated compute only for periods of
agent activity.

## Language

**Workspace**: The tenant that owns projects, secrets, provider and Git credentials, runners,
enrollment credentials, and the session catalog. _Avoid_: User tenant, Project Workspace

**Workspace Durable Object**: The single celld configuration owner for the current Workspace. It
persists browser identities/sessions, configuration, enrollment records, catalog entries, deletion
markers, and provider authorization in SQLite-backed DO storage. Gateway controllers call its Worker
over HTTP. Runner connections and full Session state are not moved in this migration step.

**User**: A person who belongs directly to exactly one Workspace, with their own password and Git
author identity. _Avoid_: Tenant, member

**Session**: A durable association between a conversation and its Project Checkout that persists
across agent activity and idle periods.

**Agent Harness**: The provider-neutral agent capability used by the runner, independent of any
particular agent implementation or version. _Avoid_: Pi interface, Pi runtime

**Harness State**: The durable conversation, queued inputs, and unfinished agent work needed by an
Agent Harness to continue a Session. _Avoid_: Conversation journal

**Submission**: One input admitted to a Session's conversation, with its own stable identity whether
it starts work or becomes a Follow-up. _Avoid_: Run ID, acceptance receipt

**Agent Run**: A continuous period of agent activity beginning with an accepted prompt, including
follow-ups and automatic continuations, and ending when the agent settles. _Avoid_: Prompt run, turn

**Follow-up**: Input added to the current Agent Run rather than starting a new Agent Run. _Avoid_:
New run, prompt run

**Session Event**: A fact about a Session expressed in OpenOrb's stable event vocabulary,
independent of the provider-specific source that reported it.

**Session Journal**: The runner-owned sequence of infrastructure and configuration facts for a
Session. It is separate from the agent work owned by Harness State. _Avoid_: Conversation journal

**Conversation View**: The current active transcript, queued input, agent configuration, usage, and
live progress presented to a Session viewer. _Avoid_: Event replay

**Project Checkout**: The session-specific repository at `/workspace` inside the persistent Agent
Environment root disk. _Avoid_: Host workspace, mounted workspace

**Git Snapshot**: A bounded point-in-time summary of a Project Checkout's Git state, including file
status and staged and unstaged patches, cached by the runner independently of the Agent
Environment's lifecycle. _Avoid_: Git report, Diff Snapshot

**Published Media**: An immutable image or video that the Agent Harness copies from the designated
guest artifact directory into private, Session-owned runner storage for display in the transcript.
_Avoid_: Attachment, guest file, external embed

**Agent Environment**: The live isolated compute capabilities and Project Checkout available to an
Agent Harness during an Agent Run, independent of how the underlying compute was created or
restored. _Avoid_: Workspace Runtime, VM

**Agent Environment Provider**: The authority that supplies Agent Environments backed by a durable,
session-owned root disk. _Avoid_: Workspace Runtime

**Persistent Root Disk**: The private, sparse 40 GiB `root-disk.qcow2` retained for one Session and
reopened by each new VM. It includes the Project Checkout and other non-tmpfs guest state, but not
RAM, processes, or tmpfs-backed paths. _Avoid_: Workspace disk, host checkout

**Stop Session**: A recoverable pause of agent work together with a durable stop of its Agent
Environment. _Avoid_: Abort, cancellation

**Wake**: Resumption of a paused Session's agent work and Agent Environment. _Avoid_: New Session

**Abort**: Cancellation of agent work and queued inputs without stopping the Agent Environment.
_Avoid_: Stop Session

**Environment Control**: Agent-initiated start, stop, or restart of the Agent Environment without
pausing the agent itself. _Avoid_: Stop Session
