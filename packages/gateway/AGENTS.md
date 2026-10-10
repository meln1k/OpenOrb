# OpenOrb Agent Guide

This Remix 3 app is the public native celld Worker. `server.ts` exports the fetch handler and
the `Workspace` and `Runners` Durable Object classes; it is not a Deno HTTP entrypoint.

## Commands

```sh
deno install --frozen
deno task --filter @openorb/gateway build
deno task dev:gateway
deno task check
deno task test
```

`start` runs celld using already-built bytes and prepared bindings. `dev` prepares the private
`packages/gateway/.dev.vars`, builds Worker/assets, and starts celld against
`packages/gateway/wrangler.jsonc`. Never delete wanted `.celld/dev` state or replace existing
master/session secrets. Use an isolated config directory for runtime tests. PostgreSQL and
`DATABASE_URL` are not gateway dependencies.

## Building Features

Refer to ../../.agents/skills/remix/SKILL.md

## Starter Layout

- `app/routes.ts` defines the route contract
- `app/router.ts` wires routes to route handlers
- `app/actions/controller.tsx` owns the top-level route actions (assets, health, home)
- `app/actions/<route-key>/` owns each nested route map: its controller, route-local pages, and route-area UI (e.g. `app/actions/auth/ui.tsx`)
- `app/cells/workspace/workspace.ts` owns durable configuration, auth, enrollment, and catalog persistence through native RPC; plain SQL migrations live beside it in `migrations/`
- `app/cells/runners/runner-registry-do.ts` owns live runner connections/routing; Worker routes await its native RPC methods directly
- `app/middleware/` holds request lifecycle code and request-scoped services; Worker handlers use native DO clients, not a database pool
- `app/ui/` holds shared cross-route UI (`document.tsx` on the server, `public/shell.tsx` in the browser)
- `app/public/` holds the global browser bootstrap; route-owned browser modules live in `app/actions/<route-key>/public/`, shared browser UI in `app/ui/public/`
- `app/utils/` holds pure support code that is genuinely cross-layer: password hashing, master key loading, secret encryption, rate limiting, session policy
- `build-assets.ts` exports browser bytes/metadata; `app/assets.ts` serves the compiled assets via `ASSETS` without a request-time compiler/filesystem
- `build-worker.ts` bundles the native Worker into `dist/` beside the gateway config
- `public/` contains static files served from the app root

## Route Ownership

- Start from `app/routes.ts` and map each route to the narrowest owner on disk.
- Put top-level route actions in `app/actions/controller.tsx`.
- Add `app/actions/<route-key>/controller.tsx` for nested route maps that need their own actions or middleware.
- Keep route-owned page modules next to the route that owns them.
- Move UI shared across unrelated route slices to `app/ui/`. Keep UI shared only within one slice at that slice's root (e.g. settings navigation and styles in `app/actions/settings/`).
- Put browser source and its local dependencies under the narrowest owner's `public/` directory. These modules are compiled and served under `/assets/`, unlike root `public/` static files.
- Keep server modules outside `public/`. Colocated `*.test.*` files are explicitly denied by the asset server.
- Move pure cross-layer support code to `app/utils/<topic>.ts`; durable configuration belongs to Workspace, not gateway repositories.

## Build-Out Notes

- Prefer putting code in the narrowest owner before introducing shared modules.
- Avoid generic dumping-ground directories like `app/lib/` or `app/components/`.
