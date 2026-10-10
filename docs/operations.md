# Gateway and runner operations

## Native celld Worker migration

The gateway webapp runs in the stateless Worker and calls named RPC methods on `Workspace` and
`Runners` Durable Objects. Both extend native `DurableObject` from `cloudflare:workers` without a
compatibility flag. Workspace owns SQLite-backed configuration, browser sessions, enrollment
records, the Session catalog, and alarm-driven provider OAuth. Runners owns live control/bulk
WebSockets, runner presence, command routing, and viewer subscriptions. Only WebSocket upgrades and
SSE use DO `fetch`; no public generic Workspace RPC endpoint exists.

Workspace uses relational tables through native `ctx.storage.sql`, not KV entity records. Remix Data
table declarations and inferred row types live in `packages/gateway/app/cells/workspace/schema.ts`.
Plain SQL migrations live in `packages/gateway/app/cells/workspace/migrations/<id>_<name>/up.sql`;
the initial migration enforces indexes, unique constraints, and Workspace-scoped foreign keys.
Register each migration in `packages/gateway/app/cells/workspace/migrations.ts`, which imports SQL
as text bundled into the Worker and applies it through Remix's migration journal and checksum checks
inside one native storage transaction. `blockConcurrencyWhile` gates startup. Add numbered
migrations and update row declarations for schema changes; never edit applied SQL, including
whitespace, because Remix checksums the exact bytes. The former integer-ledger bootstrap is
unsupported; use fresh state instead of upgrading it. Ciphertext and password hashes are BLOBs. Only
browser session dictionaries, allowed-host lists, and private OAuth checkpoints use JSON fields. SQL
and OAuth alarm changes commit together in awaited storage transactions.

Runner Registry state is ephemeral: normal accepted sockets keep the object live, not hibernating.
Restart/eviction disconnects runners and viewers; runner reconnect/manifests and browser reconnect
rebuild live state. Full Pi sessions remain runner-owned. Pi AI, Pi Durable, Pi Env, and Chord are
pinned to 1.1.0; the configuration object does not create a Pi harness.

Orb setup installs celld 0.6.2 and esbuild 0.28.2. Run `amp orb services ensure`, or outside an orb
`deno task dev:gateway`, to build and start the single public gateway Worker. Dev state lives in
`packages/gateway/.celld/dev` and persists across restarts. The former
`packages/workspace/.celld/dev` is not migrated or deleted; the relocated config starts fresh. The
gateway's local `.env` supplies `OPENORB_MASTER_KEY` and `SESSION_SECRET`; `PUBLIC_URL` and
`OPENORB_SESSION_COOKIE_SECURE` configure browser origins/cookies. Preparation copies these bindings
into the ignored `packages/gateway/.dev.vars` with mode 0600. `OPENORB_WORKSPACE_URL` is obsolete.
Authentication, CSRF, and runner-token validation remain enforced in the public Worker/DO paths.

Browser assets and model metadata are compiled at build time; Worker requests use the `ASSETS`
binding and need no filesystem/compiler. The build writes `dist/worker.js` and `dist/assets` beside
`packages/gateway/wrangler.jsonc`, because celld requires deployable files inside the config
directory. Gateway/registry logs use the runtime console. The former Deno OTLP exporter is no longer
initialized; GoTel remains available for runner telemetry.

After changing Worker bindings, run `deno task --filter @openorb/gateway generate-types` and commit
`packages/gateway/worker-configuration.d.ts`. Wrangler generates `Env`, including the typed
`WORKSPACE` and `RUNNERS` namespaces and environment binding names, without recording secret values.
`deno task check` checks that the generated types are current. Deno uses a test base class; bundles
retain the native `cloudflare:workers` import.

Back up the original secrets and `packages/gateway/.celld/dev` together after stopping celld. Never
delete that state or use a clean/reset operation against wanted data. PostgreSQL is no longer opened
by the gateway. Existing PostgreSQL data is not imported. This is a clean break: former Workspace KV
records are not read or imported either. The new tables initially present setup; projects,
credentials, runner enrollment, and catalog configuration must be recreated. Old KV records are left
untouched, not silently deleted. Removing PostgreSQL from CI/orb prerequisites does not stop,
uninstall, or delete an existing database.

The supported commands here describe the local native Worker runtime, not a production celld fleet
rollout. The former Deno HTTP service, PostgreSQL migrations, and `pg_dump`/`pg_restore` deployment
recipe no longer apply. Production fleet provisioning, secret injection, storage/replication,
backup/restore, and PostgreSQL-to-DO transfer need an explicit reviewed procedure before promotion;
this guide does not choose those interfaces.

## Release pins

Treat the gateway, runner, and protocol as one release unit. Check out the same reviewed full commit
SHA on the gateway and every source-installed runner; do not mix independently updated checkouts.
Record it before deployment with `git rev-parse HEAD`, and use that value (not a branch name) as the
release revision. A standalone runner must come from the release for that same source revision.
Protocol version **25** is source-owned and is not a separately upgradeable public API.

The exact runtime and application pins in this release graph are:

| Component                           | Pin                                              |
| ----------------------------------- | ------------------------------------------------ |
| Deno / standalone runner denort     | 2.9.5                                            |
| celld / esbuild                     | 0.6.2 / 0.28.2                                   |
| Gondolin                            | 0.12.0                                           |
| OpenOrb guest image                 | `release-1` (Debian snapshot `20260803T000000Z`) |
| Pi AI / Pi Durable / Pi Env / Chord | 1.1.0                                            |
| Remix                               | 3.0.0                                            |
| Runner protocol                     | 25                                               |

The lockfile is authoritative for the complete transitive graph. The image's architecture-specific
build IDs, hashes, sizes, and immutable URLs are in
`packages/runner/src/environment/gondolin/guest-image/release.ts`; follow the
[guest image release process](guest-image.md), rather than rebuilding an asset under an existing
release ID.

Protocol 25 uses UTF-8 JSON inside SchemaBinary framing on the binary control WebSocket. Runner and
gateway must be upgraded together; neither the former CBOR format nor unframed JSON text messages
are supported. Logical control messages are capped at 16 MiB and split into WebSocket messages of at
most 1 MiB. Reassembly is per connection and is discarded on disconnect; reconnect still obtains a
fresh conversation snapshot. Images and Git patches continue to use the separate bulk channel.
Chunking does not make arbitrarily large conversations unbounded or remove the need for compaction.

Streaming RPC handlers emit one event per RPC envelope, so queue batching cannot combine
individually valid events into an oversized message. The control transport owns its limits; the
outbound adapter only reconnects. Bulk retains its own frame limit. Values use Effect's JSON schema
codecs, including strings for schema-declared bigints. Ordinary numbers retain JavaScript's usual
precision limits; there is no custom numeric conversion.

Prompt acknowledgements carry the Durable `submissionId` and echoed `clientRequestId`, not a run
group or admission mode. Duplicate request IDs return the existing submission without resuming
paused agent work. Abort targets the Session's conversation and leaves its environment running.
Runner snapshots and session events no longer carry synthetic run IDs.

## Build and run the native gateway locally

Install Deno 2.9.5, then run `bash scripts/install-celld.sh` for the reviewed celld/esbuild pins and
`deno install --frozen` for the build graph. Orb setup handles these prerequisites automatically and
preserves existing `packages/gateway/.env`. For a fresh local checkout, copy
`packages/gateway/.env.example` only if `.env` is absent, restrict it to mode 0600, and edit the two
secrets. Generate them independently with `openssl rand -hex 32`; never regenerate either for wanted
state. `.env` is preparation input, while `.dev.vars` contains the actual celld dev bindings.

Outside an orb, `deno task dev:gateway` prepares bindings, builds, and runs celld on loopback port
44100. In an orb, use `amp orb services ensure` for supervised GoTel/gateway services and the
gateway portal URL. The gateway package's `start` task uses already-built bytes and prepared
bindings; `deno run packages/gateway/server.ts` is not a server startup command. A build alone does
not start celld or rewrite `.dev.vars`:

```sh
deno task --filter @openorb/gateway build
```

`packages/gateway/wrangler.jsonc` declares `WORKSPACE`, `RUNNERS`, `ASSETS`, and the native SQLite
class migrations. Do not change the named objects or run two celld processes against its state
directory. Worker/assets build output is replaceable; keep wanted `.celld/dev` state with its keys.

For a separately approved HTTPS deployment, the public origin must be configured consistently (for
example `PUBLIC_URL=https://openorb.example.com` and `OPENORB_SESSION_COOKIE_SECURE=true`). The
HTTPS front end must support runner WebSocket upgrades and browser SSE without buffering. Do not
expose celld's internal peer/operator listener to the public; the runtime describes it as
unauthenticated. These are security constraints, not a fleet installation recipe. Verify `/healthz`,
first-run/authenticated browser routes, and runner enrollment after starting the native runtime; a
healthy HTTP response alone does not prove durable configuration or runner routing.

## First-run configuration and runner enrollment

Open the HTTPS origin and complete first-run setup, which atomically creates one Workspace and the
single administrator. Retain a strong administrator password. Credentials, projects, runners, and
enrollment PSKs belong to the Workspace; passwords and Git author identity belong to the user. There
is no Workspace-selection UI. In **Settings**, add the credentials and project:

- For OpenCode Go, obtain an API key from your OpenCode Go account and save it as provider ID
  `opencode-go`. The default model is `opencode-go/deepseek-v4-flash`; never put the key in the
  runner environment or guest.
- Prefer a fine-grained GitHub personal access token restricted to the one selected private
  repository. Grant **Contents: Read and write** (metadata read access is implicit); grant no
  organization, administration, Actions, Packages, or account permissions. This supports clone,
  fetch, commit, and branch push. Add further permissions only if a separately reviewed workflow
  actually requires them. Store the repository's HTTPS `.git` URL in the project.

Create an enrollment PSK in **Settings → Runners**, then follow the complete
[Linux runner installation and enrollment guide](runner-installation.md). Give a NATed runner the
public `https://openorb.example.com` origin. It makes one outbound HTTPS/WebSocket connection and
requires no inbound port.

## Local gateway state backup and recovery

For the local `celld dev` runtime, stop the gateway process before copying or snapshotting the
entire `packages/gateway/.celld/dev` directory. Keep all SQLite/WAL sidecars together; a copy of a
live database or only one SQLite file is not a coordinated backup. Record the matching source
revision and keep the original `OPENORB_MASTER_KEY` and `SESSION_SECRET` in protected secret
storage. The private `.env`/`.dev.vars` files must not enter commits, ordinary logs, or public asset
output.

Restore only into a stopped, isolated matching checkout/config directory with its original secrets,
rebuild deployable bytes, and start celld there. Verify browser login, stored configuration, and
enrollment before any real runner can connect. Local directory backup is not a celld fleet backup
contract, Session portability, or HA. Production replication/restore remains separately undecided.

Losing or changing `OPENORB_MASTER_KEY` makes encrypted credentials in Workspace SQLite unreadable;
manual credential replacement is then required. Changing `SESSION_SECRET` invalidates browser
cookies and requires login again; it does not decrypt credentials. Workspace state loss removes
users, browser sessions, projects, encrypted credentials, enrollment, and the minimal Session
catalog. Runner files cannot reconstruct that configuration. Runners DO live projections are not a
Session backup: restart drops connections and reconnect/manifests rebuild them from the
authoritative runner. No master-key rotation or PostgreSQL import procedure is implemented.

## Runner session-file backups

Runner identity and session state live only under `/var/lib/openorb-runner`. For a consistent
file-level backup, stop the runner, copy or snapshot the **entire directory as one unit**, then
start it again. Restore it only to the same trusted runner identity and the matching pinned OpenOrb
and guest-asset release, preserving owner `openorb-runner`, directory mode `0700`, and identity-file
mode `0600`.

Do not claim a crash-consistent copy of a running directory is a session backup. Durable's
`harness/harness.sqlite` and its WAL/SHM sidecars, each session's `root-disk.qcow2`, deletion
markers, and Session Journals can change independently while a session runs. QEMU mutates the
persistent root disk in place while its VM is running, so copying it concurrently can produce a
corrupt or internally inconsistent backup. Stop the service first; filesystem snapshots alone do not
coordinate with an active VM.

Even a consistent runner backup is not a gateway backup and does not make sessions portable or
provide migration/HA. Keep the matching guest assets or allow the same immutable release assets to
be downloaded and verified. After restore, run `doctor` before starting the service. A missing or
corrupt `root-disk.qcow2` prevents that Session from being resumed; the Project Checkout is on that
disk, not separately stored on the host. The explicit **Restart environment** recovery reopens the
preserved disk after a Stop durability or VM-start failure and never substitutes an older copy.

Pi Durable is a clean break from the former Pi JSONL format. Old development sessions are not
converted; create new sessions after upgrading. Stop Session pauses checkpointed agent work and
durably stops compute; Wake resumes it. Abort cancels work without stopping compute. Agent-issued
environment restart can force a hung VM to close and reports possible loss of unsynced writes.
Conversation stream subscriptions/reconnects are read-only and never wake the Session. Opening a
Session page separately sends an authenticated, CSRF-protected Wake request.

## Troubleshooting

- **Gateway will not start:** inspect the supervised gateway's logs (`amp orb service logs gateway`
  in an orb) or celld's console. Verify the celld/esbuild pins, built `dist/worker.js` and assets,
  private `.dev.vars`, and both secrets. Build errors belong to the Deno build, not Worker requests.
  Do not generate a replacement master key or remove `.celld` to fix a startup error.
- **HTTPS or runner connection fails:** check `curl https://…/healthz`, the HTTPS front end's
  certificate and logs, DNS, that `PUBLIC_URL` is the public HTTPS origin, and that the proxy
  supports WebSocket upgrades. The runner must use that public origin, while port 44100 remains
  private.
- **Runner is offline:** run the installation guide's `doctor`, then inspect
  `journalctl -u openorb-runner`. Check outbound DNS/HTTPS, system time, QEMU, free disk, and that
  its identity has not been revoked. A KVM startup warning means the runner is online but sessions
  use slower TCG software emulation. A `nested-kvm.unavailable` warning means the session continues
  without guest `/dev/kvm`; enable host nesting only if the workload needs it.
- **Image verification fails:** stop the runner and follow the narrowly scoped removal/re-download
  procedure in [guest image recovery](guest-image.md#runner-installation-and-recovery). Never edit
  an installed image or reopen a persistent root disk with a different image release.
- **Private clone/push gets 403:** confirm the token is restricted to the selected repository with
  Contents read/write, has not expired, and is approved for any organization SSO policy. Rotate it
  in gateway Settings, not on the runner.
- **Provider authentication fails:** confirm the provider ID is `opencode-go`, the key is active,
  and the selected `provider/model` is available to that account.

## Intentional upgrades

Never upgrade a production host by following a moving branch. Back up gateway state/keys and runner
state under the applicable reviewed recovery contract. Review the candidate commit and lockfile
diff, and every Deno, celld, esbuild, Gondolin, guest image, Pi, Remix, protocol, Worker binding,
SQLite migration, and runner systemd change. Follow the Gondolin TLS compatibility gate in the
[runner release process](runner-release.md) and the separate guest-image publication process. Run
`deno install --frozen`, `deno task check`, `deno task test`, `deno task test:gondolin`, and native
x86-64/ARM64 release smoke checks as applicable. Exercise backup restoration and the complete
private-repository stop/resume/delete path in the [release acceptance guide](release-acceptance.md)
before promotion.

For the local runtime, stop gateway and runners, install the same approved source revision/release
artifacts, rebuild the frozen graph, then restart and run gateway health and runner `doctor` checks.
Preserve the config path, named objects, state, and both secrets. Production promotion additionally
requires the reviewed celld fleet/data-transfer procedure, not the obsolete PostgreSQL/Deno service
recipe. Rollback is only safe when SQLite migrations, protocol, runner state, persistent root disks,
and guest assets are compatible with the reviewed older release; there is no general downgrade
guarantee.
