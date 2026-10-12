# OpenOrb

OpenOrb hosts durable agent sessions on the gateway while runners supply isolated compute only for
periods of agent activity.

## Language

**Workspace**: The tenant that owns projects, secrets, provider and Git credentials, runners,
enrollment credentials, and the session catalog. _Avoid_: User tenant, Project Workspace

**Workspace Durable Object**: The configuration authority for the current Workspace. It owns browser
identities/sessions, configuration, enrollment records, catalog entries, deletion markers, and
provider authorization. _Avoid_: Session host, Runner Registry

**Runner Registry**: The live connection and command-routing authority for enrolled runners. It owns
control and bulk connections, runner presence, and live environment projections. Workspace remains
authoritative for runner credentials and the minimal Session catalog. _Avoid_: Runner host, Session
store

**Session Durable Object**: The per-Session authority that hosts the Agent Harness. It owns Harness
State, the Conversation View, Published Media records, and Stop Session orchestration. _Avoid_:
Agent cell, Session host, Session runner

**User**: A person who belongs directly to exactly one Workspace, with their own password and Git
author identity. _Avoid_: Tenant, member

**Session**: A durable association between a conversation and its Agent Environment that persists
across agent activity and idle periods. A Session with a project also owns its Project Checkout; a
Session without one starts from an empty `/workspace` and loads no Git integration.

**Agent Harness**: The provider-neutral agent capability hosted by the Session Durable Object,
independent of any particular agent implementation or version. _Avoid_: Pi interface, Pi runtime

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

**Project Checkout**: The session-specific repository at `/workspace` inside the Agent Environment.
_Avoid_: Host workspace, mounted workspace

**Git Snapshot**: A bounded point-in-time record of a Project Checkout's Git state. Its file status
and patch previews are cached by the Session Durable Object independently of the Agent Environment,
while its full staged and unstaged patches remain in the Agent Environment. _Avoid_: Git report,
Diff Snapshot

**Published Media**: An immutable image or video that the Agent Harness copies from the designated
guest artifact directory into private, Session-owned object storage for display in the transcript.
_Avoid_: Attachment, guest file, external embed

**Agent Environment**: The live isolated compute capabilities and Project Checkout available to an
Agent Harness during an Agent Run, independent of how the underlying compute was created or
restored. _Avoid_: Workspace Runtime, VM

**Environment Link**: The connection over which a Session Durable Object reaches the Environment
Daemon of its Agent Environment. Its Agent Environment Provider determines how it is opened.
_Avoid_: Env socket, bridge, tunnel

**Environment Daemon**: The guest process that performs an Agent Harness's file and shell operations
inside the Agent Environment. _Avoid_: pi-env server, guest agent

**Agent Environment Provider**: The authority that creates, starts, stops, and deletes Agent
Environments and opens Environment Links to them, such as an OpenOrb runner or a sandbox vendor. It
declares its persistence and Egress Secret Mediation instead of sharing one guarantee. _Avoid_:
Sandbox provider, vendor, Workspace Runtime

**Sandbox**: The built-in Agent Environment Provider that runs just-bash, a TypeScript bash
interpreter with a virtual filesystem, in an isolated Dynamic Worker hosted by the Session Durable
Object, for inspecting untrusted content. It needs no runner and has no project, Git, or network.
_Avoid_: Local runner, bash VM

**Egress Secret Mediation**: Substitution of real credentials for guest-visible placeholders outside
the guest, so the real values never enter it. _Avoid_: Secret proxy, redaction

**Guest Credential Opt-in**: A Project's explicit consent to place real Git credentials and
Workspace secrets inside guests whose Agent Environment Provider lacks Egress Secret Mediation.
_Avoid_: Insecure mode

**Persistent Root Disk**: The private, sparse 40 GiB `root-disk.qcow2` that an OpenOrb runner
retains for one Session and reopens in each new VM. It includes the Project Checkout and other
non-tmpfs guest state, but not RAM, processes, or tmpfs-backed paths. _Avoid_: Workspace disk, host
checkout

**Stop Session**: A recoverable pause of agent work together with a durable stop of its Agent
Environment. _Avoid_: Abort, cancellation

**Wake**: Resumption of a paused Session's agent work and Agent Environment. _Avoid_: New Session

**Abort**: Cancellation of agent work and queued inputs without stopping the Agent Environment.
_Avoid_: Stop Session

**Environment Control**: Agent-initiated start, stop, or restart of the Agent Environment without
pausing the agent itself. _Avoid_: Stop Session
