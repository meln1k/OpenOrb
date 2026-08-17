# OpenOrb

![OpenOrb logo](logo.png)

OpenOrb is an open-source, self-hostable control panel and runner for Pi coding-agent sessions on user-owned compute. The control panel currently includes password authentication, credential/project configuration, and reusable-PSK runner enrollment over one authenticated outbound WebSocket. Coding sessions arrive in later tickets.

## Tooling and prerequisites

- Deno **2.9.5 exactly**
- PostgreSQL for the control panel and its tests
- QEMU/KVM for the runner

Node.js, npm, and pnpm are not used by OpenOrb. Dependencies published to npm are resolved and installed by Deno from exact `npm:` imports. Deno owns the generated local `node_modules` tree required by Remix's browser-asset compiler; OpenOrb retains no `package.json`, and no npm tooling or Node.js runtime is required.

The repository's orb setup installs QEMU for the orb architecture. Outside an orb, install QEMU for
the host architecture:

```sh
# Debian/Ubuntu x86-64
sudo apt install qemu-system-x86

# Debian/Ubuntu ARM64
sudo apt install qemu-system-arm

# Optional macOS local harness
brew install qemu
```

Development primarily uses Linux Amp orbs. The macOS runner entry point remains an optional temporary
local harness, not a supported release target. Release runners target glibc Linux x86-64 and ARM64;
musl hosts are not supported. The current Deno 2.9.5 artifacts require glibc 2.27 or newer. `gh`
belongs in the guest developer image introduced by OO-009, not on the runner host.

## Install and run

From a clean checkout, resolve the frozen Deno graph, provide PostgreSQL and a session-cookie signing secret, and start the control panel:

```sh
deno install --frozen
export DATABASE_URL=postgres://localhost/openorb
export SESSION_SECRET="replace-with-a-long-random-secret"
deno task dev:control
```

The control page is available at <http://localhost:44100>, with process health at <http://localhost:44100/healthz>. On a fresh database, open the control page to complete administrator setup. Open **Settings → Runners** and copy the always-present runner-enrollment command, which includes the control URL and current PSK. The equivalent command is:

```sh
deno task dev:runner --control-panel http://localhost:44100 \
  --enrollment-token "$OPENORB_ENROLLMENT_PSK" \
  --name "Development runner"
```

The runner stores `runner.json` and a mode-`0600` bearer-token file in the ignored `.openorb-runner-dev/` working directory. The PSK is not retained or reused as runner identity. After first enrollment, `deno task dev:runner` reconnects with the stored bearer token. The harness opens one outbound WebSocket and no inbound listener.

After enrollment, run both development processes together or separately:

```sh
deno task dev:control
deno task dev:runner
```

`deno task dev` runs both processes. A deployed control process uses `deno task --filter @openorb/control start`; production Linux runners use the standalone artifacts described below. Use the Deno version pinned in `.tool-versions`; individual tasks do not perform a separate runtime version check.

## Local observability

OpenOrb uses Deno's built-in OpenTelemetry integration. For local traces and trace-correlated
`console` logs, install the pinned [Motel](https://github.com/kitlangton/motel) development tool and
run the instrumented tasks:

```sh
bun add --global @kitlangton/motel@0.2.6
motel start
deno task dev:otel
```

Motel listens on `http://127.0.0.1:27686`; query its health and discovered OpenOrb services with:

```sh
curl http://127.0.0.1:27686/api/health
curl http://127.0.0.1:27686/api/services
```

In an Amp orb, `amp orb services ensure` supervises Motel and the instrumented control process.
The project-local `motel-debug` agent skill documents the evidence-driven debugging workflow and
query API.

The application processes remain Deno-only. Motel 0.2.6 itself requires Bun 1.3 or newer because
its HTTP server uses `@effect/platform-bun`; it cannot currently be launched by Deno without
porting Motel. Motel does not ingest metrics, so `dev:otel` disables Deno's metric signal while
exporting traces and logs. Production can enable all Deno OpenTelemetry signals and select any
OTLP collector through the standard `OTEL_*` environment variables.

## Required development database reset

OO-001A replaces the unreleased Argon2 development schema with the fixed PBKDF2 profile, and user IDs now use UUIDv7 instead of integers. Existing development users, password credentials, browser sessions, encrypted credentials, Git configuration, and projects are intentionally incompatible. Reset the development and test databases once before using this revision; startup never deletes them automatically:

```sh
dropdb --if-exists openorb && createdb openorb
dropdb --if-exists openorb-test && createdb openorb-test
```

Then restart the control panel and recreate the administrator and configuration. There is no legacy-password, dual-KDF, or integer-user-ID compatibility path.

## Checks

```sh
deno task check  # formatting, linting, and typechecking
deno task test
```

Run `deno fmt` directly to format files.

Tests use `postgres://localhost/openorb-test`, do not start a VM, and do not require QEMU.

## Standalone Linux runner artifacts

Build both GNU Linux targets with the pinned Deno compiler and produce checksums/ELF metadata:

```sh
deno task release:runner
```

Outputs:

- `dist/openorb-runner-linux-x64` (`x86_64-unknown-linux-gnu`)
- `dist/openorb-runner-linux-arm64` (`aarch64-unknown-linux-gnu`)
- `dist/SHA256SUMS`

The executables contain denort and do not need an installed Deno or Node executable. They must start from the canonical runner working directory; `--data-dir` is intentionally unsupported. Production compilation bakes in runner-directory read/write access, unrestricted network access, `PATH`/`PWD` environment access, and only the architecture-appropriate `qemu-system-*` plus `qemu-img` subprocess permission. It does not grant `--allow-all` or FFI.

Guest VM assets are not embedded in the standalone executables. The runner installs the architecture-specific pinned developer image under its canonical working directory, verifies its byte count, SHA-256, Gondolin build ID, architecture, and internal asset checksums, and passes only those explicit local paths to Gondolin. See [the developer image release process](docs/developer-image.md).

## Pinned Remix scaffold

The control application uses `remix@3.0.0-beta.6` (source tag commit `2949a5994ab98d0847abd3ed75c6473736375c7e`). `deno.json` and `deno.lock` pin that package exactly; upgrades must be explicit.
