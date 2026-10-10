# OpenOrb gateway

The Remix 3 gateway is a native celld Worker exporting `Workspace` and `Runners` Durable Objects.
Deno 2.9.5 builds the Worker, browser assets, and model metadata; requests use the `ASSETS` binding
and native DO RPC, not a Deno HTTP server or a request-time compiler. Workspace SQLite owns
configuration, authentication, enrollment, and the minimal Session catalog. Runners owns live
connections and routing; complete Session state remains runner-owned. PostgreSQL is not required.

From the repository root, install the pinned tools and dependencies, then configure independent
session-cookie and encryption secrets in the ignored `packages/gateway/.env`. Do not overwrite an
existing file or generate a replacement master key for existing state:

```sh
bash scripts/install-celld.sh
deno install --frozen
test -f packages/gateway/.env || cp packages/gateway/.env.example packages/gateway/.env
chmod 600 packages/gateway/.env
# Edit .env; generate each secret independently with openssl rand -hex 32.
```

In an orb, use `amp orb services ensure` and its gateway portal. Outside an orb:

```sh
deno task dev:gateway
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

`deno install --frozen` supplies the Deno-managed `node_modules` needed by the build-time Remix
compiler and pinned native bindings; npm lifecycle scripts remain disabled. Test commands are
defined at the repository root. Native celld tests must use disposable config/state directories,
never the operator's `.dev.vars` or `.celld` directory. See
[operations](../../docs/operations.md) and [release acceptance](../../docs/release-acceptance.md)
for persistence, recovery boundaries, and the secret-gated lifecycle.
