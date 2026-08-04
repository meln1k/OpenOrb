# OO-012 — Browser-to-Gondolin provisioning

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-006, OO-010, OO-011

## Outcome

A logged-in user sends an initial prompt from the browser and the selected real runner prepares the configured GitHub repository inside Gondolin.

## Scope

- Add session creation UI for project, ref, optional runner, branch name, and initial textual prompt.
- Select an available runner using the MVP rule and pin it when provisioning begins.
- Runner durably stores full initial prompt and session metadata before acknowledging creation.
- Create an empty workspace, start the fixed-size VM, configure mediation, and clone inside Gondolin. On clone success, create the branch and run executable `.agents/setup` inside Gondolin.
- Treat clone failure as non-fatal: preserve and stream a bounded failure log, mark the checkout unavailable, skip branch/setup steps that require a valid checkout, and leave the session ready for Pi in OO-013.
- Stream provisioning state/stdout/stderr through the control panel without persisting it there.
- Add the exact four-field catalog row only after runner confirmation; derive the preview by collapsing whitespace and truncating to 200 Unicode code points.
- Expose an explicit retry for fatal provisioning failures. Retry destroys any current VM, creates a fresh VM, remounts the existing workspace, and reruns provisioning without silently replaying ambiguous prompt work.

## Acceptance criteria

- Browser provisioning works for the configured real public/private GitHub project.
- No native host Git process consumes the workspace.
- On a successful clone, `.agents/setup` runs inside Gondolin and a non-zero exit blocks the prompt.
- A clone failure is clearly logged but does not fail the session or prevent the stored prompt from proceeding in OO-013.
- Browser shows clone/setup progress and useful failure output.
- Runner choice cannot change after provisioning begins.
- Control PostgreSQL `sessions` has exactly `id`, `project_id`, `created_at`, and `initial_prompt_preview` as session data.
- Pi/model execution has not been faked; the prompt remains stored for OO-013.

## Tests

- Real public/private repository provisioning path.
- Clone failure continues with an unavailable-checkout state; setup success/failure fixtures cover successful clones.
- Manual/automatic runner selection and pinning.
- Catalog preview Unicode truncation and schema guard.
- Runner disconnect at defined provisioning stages.

## Not included

Pi prompt dispatch, conversation UI, diff review, or VM cold restart.
