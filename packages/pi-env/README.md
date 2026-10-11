# @openorb/pi-env

The `RemoteExecutionEnv` client of
[`@earendil-works/pi-env`](https://github.com/earendil-works/pi/tree/main/packages/env) 1.1.0
(commit `abe508e1b89912adde45528136c3221eb69acdd7`, MIT), vendored so a Session Durable Object can
reach the Environment Daemon over an Environment Link. The daemon itself is used unmodified from the
pinned npm package. See [ADR 0005](../../docs/adr/0005-agent-harness-in-session-durable-object.md).

OpenOrb changes:

- `Connection` opens an `EnvLink` that carries one complete frame per message instead of spawning
  the daemon over SSH. The relay consumes the daemon's sync line and answers its pings.
- The client pings only while requests are in flight, so an idle link never wakes a hibernated
  Durable Object. Request ids start at a random value so a rehydrated connection cannot match
  replies meant for an evicted instance.
- Node built-ins are replaced by Web APIs, and paths follow POSIX rules only: the daemon runs in the
  Linux guest. `ssh.ts` and Windows path handling are removed.
