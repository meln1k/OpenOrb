# OO-005 — Runner enrollment and outbound connection

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002, OO-001

## Outcome

The administrator creates an enrollment PSK in the browser, and the temporary macOS harness enrolls and maintains one authenticated outbound WebSocket.

## Scope

- Add reusable enrollment-PSK creation and revocation through authenticated Remix controllers/actions. Validate browser input with `remix/data-schema` and use OO-002's session/CSRF middleware. A PSK remains valid for multiple enrollments until revoked.
- Implement runner enrollment using control-panel URL, PSK, runner name, architecture, and capabilities.
- Return and persist a random revocable runner bearer token with file mode `0600`.
- Establish the one outbound authenticated JSON WebSocket defined by `MVP.md`.
- Add the minimum versioned runtime schemas and connection lifecycle needed by enrollment, authentication, and heartbeat; do not design future command families.
- Validate every browser and runner payload at runtime.

## Acceptance criteria

- Starting the harness with only control URL and enrollment PSK enrolls it.
- The enrollment PSK is not used as ongoing runner identity.
- The runner token is not logged and is stored with mode `0600`.
- Invalid/revoked tokens cannot connect.
- Disconnect/reconnect uses bounded exponential backoff with jitter.
- The control panel exposes no runner listener and the runner opens no inbound network port.

## Tests

- Enrollment success, repeated enrollment with the same reusable PSK, invalid PSK, and revoked-PSK rejection.
- WebSocket authentication and schema rejection.
- Runner token file permissions.
- Reconnect behavior with bounded timers.

## Not included

Ed25519 identity, a binary data channel, terminal, previews, or session commands.
