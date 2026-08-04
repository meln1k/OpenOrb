# OO-012 — Browser-to-Gondolin provisioning

**Slice:** 3 — Provision a real repository  
**Depends on:** OO-006, OO-010, OO-011

## Outcome

A logged-in user sends an initial prompt from the browser and the selected real runner prepares the configured GitHub repository inside Gondolin.

## Scope

- Add session creation UI for project, ref, optional runner, branch name, and initial textual prompt.
- Select an available runner using the MVP rule and pin it when provisioning begins.
- Runner durably stores full initial prompt and session metadata before acknowledging creation.
- Create an empty workspace, start the fixed-size VM, configure mediation, clone inside Gondolin, create the branch, and run executable `.agents/setup` inside Gondolin.
- Stream provisioning state/stdout/stderr through the control panel without persisting it there.
- Add the exact four-field catalog row only after runner confirmation; derive the preview by collapsing whitespace and truncating to 200 Unicode code points.
- Expose an explicit provisioning retry for failed sessions without silently replaying ambiguous work.

## Acceptance criteria

- Browser provisioning works for the configured real public/private GitHub project.
- No native host Git process consumes the workspace.
- `.agents/setup` runs inside Gondolin and a non-zero exit blocks the prompt.
- Browser shows clone/setup progress and useful failure output.
- Runner choice cannot change after provisioning begins.
- Control SQLite `sessions` has exactly `id`, `project_id`, `created_at`, and `initial_prompt_preview` as session data.
- Pi/model execution has not been faked; the prompt remains stored for OO-013.

## Tests

- Real public/private repository provisioning path.
- Setup success/failure fixtures.
- Manual/automatic runner selection and pinning.
- Catalog preview Unicode truncation and schema guard.
- Runner disconnect at defined provisioning stages.

## Not included

Pi prompt dispatch, conversation UI, diff review, or VM cold restart.
