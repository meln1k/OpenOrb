# Security TODOs

## Narrow the browser asset-server dependency boundary

`packages/control/app/assets.ts` currently maps and allows `node_modules/**` so Remix can resolve
and compile browser-side npm imports from Deno's isolated workspace dependency tree. This follows
the Remix asset-server example, but it gives unauthenticated `GET`/`HEAD` requests a larger
compilation surface than OpenOrb currently needs.

Before adding a production client entry:

- Remove the `node_modules` file mapping and allow rule while no client entry imports npm packages.
- When browser package imports are required, audit the complete browser dependency closure and
  expose only the necessary files or packages.
- Account for Deno's internal `node_modules/.deno` transitive layout; simple top-level package
  allowlists or deny rules may be bypassable or incomplete.
- Add negative tests proving server-only dependencies and arbitrary workspace files cannot be
  fetched or compiled through `/assets/*path`.
- Reassess request-rate and compilation-resource limits because allowed modules are compiled on
  demand.
