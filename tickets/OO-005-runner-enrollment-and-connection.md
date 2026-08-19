# OO-005 — Runner enrollment and outbound connection

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002, OO-001

## Outcome

The administrator copies or regenerates the enrollment PSK in the browser, and the temporary macOS harness enrolls and maintains one authenticated outbound WebSocket.

## Scope

- Add automatic user-owned reusable enrollment-PSK provisioning and regeneration through authenticated Remix controllers/actions. Validate browser input with `remix/data-schema` and use OO-002's session/CSRF middleware. A PSK remains valid for multiple enrollments by its owning user until regenerated.
- Permit at most one active enrollment PSK per user. Enforce the invariant in PostgreSQL and atomically revoke the previous PSK when generating its replacement.
- Store each enrollment PSK unencrypted in PostgreSQL. Show the current PSK inside one always-present, visible, copyable runner-enrollment command under **Settings → Runners**, with a regenerate action and no revoke or delete action.
- Implement runner enrollment using gateway URL, PSK, runner name, architecture, and capabilities.
- Derive immutable runner `user_id` from the enrollment PSK record, never runner input. Return and persist a random revocable runner bearer token with file mode `0600`; subsequent connections inherit the same owner from the authenticated runner record.
- Establish the one outbound authenticated JSON WebSocket defined by `MVP.md`.
- Add the minimum versioned runtime schemas and connection lifecycle needed by enrollment, authentication, and heartbeat; do not design future command families.
- Validate every browser and runner payload at runtime.

## Acceptance criteria

- Starting the harness with only gateway URL and enrollment PSK enrolls it.
- Concurrent provisioning or regeneration can leave at most one active PSK for the user.
- The enrollment PSK is not used as ongoing runner identity.
- The runner token is not logged and is stored with mode `0600`.
- Invalid or regenerated PSKs cannot enroll a runner, and invalid or revoked runner tokens cannot connect.
- One user cannot regenerate another user's PSK, connect as another user's runner, or attach snapshots to another user's runner; enrollment and runner rows cannot form cross-user references.
- Disconnect/reconnect uses bounded exponential backoff with jitter.
- The gateway exposes no runner listener and the runner opens no inbound network port.

## Tests

- Enrollment success, repeated enrollment with the same reusable PSK, always-present provisioning, one-active-PSK enforcement under concurrent regeneration, invalid PSK, regenerated-PSK rejection, and two-user ownership separation.
- WebSocket authentication and schema rejection.
- Runner token file permissions.
- Reconnect behavior with bounded timers.

## Not included

Ed25519 identity, a binary data channel, terminal, previews, or session commands.
