# OpenOrb Runner

The OpenOrb Runner hosts durable agent sessions while acquiring isolated compute only for periods of
agent activity.

## Language

**Session**: A durable association between a conversation and its workspace that persists across
agent activity and idle periods.

**Agent Harness**: The provider-neutral agent capability used by the runner, independent of any
particular agent implementation or version. _Avoid_: Pi interface, Pi runtime

**Harness State**: The durable provider-specific state needed by an Agent Harness to continue a
Session. Pi's JSONL session log is one representation of Harness State. _Avoid_: Conversation
journal

**Agent Run**: A continuous period of agent activity beginning with an accepted prompt, including
follow-ups and automatic continuations, and ending when the agent settles. _Avoid_: Prompt run, turn

**Follow-up**: Input added to the current Agent Run rather than starting a new Agent Run. _Avoid_:
New run, prompt run

**Session Event**: A fact about a Session expressed in OpenOrb's stable event vocabulary,
independent of the provider-specific source that reported it.

**Session Journal**: The runner-owned, per-Session append-only sequence of facts used to rebuild
internal Session state and correlate asynchronous completions. It is separate from Session Events
and provider-owned Harness State. _Avoid_: Metadata snapshot

**Durable Session Event**: A Session Event backed by Harness State and addressable by a replay
cursor.

**Ephemeral Session Event**: A Session Event observed during live activity without a replay
guarantee. _Avoid_: Durable event, conversation event

**Project Workspace**: The host-backed project filesystem mounted into an Agent Environment. It
persists independently of the Agent Environment and its snapshots. _Avoid_: VM workspace

**Git Snapshot**: A bounded point-in-time summary of a Project Workspace's Git state, including file
status and staged and unstaged patches, cached by the runner independently of an Environment
Snapshot. _Avoid_: Git report, Diff Snapshot

**Agent Environment**: The live isolated compute capabilities and mounted Project Workspace
available to an Agent Harness during an Agent Run, independent of how the underlying compute was
created or restored. _Avoid_: Workspace Runtime, VM

**Agent Environment Provider**: The authority that supplies Agent Environments and makes a
best-effort attempt to preserve their root-disk state between Agent Runs. _Avoid_: Workspace Runtime

**Environment Snapshot**: A reusable copy of an Agent Environment's root disk, captured on a
best-effort basis after an Agent Run. It excludes the host-backed Project Workspace and Harness
State and is not required to continue a Session. _Avoid_: Workspace snapshot, session snapshot
