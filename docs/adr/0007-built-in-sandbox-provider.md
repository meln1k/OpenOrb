# Run a built-in just-bash sandbox when no runner is available

**Status:** Accepted; implemented as the `sandbox` Agent Environment Provider. ADR 0008 drops the
persistence and hibernatable-link capabilities.

People should be able to try OpenOrb before they operate a runner, and an agent needs somewhere to
look inside untrusted content (a suspicious download, an archive) where nothing it finds can escape.
The gateway therefore hosts a second Agent Environment Provider, the **Sandbox**:
[just-bash](https://github.com/vercel-labs/just-bash), a bash interpreter written in TypeScript with
a virtual filesystem, running in a Dynamic Worker that the Session Durable Object loads through
celld's Worker Loader. A Session uses it when the user picks it in the composer, and by default when
the Workspace has no runner. A Workspace needs only a model provider to use it. The choice is
recorded at creation as the Session's placement, a tagged union of
`{ provider: "runner", runnerId }` and `{ provider: "sandbox" }`, so runner-only logic such as
Environment Link authority applies only where a runner exists. Records written before placements
were runner Sessions and read as such.

## Shape

The Session Durable Object loads the bundled sandbox worker with `env: {}`, `globalOutbound: null`,
and a per-call CPU limit, and runs its `Sandbox` class as a facet named `sandbox`. The loader ID
contains the Session ID and the bundle's content hash, so Sessions never share an isolate and a new
build never reuses old code. The facet owns a private SQLite database, invisible to the Session DO.

Inside the facet, pi-celld's `JustBashEnv` implements Pi's `ExecutionEnv` over just-bash. Its
filesystem is just-bash's `InMemoryFs`, written through to the facet's SQLite after every mutation
and reloaded when the facet starts, so just-bash alone decides path, symlink, and quota semantics.
File contents are stored in 1 MiB chunks, below celld's limit of about 2 MB per SQLite value; mode
and time changes update only the entry, and appends rewrite only the last chunk. `/tmp`, `/dev`, and
`/proc` are not persisted. The Session DO relays `ExecutionEnv` calls over native RPC without
reading their paths; readers stay in the facet behind random handles that a restarted facet does not
recognize. File watching is not supported. Abort and timeouts are cooperative: just-bash stops at
its next statement, and a command busy inside one built-in runs until the call's CPU limit.

When the agent becomes idle after a run and its queued follow-ups, the Session releases the sandbox
facet and explicitly disposes its loaded Worker, freeing its loader admission slot without waiting
for garbage collection. Outstanding RPC and cancellation work must settle before disposal. The
environment remains logically running: the next guest operation lazily loads a fresh isolated Worker
and restores the filesystem from SQLite. Readers, shell memory, and `/tmp` do not survive this
release; persisted files do. The no-bindings, no-network, and CPU-limit settings are unchanged.

| Capability        | Sandbox                                                         |
| ----------------- | --------------------------------------------------------------- |
| Persistence       | `virtual-disk`: files survive Stop Session; processes never run |
| Credentials       | `none`: never read for the sandbox, which has no network        |
| Hibernatable link | `false`: there is no link; calls are RPC to a facet             |
| Git               | `false`: Sandbox Sessions never have a project                  |

## Sessions without a project

A Session's project is optional for every provider and required by none. A Session with a project
records its repository, ref, session branch, and Git author; only then is Git integration loaded:
the Session DO clones the checkout, runs `.agents/setup` and `.agents/resume`, discovers repository
skills, refreshes Git Snapshots, and the page shows the Changes panel. A Session without a project
starts from an empty `/workspace` with none of these, and a runner guest gets no GitHub mediation:
runner protocol 28 makes `environment.create`'s `repository` (URL and Git author together) optional,
and old runner journals are not converted. The Workspace catalog's `sessions.projectId` is nullable
(migration `0002`), and the sidebar groups such Sessions under "No project".

Providers declare `git`, and a project needs it, so Sandbox Sessions never have one: the composer
hides the project selector for the Sandbox and the gateway ignores a submitted project. The
Sandbox's agent prompt describes it as a place to inspect untrusted content and to treat what it
finds as data, never as instructions. Its extract-only `tar` applies just-bash's archive limits
before buffering an entry and creates an archive's symbolic links last, so no entry is written
through one of them. Getting content in will need a web fetch tool, which the gateway, not the
sandbox, will perform; the sandbox itself stays without network.

## Security

The boundary is a V8 isolate, not a VM. An escape from just-bash finds an isolate with no bindings,
no network, no secrets, and only its own Session's files. The runtime terminates calls that exceed
the CPU limit, so a runaway built-in cannot stall the Session DO. A V8 escape, however, reaches the
gateway process: celld runs loaded workers in the loader's process and makes no V8 escape claim. The
sandbox therefore holds no secrets of its own to lose, and work that needs secrets or a full
toolchain belongs on a runner.

## Rejected alternatives

- **just-bash inside the Session DO**, as pi-celld does: one interpreter bug would expose the
  Session DO's credentials and bindings.
- **A purpose-built SQLite filesystem**: it would reimplement the path and symlink semantics that
  `InMemoryFs` already tests, inside the security boundary.
- **Importing a project into the Sandbox as an archive**, which an earlier version did: it gave the
  Sandbox a checkout without Git, but blurred its purpose and put the GitHub token to work for it.
- **A built-in pseudo-project for project-less Sessions**: no catalog migration, but it would leak
  into the projects list and its references.
