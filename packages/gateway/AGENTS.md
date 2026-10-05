# OpenOrb Agent Guide

This app was scaffolded with `remix new`. Use these conventions when continuing to build it out.

## Commands

```sh
deno install --frozen
deno task --filter @openorb/gateway start
deno task check
deno task test
```

## Building Features

Refer to ../../.agents/skills/remix/SKILL.md

## Starter Layout

- `app/routes.ts` defines the route contract
- `app/router.ts` wires routes to route handlers
- `app/actions/controller.tsx` owns the top-level route actions (assets, health, home)
- `app/actions/<route-key>/` owns each nested route map: its controller, route-local pages, and route-area UI (e.g. `app/actions/auth/ui.tsx`)
- `app/data/` holds shared persistence only: `schema.ts` table definitions, `store.ts` composition root, and repositories consumed across routes
- `app/middleware/` holds request lifecycle code: `render.tsx` and `runtime.ts` (GatewayRuntime context)
- `app/ui/` holds shared cross-route UI (`document.tsx` on the server, `public/shell.tsx` in the browser)
- `app/public/` holds the global browser bootstrap; route-owned browser modules live in `app/actions/<route-key>/public/`, shared browser UI in `app/ui/public/`
- `app/utils/` holds pure support code that is genuinely cross-layer: password hashing, master key loading, secret encryption, rate limiting, session policy
- `app/assets.ts` owns the server-side asset pipeline used by the asset route and renderer
- `public/` contains static files served from the app root

## Route Ownership

- Start from `app/routes.ts` and map each route to the narrowest owner on disk.
- Put top-level route actions in `app/actions/controller.tsx`.
- Add `app/actions/<route-key>/controller.tsx` for nested route maps that need their own actions or middleware.
- Keep route-owned page modules next to the route that owns them.
- Move UI shared across unrelated route slices to `app/ui/`. Keep UI shared only within one slice at that slice's root (e.g. settings navigation and styles in `app/actions/settings/`).
- Put browser source and its local dependencies under the narrowest owner's `public/` directory. These modules are compiled and served under `/assets/`, unlike root `public/` static files.
- Keep server modules outside `public/`. Colocated `*.test.*` files are explicitly denied by the asset server.
- Move pure cross-layer support code to `app/utils/<topic>.ts`; do not put it in `app/data/` unless it is schema/query/persistence.

## Build-Out Notes

- This starter intentionally begins small; add directories like `app/data/` and `test/` only when you need them.
- Prefer putting code in the narrowest owner before introducing shared modules.
- Avoid generic dumping-ground directories like `app/lib/` or `app/components/`.
