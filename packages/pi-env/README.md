# @openorb/pi-env

The Environment Link transport for
[`@earendil-works/pi-env`](https://github.com/earendil-works/pi/tree/main/packages/env)'s
`RemoteExecutionEnv`, which a Session Durable Object uses unmodified from the pinned npm package
(ADR 0008). Upstream's `Connection` can only spawn the daemon as a process, so this package keeps:

- `LinkConnection`, derived from upstream 1.1.0's `Connection` (MIT). It replaces every public
  method of upstream's `Connection` and opens an `EnvLink` that carries one complete frame per
  message. It pings only while requests are in flight, so an idle link never wakes a hibernated
  Durable Object, and request ids start at a random value so a rehydrated connection cannot match
  replies meant for an evicted instance. Its errors are upstream's `RemoteError`, so upstream's
  error mapping and `isConnectionLost` apply.
- `DaemonRelay` and `DaemonOutput`, the runner's side of the link: it consumes the daemon's sync
  line, answers the daemon's pings, and forwards frames verbatim.
