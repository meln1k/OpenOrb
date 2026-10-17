# Run codemode's VM in a loaded facet of the Session Durable Object

**Status:** Accepted; implemented. Changes the codemode boundary described in
[security.md](../../security.md)

The Agent Harness's codemode tool runs model-written JavaScript. Today upstream Pi's
`InlineCodemodeSandbox` ran its QuickJS/WASM VM on the Session Durable Object's own thread, in the
isolate that holds the Session's credentials, bindings, and storage. We instead run the VM in a
Dynamic Worker that the Session Durable Object loads through celld's Worker Loader and runs as a
facet named `codemode`, with no bindings (`env: {}`), no network (`globalOutbound: null`), and a
per-call CPU limit. Tools, call records, and replay stay in the Session; only the VM moves.

Measured in `celld dev` 0.6.2 on two cores, with a ping to the Session Durable Object sent while a
script computed for about five seconds:

| Where the script computes                      | Ping to the same object | Ping to another object |
| ---------------------------------------------- | ----------------------- | ---------------------- |
| Inline, as before                              | 5.2–5.4 s               | 5.2–5.4 s              |
| Loaded facet, QuickJS                          | 3–5 ms                  | 3–12 ms                |
| Loaded facet, `cpuMs: 1000`, `while (true) {}` | 2–8 ms                  | 1–5 ms                 |

Inline computation stalls every Durable Object that shares the class's isolate, not only its own
Session, and nothing but Pi's cooperative interrupt budget stops it: the parent object has no CPU
limit. A loaded facet runs in its own isolate on another celld thread. Past its CPU limit the call
fails with `Worker exceeded CPU limit` after about one second, and the Session's memory and storage
are intact and a new facet loads. Pi's README reports the opposite on Cloudflare, where a Dynamic
Worker blocked its loader; this decision rests on celld's behaviour.

## Shape

Codemode is a Harness tool, not an Agent Environment Provider, so it lives with the Harness in
`packages/gateway/app/cells/session/codemode/`, not in `@openorb/environments`. Its facet is not the
Sandbox and shares nothing with it but the loading pattern: codemode runs in every Session,
whatever its placement, and its scripts reach the Agent Environment only through the Harness's
tools.

We use Pi's split sandbox with our own transport. The Session installs `RemoteCodemodeSandbox`
from `@earendil-works/pi-codemode/portable`, which keeps Pi's host side here: tool calls, call
records, output, and replay. The facet runs Pi's `serveCodemodeRemote`, which runs the VM on the
facet's thread. Pi's protocol has the VM call back into its host through an `exchange` function,
but celld cannot pass a function or any other RPC stub into a loaded isolate ("An RPC stub cannot
cross an isolate boundary"; a probe failed with `DataCloneError`). The Session therefore pulls:

- `run(id, request)` starts one execution and resolves once its VM has stopped.
- `next(id)` waits for the batches the VM has handed to `exchange` since the last call, numbered in
  the order it made them, and reports when the VM has stopped and none remain.
- `reply(id, seq, reply)` answers one batch with what Pi's host returned for it.

The Session hands the batches to Pi's host in order, so output stays before the call or result that
follows it. Effect's `Queue` and `Deferred` hold the batches and the waiting replies in the facet.
Every call starts in the Session, so the facet never enters the Session as a new request: it
cannot hold the Session's request slots, wait behind its input gate, or reorder its messages.
Giving the facet a loopback service binding to call back through was rejected for those reasons.

The loader ID contains the Session ID and the bundle's content hash, so Sessions never share an
isolate and a new build never reuses old code. The facet keeps no state, so when no execution is
running the Session aborts the facet and disposes its Worker, freeing its loader admission slot;
the next execution loads a fresh one. The facet's SQLite database stays unused.

The build bundles the facet like the Sandbox worker and carries it as a string, with QuickJS as
base64. celld's Worker Loader takes WebAssembly as bytes, not as a compiled module, so the Session
decodes it once and passes it as the `quickjs.wasm` module, which the facet bundle imports: Rolldown
keeps `quickjs-wasi/quickjs.wasm` external and renames it with `output.paths`.

## Security

The VM's boundary does not change: generated code still meets QuickJS, then WebAssembly, then a
single host-call entry point. What changes is where an escape from those lands. Today it lands in
the Session's isolate; after this it lands in an isolate with nothing to read and nowhere to send.
A V8 escape still reaches the gateway process, as for the Sandbox.

The Session treats the facet as compromised. It decodes every batch against Pi's message types
before Pi's host sees it, since Pi checks only the message tag, and fails the execution on anything
else. A compromised facet can call no tool that a script could not, and it can only answer what the
Session asks. Pi's output caps and its clamping of the interrupt budget and memory limit run inside
the facet, so the Session enforces the output caps again. The CPU limit, 5 seconds per call, is
celld's, outside the code it limits; Pi's interrupt budget becomes a cooperative early stop.

After an Abort or deadline the facet's VM keeps computing until its next tool call, its interrupt
budget, or the CPU limit, whichever comes first; Pi's host then answers `stop`. If the Session
stops pulling, it aborts the facet, so no VM waits for a reply that will not come.

## Consequences

- celld runs one worker thread per core by default. With two cores, two facets computing at once
  delayed a ping to an unrelated Session by about five seconds; with `CELLD_TOKIO_THREADS=6`, four
  did not. Gateway hosts must run more worker threads than cores, and many computing Sessions still
  share the CPU.
- Every tool call costs two RPC round trips, `next` and `reply`, and serialises its arguments and
  result.
- Each active Session may hold two loaded Workers, codemode and the Sandbox, against the loader's
  admission limit.

## Rejected alternatives

- **Keep the VM inline and lower the interrupt budget**: cheapest, but the budget is cooperative,
  the parent has no CPU limit, and an escape lands beside the Session's credentials.
- **A separately deployed sandbox Worker**, as Pi recommends for Cloudflare: it adds a Worker to
  deploy and bind, celld already isolates a loaded facet's thread, and a fixed Worker would serve
  every Session from shared instances instead of one isolate per Session.
- **Pi's `exchange` callback, or a loopback service binding in the facet's `env`**: celld cannot
  pass the callback, and the binding would make every exchange a new request to the Session, with
  the costs above.
- **Running `InlineCodemodeSandbox` in the facet**: it would move Pi's host side, and with it the
  results the Session trusts, into the untrusted isolate, and its calls would still need a way back.
- **A loaded `WorkerEntrypoint` instead of a facet**: measured the same, but `dispose()` lets
  in-flight calls finish, so it cannot stop a VM that waits for a reply; `facets.abort` can.
- **Codemode in `@openorb/environments`** beside the Sandbox, to share its lifecycle code: it would
  put a Harness tool behind the Agent Environment Provider boundary. The two lifecycles share code
  only if both grow.
