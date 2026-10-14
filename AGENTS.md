# OpenOrb agent instructions

Before changing architecture, protocols, persistence, or security boundaries, read `CONTEXT.md`,
`security.md`, and the relevant documentation. Ask rather than invent undecided architecture,
protocols, persistence, or interfaces.

## Commands

- Install: `npm ci` (Node.js 26.11.1, Vite+ 1.1.0)
- Static checks: `npm run check`
- Tests: `npm test -- [<test-path> ...]`
- QEMU integration tests: `npm run test:gondolin`

Use the root npm scripts rather than invoking Vitest directly or recreating environment gates. The root
formatter intentionally excludes imported `.agents/skills` and generated `.amp/in`; do not reformat
installed skills to satisfy product checks.

For a read-only package probe, run:

```sh
npm exec --workspace @openorb/gateway -- node --input-type=module --eval '<code>'
```

Replace `gateway` with the owning package. Dependencies come from the locked npm workspace graph.
Node does not provide the former Deno runtime permission sandbox: production runner isolation is
enforced by the reviewed systemd/OS configuration, with guest work isolated in VMs.
Put repeatable logic or writes in a checked-in, scoped script—never a
package-dependent `/tmp` entrypoint.

<!-- effect-solutions:start -->

## Effect Best Practices

Before writing Effect code, run `effect-solutions list`, then
`effect-solutions show <topic>...` for the relevant patterns.

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns.
<!-- effect-solutions:end -->

## Local Framework Sources

If the guides are insufficient, inspect the Effect v4 clone at
`~/.local/share/effect-solutions/effect`.

For Remix internals, inspect the Remix 3 RC.5 checkout at
`~/.local/share/remix/remix`.
