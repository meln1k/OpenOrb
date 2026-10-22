# OpenOrb gateway

The Remix 3 gateway is a native celld Worker exporting `Workspace`, `Runners`, and `Session` Durable
Objects. Node.js 26.11.1 and Rolldown build the Worker, browser assets, and model metadata; requests use the `ASSETS`
binding and native DO RPC, not a Node HTTP server or a request-time compiler. Workspace SQLite owns
configuration, authentication, enrollment, and the minimal Session catalog. Runners owns live runner
connections, capacity, and Environment Control routing. Each Session DO hosts the agent and owns its
Session's Harness State, project setup, Git Snapshots, and Published Media records (bytes in the
`MEDIA` R2 bucket); runners keep only Agent Environments. PostgreSQL is not required.

From the repository root, install the pinned tools and dependencies, then configure independent
session-cookie and encryption secrets in the ignored `packages/gateway/.env`. Do not overwrite an
existing file or generate a replacement master key for existing state:

```sh
curl -fsSL https://celld.dev/install.sh | CELLD_VERSION=v0.6.3 sh
export PATH="$HOME/.local/bin:$PATH"
npm ci
test -f packages/gateway/.env || cp packages/gateway/.env.example packages/gateway/.env
chmod 600 packages/gateway/.env
# Edit .env; generate each secret independently with openssl rand -hex 32.
```

In an orb, use `amp orb services ensure` and its gateway portal. Outside an orb:

```sh
npm run dev:gateway
```

The local listener is on loopback port 44100. The dev task prepares mode-0600
`packages/gateway/.dev.vars` from `.env` (shell-exported bindings take precedence), builds, and
runs `celld dev` against `packages/gateway/wrangler.jsonc`. The build places `dist/worker.js` and
`dist/assets` beside that config. The package `start` task skips preparation/build and uses those
existing files. `PUBLIC_URL` and `OPENORB_SESSION_COOKIE_SECURE` control browser origin/cookie policy.

Dev state lives in `packages/gateway/.celld/dev` and persists across restarts. The former
`packages/workspace/.celld/dev` is not migrated or deleted; the relocated config starts fresh.
An empty Workspace redirects to first-run administrator setup. Workspace uses relational SQLite with
Remix Data definitions in `app/cells/workspace/schema.ts`, plain SQL files in
`app/cells/workspace/migrations/`, and native SQL execution. This is a
clean break: PostgreSQL and legacy Workspace KV records are not read or imported. Recreate
configuration through setup/settings; do not reset or delete old data as part of this change.

`npm ci` supplies the locked npm workspace dependencies needed by the build-time Remix
compiler and pinned native bindings. Test commands are
defined at the repository root. Native celld tests must use disposable config/state directories,
never the operator's `.dev.vars` or `.celld` directory. See
[operations](../../docs/operations.md) and [release acceptance](../../docs/release-acceptance.md)
for persistence, recovery boundaries, and the secret-gated lifecycle.
