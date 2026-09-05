# OO-012 — Browser-to-Gondolin provisioning

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-006, OO-010, OO-011

## Outcome

A logged-in user sends an initial prompt from the browser and the selected real runner prepares the configured GitHub repository inside Gondolin.

## Scope

- Add a server-rendered Remix session-creation form/action for project, ref, optional runner, branch name, and initial textual prompt. Parse and validate the form with `remix/data-schema/form-data`; use OO-002's session/CSRF middleware.
- Select an available runner using the MVP rule and pin it when provisioning begins.
- Runner durably stores full initial prompt and session metadata before acknowledging creation.
- Create an empty workspace, start the fixed-size VM, configure mediation, and clone inside Gondolin. On clone success, create the branch and run executable `.agents/setup` inside Gondolin.
- Treat clone failure as non-fatal: preserve and stream a bounded failure log, mark the checkout unavailable, skip branch/setup steps that require a valid checkout, and leave the session ready for Pi in OO-013.
- Stream provisioning state/stdout/stderr through the gateway without persisting it there.
- Add the exact five-column catalog row (`workspace_id` plus four catalog data fields) only after runner confirmation; derive ownership from authenticated browser and selected-runner records, and derive the preview by collapsing whitespace and truncating to 200 Unicode code points.
- Expose an explicit retry for fatal provisioning failures. Retry destroys any current VM, creates a fresh VM, remounts the existing workspace, and reruns provisioning without silently replaying ambiguous prompt work.

## Acceptance criteria

- Browser provisioning works for the configured real public/private GitHub project.
- No native host Git process consumes the workspace.
- On a successful clone, `.agents/setup` runs inside Gondolin. A non-zero exit is visible but leaves the prompt ready for Pi in OO-013.
- A clone failure is clearly logged but does not fail the session or prevent the stored prompt from proceeding in OO-013.
- Browser shows clone/setup progress and useful failure output.
- Runner choice cannot change after provisioning begins.
- Gateway PostgreSQL `sessions` has exactly `workspace_id`, `id`, `project_id`, `created_at`, and `initial_prompt_preview`; a composite foreign key ensures the project has the same Workspace owner.
- A user cannot provision with another Workspace's project or runner ID; those identifiers are treated as unavailable/not found. Same-Workspace users share projects, runners, and catalog rows.
- Pi/model execution has not been faked; the prompt remains stored for OO-013.

## Tests

- Real public/private repository provisioning path.
- Clone failure continues with an unavailable-checkout state; setup success/failure fixtures prove both paths remain ready for Pi.
- Manual/automatic runner selection and pinning.
- Two-Workspace project/runner/session separation and same-Workspace sharing.
- Catalog preview Unicode truncation and schema guard.
- Runner disconnect at defined provisioning stages.

## Not included

Pi prompt dispatch, conversation UI, diff review, or VM cold restart.
