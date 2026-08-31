# OpenOrb agent instructions

Before implementing a ticket, read `tickets/README.md` and the complete ticket. Follow its security,
scope, dependency, and acceptance constraints. Ask rather than invent undecided architecture,
protocols, persistence, or interfaces.

## Commands

- Static checks: `deno task check`
- Tests: `deno task test [<test-path> ...]`
- QEMU integration tests: `deno task test:gondolin`

Never invoke `deno test` directly or recreate task permissions and environment variables. The root
formatter intentionally excludes imported `.agents/skills` and generated `.amp/in`; do not reformat
installed skills to satisfy product checks.

For a read-only package probe, run:

```sh
deno task --filter @openorb/gateway probe '<code>'
```

Replace `gateway` with the owning package. Pass eval options after `probe`; permissions are implicit
and dependencies frozen. Put repeatable logic or writes in a checked-in, scoped task—never a
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

For Remix internals, inspect the Remix 3 beta 10 checkout at
`~/.local/share/remix/remix`.
