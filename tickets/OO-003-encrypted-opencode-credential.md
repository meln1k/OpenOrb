# OO-003 — Encrypted OpenCode Go credential

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002

## Outcome

The administrator configures the OpenCode Go API key through the browser without the key being returned after creation.

## Scope

- Require the application master key through `OPENORB_MASTER_KEY` or equivalent deployment-time secret injection. Never generate or persist it in control-panel files or PostgreSQL.
- Encrypt the OpenCode Go key with the application-encryption scheme defined in `MASTER_PLAN.md`, including authenticated metadata and key version.
- Add the smallest browser form/list state needed to create, replace, and delete the credential.
- Represent the MVP model as Pi provider `opencode-go`, model `deepseek-v4-flash`.
- Redact secrets from responses, errors, and infrastructure logs.

## Acceptance criteria

- The browser can save an OpenCode Go API key and later sees only metadata/redacted hint.
- Database inspection does not reveal the plaintext key.
- Restarting the control panel with the same master key preserves decryptability.
- Starting with a missing or invalid master key always fails visibly; a wrong key for existing ciphertext fails without destroying data.
- No credential testing UI or additional provider abstraction is added.

## Tests

- Encryption/decryption and authenticated-metadata tamper failure.
- API/route response never includes the submitted key.
- Log/error redaction.
- Restart/master-key behavior, including proof that no control-panel file or PostgreSQL row contains the master key.

## Not included

Other providers/models, OAuth, provider testing, or custom model definitions.
