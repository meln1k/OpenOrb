# OO-002 — Admin setup and login

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-001

## Outcome

The first user creates the single administrator through the browser and subsequently logs in to an authenticated control-panel shell.

## Scope

- Add control-panel PostgreSQL with foreign keys and committed migrations. PostgreSQL is the control panel's only durable persistence; do not add Redis, another database/KV store, or application-owned durable local files.
- Implement first-run setup, password login, and logout.
- Hash passwords with Argon2id.
- Add browser-session rotation, expiry, secure cookie handling, and CSRF protection for state changes.
- Make local browser development work without weakening production cookie behavior; ask before selecting an approach not already dictated by Remix/current project configuration.
- Protect authenticated pages and show clear invalid-login/setup states.

## Acceptance criteria

- Setup is available only when no administrator exists.
- Passwords are never stored or logged in clear text.
- Login rotates the session identifier; logout invalidates it.
- State-changing requests without valid CSRF protection fail.
- Production cookies are `HttpOnly`, `Secure`, host-only, and `SameSite=Lax`.
- A control-panel restart against the same PostgreSQL database preserves the administrator and valid persisted browser-session behavior; deleting the control process's local working directory loses no application state.

## Tests

- First-run setup race/second-admin rejection.
- Password hash and login success/failure.
- Session rotation/logout.
- CSRF rejection.
- Route/controller tests for authenticated and unauthenticated requests.

## Not included

Passkeys, multiple users, roles, or organization tenancy.
