# OpenOrb control

The real Remix 3 control application. OO-001 provides only the public shell and health endpoint; authentication, persistence, runners, and sessions arrive in later tickets.

From the repository root:

```sh
pnpm dev:control
```

Open <http://localhost:44100>. Check process health at <http://localhost:44100/healthz>.
