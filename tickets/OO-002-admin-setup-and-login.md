# OO-002 — Admin setup and login

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-001

## Outcome

The first user creates the single administrator through the browser and subsequently logs in to an authenticated control-panel shell.

## Scope

- Add control-panel PostgreSQL with foreign keys and committed migrations using `remix/data-table` and its PostgreSQL adapter. PostgreSQL is the control panel's only durable persistence; do not add Redis, another database/KV store, or application-owned durable local files.
- Add the `users`, `password_credentials`, and `browser_sessions` persistence needed by this ticket.
- Implement first-run setup, password login, and logout with Remix's credentials-auth primitives: `createCredentialsAuthProvider()`, `verifyCredentials()`, and `completeAuth()`.
- Use a maintained Argon2id package only for password creation and verification. OpenOrb must not implement hashing, salting, PHC parsing, or password-format handling.
- Implement the narrow PostgreSQL-backed `SessionStorage` adapter required by Remix's session middleware. Store an opaque session ID and session data/expiry in PostgreSQL; do not use filesystem, memory, Redis, or cookie-only storage in production.
- Add Remix session middleware, session-ID rotation, expiry, secure signed-cookie handling, and Remix CSRF middleware for state changes.
- Use Remix `auth()`/`createSessionAuthScheme()` to resolve the current administrator and `requireAuth()` to protect the authenticated browser shell.
- Make local browser development work without weakening production cookie behavior; require a deployment-injected session-cookie signing secret outside tests.
- Apply bounded login rate limiting without adding durable rate-limit storage.
- Show clear invalid-login, invalid-setup, and unauthenticated states.

## Acceptance criteria

- Setup is available only when no administrator exists. Concurrent setup attempts cannot create a second administrator; the database enforces the invariant.
- Passwords are never stored or logged in clear text. Only the maintained password-hashing package handles password hashes.
- Login uses Remix credentials verification, rotates the session identifier with `completeAuth()`, and establishes the authenticated identity.
- Logout destroys or invalidates the Remix session and prevents the old session cookie from authenticating.
- Expired sessions are rejected and removed from the PostgreSQL session store.
- State-changing requests without valid Remix CSRF protection fail.
- Production session cookies are signed, opaque, `HttpOnly`, `Secure`, host-only, `SameSite=Lax`, and scoped to `/`; local development may omit `Secure` only when not serving HTTPS.
- A control-panel restart against the same PostgreSQL database preserves the administrator and valid browser sessions; deleting the control process's local working directory loses no application state.
- Authenticated routes are inaccessible without a valid resolved Remix identity.

## Tests

- First-run setup race/second-admin rejection at the database boundary.
- Password setup and login success/failure through the Remix credentials provider, including hash redaction.
- Session persistence, expiry, rotation, old-cookie rejection, and logout invalidation.
- CSRF rejection for form and request-header token paths.
- Production and development cookie attributes.
- Login rate limiting.
- Router/controller tests for setup, login, logout, authenticated, and unauthenticated requests.
- PostgreSQL-backed session persistence after recreating the router/control process.

## Not included

Passkeys, multiple users, roles, organization tenancy, or external identity providers.
