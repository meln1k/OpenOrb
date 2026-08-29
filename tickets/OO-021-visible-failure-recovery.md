# OO-021 — Visible failure recovery

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-020

## Outcome

Every required MVP failure mode is distinguishable in the browser and has the documented manual retry/recovery behavior.

## Scope

- Exercise and surface runner disconnect during provisioning and prompt execution.
- Surface setup, resume-hook, checkpoint creation/publication/resume, model, VM start, GitHub authentication, clone, report, and push failures. Setup and clone failures are non-fatal warnings and the Pi session still starts; clone failure marks the checkout unavailable.
- Preserve runner-owned diagnostics without putting prompt/tool content or secrets in infrastructure logs.
- Add explicit retry only where `MVP.md` or OO-018 allows it; never silently replay ambiguous prompt or push work.
- Recover a consumed or failed VM without deleting workspace/Pi data. If OO-018 retained an older valid checkpoint, require an explicit checkpoint-resume retry that warns that newer guest root-disk changes were not captured. If no valid checkpoint exists, require an explicit clean-VM retry that reruns `.agents/setup`. Never present either recovery as the failed stop having succeeded.

## Acceptance criteria

- Each failure has a specific user-visible category and useful next action.
- Setup failure after a successful clone shows bounded stdout/stderr and still sends the stored prompt to Pi.
- Resume-hook failure shows bounded stdout/stderr and does not rerun setup or block the prompt.
- Checkpoint creation/publication/resume failures distinguish whether a valid prior checkpoint remains and offer only the corresponding explicit recovery.
- Clone failure shows bounded diagnostics, marks the checkout unavailable, and still permits the stored prompt to run.
- Authentication errors do not reveal credentials/placeholders beyond safe redaction.
- Ambiguous prompt/push outcomes require user action and make no exactly-once claim.
- Recovery preserves all data that `MVP.md` says must survive.

## Tests

- Failure matrix from `MVP.md` section 19.
- Secret redaction in UI-safe errors and infrastructure logs.
- Retry/no-replay assertions for ambiguous operations.
- VM cleanup after start/tool failures and checkpoint failure before/after shutdown.
- Explicit prior-checkpoint and clean-VM recovery paths, including root-disk rollback disclosure and workspace/Pi preservation.

## Not included

Automatic distributed recovery, command journals beyond current lean requirements, or background migration.
