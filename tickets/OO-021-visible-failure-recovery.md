# OO-021 — Visible failure recovery

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-020

## Outcome

Every required MVP failure mode is distinguishable in the browser and has the documented manual retry/recovery behavior.

## Scope

- Exercise and surface runner disconnect during provisioning and prompt execution.
- Surface setup, model, VM start, GitHub authentication, clone, report, and push failures. Clone failure is a non-fatal unavailable-checkout warning and the Pi session still starts.
- Preserve runner-owned diagnostics without putting prompt/tool content or secrets in infrastructure logs.
- Add explicit retry only where `MVP.md` allows it; never silently replay ambiguous prompt or push work.
- Ensure a failed VM can be destroyed and explicitly cold-started without deleting workspace/Pi data.

## Acceptance criteria

- Each failure has a specific user-visible category and useful next action.
- Setup failure after a successful clone shows bounded stdout/stderr and never prompts Pi.
- Clone failure shows bounded diagnostics, marks the checkout unavailable, and still permits the stored prompt to run.
- Authentication errors do not reveal credentials/placeholders beyond safe redaction.
- Ambiguous prompt/push outcomes require user action and make no exactly-once claim.
- Recovery preserves all data that `MVP.md` says must survive.

## Tests

- Failure matrix from `MVP.md` section 19.
- Secret redaction in UI-safe errors and infrastructure logs.
- Retry/no-replay assertions for ambiguous operations.
- VM cleanup after start/tool failures.

## Not included

Automatic distributed recovery, command journals beyond current lean requirements, or background migration.
