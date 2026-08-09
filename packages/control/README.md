# OpenOrb control

The Remix 3 control application. OO-002 adds the PostgreSQL-backed single-admin setup and
password session flow.

From the repository root, configure PostgreSQL and a deployment-injected session-cookie secret:

```sh
export DATABASE_URL=postgres://localhost/openorb
export SESSION_SECRET="replace-with-a-long-random-secret"
pnpm dev:control
```

Open <http://localhost:44100>. On a fresh database, the root route redirects to first-run setup.
The migration runner applies committed migrations before the server starts.

Tests use PostgreSQL directly and always target `postgres://localhost/openorb-test`, regardless of
the application `DATABASE_URL`; create that test database first. Test tables are truncated between
tests.
