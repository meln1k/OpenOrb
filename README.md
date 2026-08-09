# OpenOrb

OpenOrb is an open-source, self-hostable control panel and runner for Pi coding-agent sessions on user-owned compute. The control panel currently includes the OO-002 single-admin setup and password-authenticated browser shell; runner enrollment and coding sessions arrive in later tickets.

## Tooling and prerequisites

- Deno **2.9.5 exactly**
- PostgreSQL for the control panel and its tests
- QEMU/KVM for the runner

Node.js, npm, and pnpm are not used by OpenOrb. Dependencies published to npm are resolved and installed by Deno from exact `npm:` imports. Deno owns the generated local `node_modules` tree required by Remix's browser-asset compiler; OpenOrb retains no `package.json`, and no npm tooling or Node.js runtime is required.

Install QEMU for the host architecture:

```sh
# macOS development harness
brew install qemu

# Debian/Ubuntu ARM64
sudo apt install qemu-system-arm

# Debian/Ubuntu x86-64
sudo apt install qemu-system-x86
```

The macOS runner entry point is a temporary development harness. Release runners target glibc Linux x86-64 and ARM64; musl hosts are not supported. The current Deno 2.9.5 artifacts require glibc 2.27 or newer. `gh` belongs in the guest developer image introduced by OO-009, not on the runner host.

## Install and run

From a clean checkout, resolve the frozen Deno graph, provide PostgreSQL and a session-cookie signing secret, and start both processes:

```sh
deno install --frozen
export DATABASE_URL=postgres://localhost/openorb
export SESSION_SECRET="replace-with-a-long-random-secret"
deno task dev
```

The control page is available at <http://localhost:44100>, with process health at <http://localhost:44100/healthz>. On a fresh database, open the control page to complete administrator setup. The runner harness uses the ignored `.openorb-runner-dev/` directory as its working directory and only checks prerequisites; it does not fake enrollment or session behavior.

Run either development process separately when needed:

```sh
deno task dev:control
deno task dev:runner
```

`deno task dev` runs both processes. A deployed control process uses `deno task --filter @openorb/control start`; production Linux runners use the standalone artifacts described below. Use the Deno version pinned in `.tool-versions`; individual tasks do not perform a separate runtime version check.

## Required development database reset

OO-001A replaces the unreleased Argon2 development schema with the fixed PBKDF2 profile. Existing development users, password credentials, and browser sessions are intentionally incompatible. Reset the development and test databases once before using this revision; startup never deletes them automatically:

```sh
dropdb --if-exists openorb && createdb openorb
dropdb --if-exists openorb-test && createdb openorb-test
```

Then restart the control panel and create the administrator again. There is no legacy-password or dual-KDF verification path.

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

Guest VM assets are not embedded in the standalone executables. Their release metadata, acquisition, verification, and Gondolin integration are deferred to OO-009.

## Pinned Remix scaffold

The control application was generated with `remix@3.0.0-beta.5` (source tag commit `9b722bfe640eac6f305b2ea736ec1e4736cbf1d3`). `deno.json` and `deno.lock` pin that package exactly; upgrades must be explicit.
