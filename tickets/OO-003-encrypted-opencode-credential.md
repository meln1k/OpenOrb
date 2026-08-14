# OO-003 — Encrypted provider credentials

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002

## Outcome

The administrator configures provider API keys — OpenCode Go, OpenAI, or any other provider — through the browser as key-value credentials. Secret values are never returned after creation.

## Scope

- Require the application master key through `OPENORB_MASTER_KEY` or equivalent deployment-time secret injection. Never generate or persist it in control-panel files or PostgreSQL.
- Store each credential in `encrypted_secrets` as a row with a UUID primary key, immutable `user_id`, a credential `key` unique within that user (e.g. `OPENCODE_API_KEY`, `OPENAI_API_KEY`), and the encrypted value. Different users may use the same key name.
- Encrypt each value with the application-encryption scheme defined in `MASTER_PLAN.md`, authenticating immutable user ID, credential key, and key version as AAD.
- Require authenticated `userId` in every secret repository operation and scope list/read/replace/delete by both user and purpose.
- Add the smallest authenticated Remix form/list state needed to create, list, replace, and delete credentials. Validate form input with `remix/data-schema`; use the session/CSRF middleware from OO-002.
- Validate credential keys using the portable environment-variable convention (`^[A-Za-z_][A-Za-z0-9_]*$`, at most 64 characters), e.g. `OPENCODE_API_KEY`. Keys may be lowercase but must start with a letter or underscore; spaces and punctuation are rejected.
- The MVP session model remains Pi provider `opencode-go`, model `deepseek-v4-flash`; provider/model support in sessions is not part of this ticket.
- Redact secrets from responses, errors, and infrastructure logs.

## Acceptance criteria

- The browser can save multiple provider API keys under distinct keys and later sees only metadata.
- One user's list/read/replace/delete operations cannot observe or mutate another user's row, including when both users use the same credential key.
- Database inspection does not reveal any plaintext value; each row carries a UUID id and the unique credential key.
- Restarting the control panel with the same master key preserves decryptability.
- Starting with a missing or invalid master key always fails visibly; a wrong key for existing ciphertext fails without destroying data.
- No credential testing UI or additional provider abstraction is added.

## Tests

- Encryption/decryption and authenticated-metadata tamper failure, including user-owner tampering.
- API/route responses never include submitted values.
- Log/error redaction.
- Multi-credential create, list, replace (same row identity), and delete.
- Two-user tenant-separation coverage for duplicate key names and guessed row identifiers.
- Restart/master-key behavior, including proof that no control-panel file or PostgreSQL row contains the master key.

## Not included

Provider/model definitions, OAuth, provider testing, custom model definitions, or session support for providers beyond the fixed MVP model.
