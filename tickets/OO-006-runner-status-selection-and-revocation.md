# OO-006 — Runner status, selection, and revocation

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-005

## Outcome

The browser shows connected runners and enough real capacity information to choose an available runner before session provisioning.

## Scope

- Send periodic runner heartbeat/capacity reports using the MVP fields.
- Show online/offline state and basic capacity in the runner UI.
- Implement the MVP selection rule: manual available runner or connected runner with the fewest active sessions, subject to configured concurrency and disk threshold.
- Add runner revocation and immediate connection termination/reconnect rejection.
- Keep selection provisional until session provisioning begins.

## Acceptance criteria

- Browser state changes from online to offline after the defined heartbeat/connection timeout.
- Capacity values come from the runner host, not fixtures.
- Selection rejects unavailable/full/low-disk runners with a clear reason.
- Revocation disconnects the runner and prevents reconnect with its token.
- No reservation handshake, labels, draining, resource ratios, or migration are introduced.

## Tests

- Heartbeat runtime validation and timeout.
- Deterministic basic selection across multiple runner records.
- Manual unavailable selection rejection.
- Revocation of a connected and disconnected runner.

## Not included

Per-session CPU/memory requests, reservations, labels, draining, or migration.
