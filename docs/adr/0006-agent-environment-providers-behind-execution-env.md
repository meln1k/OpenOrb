# Put Agent Environment Providers behind Pi's ExecutionEnv

**Status:** Accepted; implemented with the OpenOrb runner as the only provider. The Session records
its provider kind and the Project's Guest Credential Opt-in; Workspace defaults, Project overrides,
and their storage and UI are deferred until a second provider exists.

The Agent Harness sees only Pi's `ExecutionEnv` interface, unchanged. Everything that supplies it
sits behind an OpenOrb Agent Environment Provider. That includes the OpenOrb runner, which becomes
one provider among future sandbox vendors. A provider supplies compute, lifecycle (start, stop,
restart, delete), persistence, network policy, and a way to open an Environment Link. It does not
supply project behaviour. Providers that can run the static Environment Daemon all share the
vendored `RemoteExecutionEnv`, and only the link transport is vendor-specific. A provider with a
suitable native API may return its own `ExecutionEnv` instead.

Repository clone, `.agents/setup` and `.agents/resume`, Git Snapshots, skill discovery, and
Published Media move into the Session Durable Object and run over `ExecutionEnv`. This keeps
providers thin. Otherwise every vendor would reimplement project behaviour and drift from the
others. The Session Durable Object decides when to refresh a Git Snapshot.

Providers declare capabilities rather than promising the runner's guarantees:

- **Persistence:** a durable root disk, a vendor snapshot, or ephemeral storage.
- **Egress secret mediation:** whether real credentials stay outside the guest.
- **Hibernatable link:** whether the Durable Object can sleep while the link stays open.

The runner keeps a Persistent Root Disk and Gondolin egress substitution. On a provider without
egress mediation, the GitHub token and Workspace secrets enter the guest only through an explicit
per-Project opt-in. Without that opt-in, the Session runs with neither.

A Git Snapshot is split between the two sides. The Session Durable Object stores the summary: file
statuses, patch sizes, and the first 256 KiB of the staged and unstaged patches. The full patches
are written to a guest file outside `/workspace`, on persistent guest storage where the provider has
it, and only the latest snapshot is kept. A viewer who pages past a preview reads byte ranges over
`ExecutionEnv`, bounded by the sizes recorded at capture. A refresh therefore sends only the summary
across the Environment Link. Full patches are readable only while the environment is running and
reachable; otherwise the summary and previews still render. Two alternatives were rejected:
streaming every full diff to the gateway on each refresh would cost network on every refresh, and
copying full patches to R2 at Stop would cost gateway storage. The guest could rewrite a stored
patch, but Git output already comes from the untrusted guest, so this exposes nothing new.

A Workspace chooses a default provider; a Project may override it, and a Session may override both
at creation. The agent session never depends on its provider being reachable. Prompts are admitted
and model work continues while a runner is offline, and guest tools fail immediately instead of
waiting, so the agent can choose another approach.
