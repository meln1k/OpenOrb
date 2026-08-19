# OO-004 — GitHub credential and project configuration

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-003

## Outcome

The administrator configures a per-user GitHub token, Git author identity, and GitHub repository project entirely through the browser.

## Scope

- Add encrypted GitHub token create/replace/delete UI using the existing secret store and authenticated Remix controllers/actions. Classify each `encrypted_secrets` row with a required `purpose`: `provider-api-key` for the Secrets UI or `git-credential` for rows owned by `git_credentials`. Repositories must query by authenticated user and purpose rather than infer ownership from key names or cross-repository lookups. A composite foreign key must prevent a Git credential from referencing another user's encrypted secret. Validate forms and project input with `remix/data-schema`; use the session/CSRF middleware from OO-002.
- Add required per-user Git author name and email configuration in the gateway. Store it as non-secret gateway configuration keyed by `user_id`; project overrides are deferred.
- Add user-owned project create/edit/delete UI for name and canonical GitHub repository. Persist `main` and `openorb/{session-name}-{short-session-id}` as internal defaults; project names are unique per user, and foreign-user project IDs are treated as not found. Do not expose ref, branch-pattern, credential, or model selection as project configuration.
- Validate and canonicalize only the GitHub repository forms explicitly supported by the MVP.
- Do not accept SSH or non-GitHub repository configuration.
- Never return the token after creation.

## Acceptance criteria

- A public project can be saved without a GitHub token.
- Private repository operations automatically use the owning user's singleton GitHub token when configured.
- The browser can configure the owning user's Git author name/email later used for session commits, and both values are required before session provisioning.
- Unsupported host/protocol/repository input fails with a useful validation error.
- Deleting an in-use project is rejected. Deleting the user's GitHub token is allowed and disables that user's private repository operations until another token is configured.
- Two users may use the same project name and GitHub host without sharing rows; guessed foreign-user IDs cannot be read, updated, or deleted.
- Secret values are absent from browser responses and logs.
- The provider Secrets list never includes the GitHub credential because encrypted rows are selected by their persisted purpose.

## Tests

- Project validation for accepted and rejected repository inputs.
- Encrypted token response/redaction tests.
- Encrypted-secret purpose classification for provider API keys and the GitHub credential.
- Project CRUD controller tests.
- Per-user Git author identity validation and persistence tests.
- Per-user credential and project-default behavior, including cross-user reference rejection.

## Not included

SSH keys, non-GitHub hosts, credential testing, project secrets, or pull requests.
