# OpenOrb agent instructions

Before implementing a ticket, read `tickets/README.md` and the complete ticket being implemented.

Follow the ticket's security boundaries, scope, dependencies, and acceptance criteria. Do not invent system design, architecture, protocols, persistence formats, or interfaces when they are not explicitly decided; ask the user instead.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.
