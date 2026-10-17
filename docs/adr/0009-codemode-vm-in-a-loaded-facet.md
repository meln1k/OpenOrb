# Run codemode's VM in a loaded facet of the Session Durable Object

**Status:** Proposed; would change the codemode boundary described in [security.md](../../security.md)

The Agent Harness's codemode tool runs model-written JavaScript. Today upstream Pi's
`InlineCodemodeSandbox` runs its QuickJS/WASM VM on the Session Durable Object's own thread, in the
isolate that holds the Session's credentials, bindings, and storage. We will instead run the VM in a
Dynamic Worker that the Session Durable Object loads through celld's Worker Loader and runs as a
facet named `codemode`, with no bindings (`env: {}`), no network (`globalOutbound: null`), and a
per-call CPU limit. Tools, call records, and replay stay in the Session; only the VM moves.

Measured in `celld dev` 0.6.2 on two cores, with a ping to the Session Durable Object sent while a
script computed for about five seconds:

| Where the script computes                      | Ping to the same object | Ping to another object |
| ---------------------------------------------- | ----------------------- | ---------------------- |
| Inline, as today                               | 5.2–5.4 s               | 5.2–5.4 s              |
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

We use Pi's split sandbox unchanged. The Session installs `RemoteCodemodeSandbox` from
`@earendil-works/pi-codemode/portable`, whose `remote` returns the facet stub. The loaded bundle
exports a subclass of Pi's `CodemodeSandboxDurableObject` from `/cloudflare`, which sets its limits
and receives the compiled QuickJS module as a `wasm` entry of the loader's module map. One
execution is one RPC call, `execute(request, exchange)`; each tool call and output batch returns to
the Session through `exchange`.

The loader ID contains the Session ID and the bundle's content hash, so Sessions never share an
isolate and a new build never reuses old code. The facet keeps no state, so when no execution is
running the Session aborts the facet and disposes its Worker, freeing its loader admission slot;
the next execution loads a fresh one. The facet's SQLite database stays unused.

The build bundles the facet like the Sandbox worker and carries it as a string. Rolldown has no
WebAssembly support that fits Workers, which cannot compile WebAssembly from bytes at runtime, so
`quickjs-wasi/quickjs.wasm` stays external, is renamed with `output.paths`, and is copied beside
the bundle for celld to compile.

## Security

The VM's boundary does not change: generated code still meets QuickJS, then WebAssembly, then a
single host-call entry point. What changes is where an escape from those lands. Today it lands in
the Session's isolate; after this it lands in an isolate with nothing to read and nowhere to send.
A V8 escape still reaches the gateway process, as for the Sandbox.

The Session treats the facet as compromised. Pi's host side already rejects malformed messages and
duplicate call IDs, and a compromised facet can call no tool that a script could not. Pi's output
caps and its clamping of the interrupt budget and memory limit, however, run inside the facet, so
the Session enforces its own bounds on output, calls, and how long an `exchange` stub is honoured
after its execution ends. The CPU limit is celld's, outside the code it limits; Pi's interrupt
budget becomes a cooperative early stop.

After an Abort or deadline the facet's VM keeps computing until its next tool call, its interrupt
budget, or the CPU limit, whichever comes first. Its results are discarded.

## Consequences

- celld runs one worker thread per core by default. With two cores, two facets computing at once
  delayed a ping to an unrelated Session by about five seconds; with `CELLD_TOKIO_THREADS=6`, four
  did not. Gateway hosts must run more worker threads than cores, and many computing Sessions still
  share the CPU.
- Every tool call costs an RPC round trip and serialises its arguments and result.
- Each active Session may hold two loaded Workers, codemode and the Sandbox, against the loader's
  admission limit.

## Rejected alternatives

- **Keep the VM inline and lower the interrupt budget**: cheapest, but the budget is cooperative,
  the parent has no CPU limit, and an escape lands beside the Session's credentials.
- **A separately deployed sandbox Worker**, as Pi recommends for Cloudflare: it adds a Worker to
  deploy and bind, and celld already isolates
  a loaded facet's thread, and a fixed Worker would serve every Session from shared instances
  instead of one isolate per Session.
- **A loaded `WorkerEntrypoint` instead of a facet**: measured the same, but needs our own class
  around `serveCodemodeRemote`; the facet runs Pi's class as it is.
- **Codemode in `@openorb/environments`** beside the Sandbox, to share its lifecycle code: it would
  put a Harness tool behind the Agent Environment Provider boundary. The two lifecycles share code
  only if both grow.
