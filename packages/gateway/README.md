# OpenOrb gateway

The Remix 3 gateway runs directly on Deno 2.9.5 with `Deno.serve()`. PostgreSQL remains available through Deno's compatibility support for the pinned `pg` npm package. `deno install --frozen` creates a Deno-managed local `node_modules` tree because Remix's browser-asset compiler uses Node-style package resolution. The trusted gateway process reads that workspace tree and loads pinned OXC native bindings through FFI; npm lifecycle scripts remain disabled and no Node.js or npm executable is used.

From the repository root, configure PostgreSQL, a deployment-injected session-cookie secret, and the application master key. Either export them, or copy `packages/gateway/.env.example` to `packages/gateway/.env` (gitignored) — the `dev` and `start` tasks load `.env` automatically, and shell-exported variables take precedence:

```sh
# Option A: copy the example and edit
cp packages/gateway/.env.example packages/gateway/.env

# Option B: export explicitly
export DATABASE_URL=postgres://localhost/openorb
export SESSION_SECRET="replace-with-a-long-random-secret"
export OPENORB_MASTER_KEY="$(openssl rand -hex 32)"

deno task dev:gateway
```

Open <http://localhost:44100>. On a fresh database, the root route redirects to first-run setup. The Deno-native migration loader applies committed `remix/data-table` migrations before the server starts.

OO-001A changed password rows to PBKDF2-HMAC-SHA-256 with 600,000 iterations, a random 16-byte salt, and a 256-bit derived key, and user IDs now use UUIDv7 instead of integers. Before first use of this revision, intentionally reset the unreleased `openorb` and `openorb-test` databases as documented in the root README. This discards existing users, sessions, encrypted credentials, Git configuration, and projects; no Argon2 or integer-user-ID compatibility path exists.

Tests use PostgreSQL directly and default to `postgres://localhost/openorb-test`, regardless of the application `DATABASE_URL`; create that test database first. CI may set `OPENORB_TEST_DATABASE_URL` to an isolated test database. Test tables are truncated between tests.
