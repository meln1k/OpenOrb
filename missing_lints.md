# Missing lint rules

## No `unknown` parameters on domain operations

Public domain-operation functions must accept their concrete domain types rather than declaring
parameters as `unknown`. Untrusted values must be parsed and narrowed at the persistence, network,
or other input boundary before they are passed to domain operations.

For example, this should be rejected:

```ts
export function verifyPassword(password: string, stored: unknown): Promise<boolean>;
```

The operation should instead require the validated type:

```ts
export function verifyPassword(password: string, stored: PasswordHash): Promise<boolean>;
```

Explicit boundary validators remain allowed to accept `unknown`, including type guards, assertion
functions, and parsers/decoders that validate before returning a concrete type:

```ts
export function isPasswordHash(value: unknown): value is PasswordHash;
export function parseRunnerMessage(input: unknown): RunnerMessage;
```

Deno lint does not currently provide a built-in rule that distinguishes domain operations from
explicit input-boundary validators. Add or adopt such a rule when it can enforce this distinction
without prohibiting safe uses of `unknown` at trust boundaries.
