# OO-003 — Encrypted provider credentials

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-002

## Outcome

The administrator configures one API-key credential for any Pi API-key provider through the browser. Provider credentials remain separate from generic secrets, and secret values are never returned after creation.

## Scope

- Require the application master key through `OPENORB_MASTER_KEY` or equivalent deployment-time secret injection. Never generate or persist it in gateway files or PostgreSQL.
- Store each provider value in a purpose-classified `encrypted_secrets` row with a UUID primary key, immutable `workspace_id`, an opaque credential key unique within that Workspace, and the encrypted value.
- Reference each provider secret from a separate `model_provider_credentials` row keyed by immutable Workspace and Pi provider ID. Do not infer provider identity from environment-variable-style secret names, and do not migrate a generic `OPENCODE_API_KEY` secret into a provider credential.
- Encrypt each value with the application-encryption scheme defined in `MASTER_PLAN.md`, authenticating immutable `workspaceId`, credential key, and key version as AAD.
- Require authenticated `workspaceId` in every secret repository operation and scope list/read/replace/delete by both Workspace and purpose.
- Add the smallest authenticated Remix form/list state needed to create, list, replace, and delete credentials. Validate form input with `remix/data-schema`; use the session/CSRF middleware from OO-002.
- Populate the provider selector from Pi's API-key-capable provider definitions and reject provider IDs outside that catalog.
- Keep generic-secret CRUD independent from provider credentials even when a generic secret is named `OPENCODE_API_KEY`.
- Redact secrets from responses, errors, and infrastructure logs.

## Acceptance criteria

- The browser can save credentials for multiple Pi providers and later sees only provider metadata.
- A user's list/read/replace/delete operations cannot observe or mutate another Workspace's row, including when both Workspaces configure the same provider. Users in the same Workspace share provider credentials.
- Database inspection does not reveal any plaintext value; provider records reference purpose-classified encrypted rows by UUID.
- A generic secret named `OPENCODE_API_KEY` remains generic and is not selectable as a provider credential.
- Restarting the gateway with the same master key preserves decryptability.
- Starting with a missing or invalid master key always fails visibly; a wrong key for existing ciphertext fails without destroying data.
- No credential testing UI is added.

## Tests

- Encryption/decryption and authenticated-metadata tamper failure, including Workspace-owner tampering.
- API/route responses never include submitted values.
- Log/error redaction.
- Multi-provider create, list, replace (same row identity), and delete.
- Generic/provider purpose separation and no legacy environment-name migration.
- Two-Workspace separation and same-Workspace sharing coverage for duplicate provider IDs and guessed row identifiers.
- Restart/master-key behavior, including proof that no gateway file or PostgreSQL row contains the master key.

## Not included

OAuth/subscription credentials, provider testing, or custom provider/model definitions.
