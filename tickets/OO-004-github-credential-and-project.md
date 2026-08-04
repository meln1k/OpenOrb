# OO-004 — GitHub credential and project configuration

**Slice:** 1 — Configure and enroll  
**Depends on:** OO-003

## Outcome

The administrator configures a GitHub token and a GitHub repository project entirely through the browser.

## Scope

- Add encrypted GitHub token create/replace/delete UI using the existing secret store.
- Add project create/edit/delete UI for name, canonical GitHub repository, default ref, default branch pattern, and the fixed MVP model.
- Validate and canonicalize only the GitHub repository forms explicitly supported by the MVP.
- Do not accept SSH or non-GitHub repository configuration.
- Never return the token after creation.

## Acceptance criteria

- A public project can be saved without a GitHub token.
- A private project can reference a stored GitHub token.
- Unsupported host/protocol/repository input fails with a useful validation error.
- Deleting an in-use credential/project is rejected or explicitly resolved without orphaning configuration; if product behavior is not determined, ask before implementing it.
- Secret values are absent from browser responses and logs.

## Tests

- Project validation for accepted and rejected repository inputs.
- Encrypted token response/redaction tests.
- Project CRUD controller tests.
- Credential/project relationship behavior.

## Not included

SSH keys, non-GitHub hosts, credential testing, project secrets, or pull requests.
