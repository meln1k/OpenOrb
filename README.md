# OpenOrb

![OpenOrb logo](logo.png)

OpenOrb is an open-source, self-hosted environment for running Pi coding-agent sessions on your own
compute. Its browser gateway stores projects and encrypted credentials, enrolls runners, streams
conversations, and presents Git changes. Each runner executes untrusted session work inside a
Gondolin QEMU/KVM virtual machine and connects outbound to the gateway; runners need no inbound
port.

## How OpenOrb runs

A complete installation has two processes:

- **Gateway:** Deno web application backed by PostgreSQL. It serves the UI and coordinates runners.
- **Runner:** Deno or standalone Linux service that owns session state and Gondolin VMs.

The gateway currently runs from a source checkout. Choose either runner installation:

| Runner installation | Best for | Deno required on runner host? | Updates |
| --- | --- | --- | --- |
| [Source checkout](#linux-source-runner) | Simple self-hosting and MVP+ iteration | Deno 2.9.5 exactly | Pull the checkout, install the frozen graph, restart |
| [Standalone artifact](#linux-standalone-runner) | Minimal production host | No | Replace the verified executable, restart |

Both Linux options use the same hardened systemd unit and the same persistent
`/var/lib/openorb-runner` state. You can switch between them without re-enrolling the runner.

## Requirements

- Deno **2.9.5 exactly** for the gateway, development, and source runner installation
- PostgreSQL for the gateway
- QEMU/KVM and `/dev/kvm` for runners
- glibc 2.27+ Linux on x86-64 or ARM64 for production runners

OpenOrb does not invoke the Node.js, npm, or pnpm CLIs. Deno resolves the pinned npm and JSR
dependencies and owns the generated `node_modules` tree. Alpine Linux and other musl distributions
are not supported runner hosts. macOS can use the temporary development harness, but it is not a
release target.

## Run the complete project from source

This is the quickest local setup. Install Deno 2.9.5, PostgreSQL, and QEMU, then clone and prepare
the frozen dependency graph:

```sh
git clone https://github.com/meln1k/openorb.git
cd openorb
deno --version # first line must be: deno 2.9.5
deno install --frozen
```

Create the gateway database and configuration:

```sh
createdb openorb
cp packages/gateway/.env.example packages/gateway/.env
```

Edit `packages/gateway/.env` and set all three required values:

```dotenv
DATABASE_URL=postgres://localhost/openorb
SESSION_SECRET=<long random session-cookie secret>
OPENORB_MASTER_KEY=<64 hexadecimal characters from: openssl rand -hex 32>
```

Start the gateway:

```sh
deno task dev:gateway
```

Open <http://localhost:44100>, create the first administrator, then configure a model provider,
GitHub, and a project. Open **Settings → Runners** and copy the gateway URL and enrollment PSK. In a
second terminal, enroll the temporary development runner:

```sh
read -rsp 'Enrollment PSK: ' OPENORB_ENROLLMENT_PSK; printf '\n'
deno task dev:runner --gateway http://localhost:44100 \
  --enrollment-token "$OPENORB_ENROLLMENT_PSK" \
  --name "Development runner"
unset OPENORB_ENROLLMENT_PSK
```

The runner exchanges the PSK for a bearer identity and stores it with mode `0600` under the ignored
`.openorb-runner-dev/` directory. Subsequent launches need no enrollment arguments:

```sh
deno task dev
```

`deno task dev` runs the gateway and development runner together. Use `dev:gateway` and `dev:runner`
when you want separate processes.

## Run OpenOrb on Linux

The gateway still launches from its checkout. Configure `packages/gateway/.env` as above, prepare
the frozen graph, and run the production task under your process supervisor:

```sh
deno install --frozen
deno task --filter @openorb/gateway start
```

The server listens on port `44100` by default and applies committed database migrations at startup.
For a concrete source-checkout systemd and Caddy deployment, PostgreSQL and secret backup/restore,
credential scope, runner backup limitations, troubleshooting, release pins, and upgrades, follow
the [production operations guide](docs/operations.md). Then install at least one runner using either
option below. The runner needs the externally reachable HTTPS gateway origin, not a loopback URL
when it is on a different host.

Before promotion, follow the [release acceptance guide](docs/release-acceptance.md) for CI policy,
the secret-gated private-repository lifecycle, and test traceability.

### Linux source runner

Use this option when easy source upgrades matter. On the runner host, install Git, Deno 2.9.5, and
the architecture-appropriate QEMU package. Keep the checkout root-owned at `/opt/openorb`:

```sh
sudo git clone https://github.com/meln1k/openorb.git /opt/openorb
sudo install -d -o root -g root -m 0755 /var/cache/openorb-runner/deno
sudo env DENO_DIR=/var/cache/openorb-runner/deno \
  /usr/local/bin/deno install --frozen \
  --config=/opt/openorb/deno.json \
  --lock=/opt/openorb/deno.lock \
  --entrypoint /opt/openorb/packages/runner/src/standalone.ts
sudo chmod -R a+rX /opt/openorb /var/cache/openorb-runner/deno
```

Install the shared `openorb-runner.service` and the architecture-specific source override from the
checkout. The override invokes `/usr/local/bin/deno run` directly with a frozen, cached dependency
graph and the runner's narrow production permissions. It is not a shell wrapper.

For the exact service-account, QEMU, unit, `doctor`, and enrollment commands, follow
[Linux runner installation — source checkout](docs/runner-installation.md#2b-install-from-a-source-checkout).
Then launch it with:

```sh
sudo systemctl enable --now openorb-runner.service
```

To update this installation:

```sh
sudo systemctl stop openorb-runner.service
sudo git -C /opt/openorb pull --ff-only
sudo env DENO_DIR=/var/cache/openorb-runner/deno \
  /usr/local/bin/deno install --frozen \
  --config=/opt/openorb/deno.json \
  --lock=/opt/openorb/deno.lock \
  --entrypoint /opt/openorb/packages/runner/src/standalone.ts
sudo chmod -R a+rX /opt/openorb /var/cache/openorb-runner/deno
sudo systemctl daemon-reload
sudo systemctl start openorb-runner.service
```

Prefer a reviewed tag or commit over a moving branch when reproducibility matters.

### Linux standalone runner

Use this option when the runner host should not contain Deno, Git, Node.js, or the repository. A
release provides:

- `openorb-runner-linux-x64`
- `openorb-runner-linux-arm64`
- `openorb-runner.service`
- `SHA256SUMS`

Verify `SHA256SUMS`, install the matching executable as `/usr/local/bin/openorb-runner`, install the
unit, run `doctor`, enroll once, and start systemd. Complete commands are in
[Linux runner installation — standalone artifact](docs/runner-installation.md#2a-install-the-standalone-artifact).

```sh
sudo systemctl enable --now openorb-runner.service
```

The executable embeds denort and the frozen application graph. Guest images remain separate: the
runner downloads the pinned architecture-specific image and verifies its size, SHA-256, Gondolin
build ID, architecture, and internal checksums before use.

### Runner behavior shared by both installations

- `WorkingDirectory` is `/var/lib/openorb-runner`; `--data-dir` is intentionally unsupported.
- Identity, sessions, and completed checkpoints survive service and installation-mode changes.
- There is no default CPU, memory, or session-count ceiling.
- Deno has no FFI or `--allow-all` permission and can execute only the native QEMU suite.
- QEMU, not Deno, opens `/dev/kvm`; systemd grants only that device.
- The runner uses one authenticated outbound WebSocket and reconnects automatically.

## Development

### Checks

```sh
deno task check
deno task test
deno task test packages/protocol/test/runner-api.test.ts # focused test
deno task test:gondolin                                 # QEMU integration suite
```

Always pass tests through `deno task test`; the task owns the required permissions and environment.
Unit tests use `postgres://localhost/openorb-test` by default and do not start a VM.

### Development database reset

The unreleased PBKDF2 and UUIDv7 schema is intentionally incompatible with older development data.
If upgrading from the pre-OO-001A schema, reset both databases once:

```sh
dropdb --if-exists openorb && createdb openorb
dropdb --if-exists openorb-test && createdb openorb-test
```

Startup never deletes application data automatically.

### Local observability

Development tasks export OTLP/HTTP protobuf traces and Deno-captured logs to
[Motel](https://github.com/kitlangton/motel) at `http://127.0.0.1:27686`. Motel 0.2.6 itself requires
Bun 1.3 or newer; OpenOrb application processes remain Deno-only.

```sh
bun add --global @kitlangton/motel@0.2.6
motel start
deno task dev
```

In an Amp orb, `amp orb services ensure` supervises the configured development services.

## Build standalone runners

With Deno 2.9.5 and the frozen graph installed:

```sh
deno task release:runner
```

The command cross-compiles both GNU/Linux architectures, verifies their ELF architecture and glibc
baseline, copies the hardened service unit, and writes `dist/SHA256SUMS`. Native QEMU/KVM smoke
testing is still required on each target architecture before publishing a release. See the
[runner release process](docs/runner-release.md) and [guest image release process](docs/guest-image.md).

The gateway pins `remix@3.0.0-beta.10`; dependency and Deno upgrades are explicit, reviewed changes
to `deno.json`, `deno.lock`, and `.tool-versions`.
