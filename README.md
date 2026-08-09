# OpenOrb

OpenOrb is an open-source, self-hostable control panel and runner for Pi coding-agent sessions on user-owned compute. The control panel currently includes the OO-002 single-admin setup and password-authenticated browser shell; runner enrollment and coding sessions arrive in later tickets.

## Tooling and prerequisites

- Node.js 24.7.0 or newer
- pnpm 11.9.0 or newer
- QEMU, the runner's only external executable prerequisite

Install QEMU for the host architecture:

```sh
# macOS
brew install qemu

# Debian/Ubuntu ARM64
sudo apt install qemu-system-arm

# Debian/Ubuntu x86-64
sudo apt install qemu-system-x86
```

The macOS runner entry point is a temporary development harness. Linux x86-64 and ARM64 remain the supported runner release targets.

`gh` is intentionally not required on the runner host. It will be installed in the guest developer image in OO-009.

## Install and run

From a clean checkout, provide PostgreSQL and a session-cookie signing secret:

```sh
pnpm install --frozen-lockfile
export DATABASE_URL=postgres://localhost/openorb
export SESSION_SECRET="replace-with-a-long-random-secret"
pnpm dev
```

The control page is available at <http://localhost:44100>, with process health at <http://localhost:44100/healthz>. On a fresh database, open the control page to complete administrator setup. The runner harness still only checks prerequisites; it does not fake enrollment or session behavior.

Run either process separately when needed:

```sh
pnpm dev:control
pnpm dev:runner
```

Use `pnpm start` for the same two processes without file watching.

## Checks

```sh
pnpm format:check
pnpm typecheck
pnpm test
```

Tests use the local `openorb-test` PostgreSQL database, do not start a VM, and do not require QEMU.

## Pinned Remix scaffold

The control application was generated with:

```sh
npx remix@next new packages/control --app-name OpenOrb
```

At scaffold time, `remix@next` resolved to `remix@3.0.0-beta.5` (source tag commit `9b722bfe640eac6f305b2ea736ec1e4736cbf1d3`). The workspace catalog and lockfile pin that exact package version and integrity; upgrades must be explicit.
