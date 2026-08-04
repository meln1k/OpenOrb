# OO-003 — Encrypted OpenCode Go credential

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002

## Outcome

The administrator configures the OpenCode Go API key through the browser without the key being returned after creation.

## Scope

- Load or create the application master key in persistent control storage with mode `0600`.
- Encrypt the OpenCode Go key with the scheme required by `MVP.md`, including authenticated metadata and key version.
- Add the smallest browser form/list state needed to create, replace, and delete the credential.
- Represent the MVP model as Pi provider `opencode-go`, model `deepseek-v4-flash`.
- Redact secrets from responses, errors, and infrastructure logs.

## Acceptance criteria

- The browser can save an OpenCode Go API key and later sees only metadata/redacted hint.
- Database inspection does not reveal the plaintext key.
- Restarting the control panel with the same master key preserves decryptability.
- Starting with a missing/wrong key for existing ciphertext fails visibly rather than destroying data.
- No credential testing UI or additional provider abstraction is added.

## Tests

- Encryption/decryption and authenticated-metadata tamper failure.
- API/route response never includes the submitted key.
- Log/error redaction.
- Restart/master-key behavior.

## Not included

Other providers/models, OAuth, provider testing, or custom model definitions.
