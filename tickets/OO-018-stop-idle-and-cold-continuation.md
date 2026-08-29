# OO-018 — Stop, idle checkpointing, and continuation

**Slice:** 6 — Cold lifecycle and deletion  
**Depends on:** OO-014, OO-016

## Design change

This ticket intentionally supersedes the clean-VM idle-stop and continuation flow in `MVP.md`: use a Gondolin disk checkpoint instead of destroying the VM root disk, and run `.agents/resume` instead of rerunning `.agents/setup`. Checkpoints and `.agents/resume` are therefore no longer deferred for this slice. The remaining MVP lifecycle and security constraints still apply.

## Outcome

A session VM can be stopped explicitly or after 15 minutes idle by creating a Gondolin disk checkpoint, then resumed with the same checkpointed guest root-disk state, workspace, and Pi conversation.

## Scope

- Record the latest accepted user-message time. Allow an idle stop only after at least 15 minutes have passed since that message and no agent, provisioning, setup, resume hook, checkpoint, or Git Snapshot work is active.
- Before stopping, create a final controlled Git Snapshot and flush workspace writes.
- Create a host-owned Gondolin checkpoint outside the guest-writable workspace with `vm.checkpoint(path)`. Checkpointing is the stop operation: once shutdown begins it consumes the VM even if later checkpoint publication fails, so the original VM object must not be closed again or reused.
- Keep at most one published current checkpoint per session. Write each replacement to a distinct candidate path, validate it, atomically publish it as current in runner metadata, and only then delete the previous checkpoint. Never overwrite the current checkpoint path in place. Make candidate and obsolete-checkpoint cleanup idempotent across runner restart. Remove an invalid candidate after failure, retain any previous current checkpoint, and do not silently resume that stale generation as though the failed stop succeeded.
- Retain the current checkpoint together with the independently persisted workspace, Pi JSONL, metadata, Git Snapshots, and logs. The checkpoint contains only the guest root disk; mounted workspace data and tmpfs-backed guest paths such as `/root`, `/tmp`, and `/var/log` are not part of it.
- Add the browser Stop action. Reject Stop while Pi or another provisioning/setup/resume-hook/checkpoint/Git Snapshot operation is active; the user must wait or Abort the active run first.
- On the next prompt while stopped, load the current checkpoint with `VmCheckpoint.load(path)`, resume it using the same pinned guest assets, remount the existing workspace, restore mediation, run `.agents/resume`, reopen Pi JSONL, and then dispatch. Do not rerun `.agents/setup`; its prepared root-disk state is retained by the checkpoint.
- Require checkpoint-compatible guest assets with a `manifest.json` build ID and a backend allowed by the checkpoint metadata. Serialize checkpoint resume, replacement, and deletion because resume may rebase the checkpoint file in place. Make checkpoint creation and resume failures visible; a resume failure leaves the prompt undispatched.
- Make the requirement for a quick, idempotent `.agents/resume` visible in project/session UI or documentation.

## Acceptance criteria

- Stop checkpoints and closes the real VM while preserving the workspace, Pi JSONL, metadata, Git Snapshots, and logs; successful checkpoint replacement may delete only the obsolete checkpoint.
- Stop is unavailable during active work and succeeds once the session is idle.
- Test-configured short timeout exercises the same eligibility rule as the production 15-minute timeout.
- Guest root-disk and workspace changes persist; tmpfs-backed paths, RAM, and process state do not.
- Continuation resumes the retained checkpoint with compatible pinned guest assets rather than booting a clean root disk.
- Repeated stop/resume cycles use the newest successfully published checkpoint and leave no obsolete checkpoint after successful replacement.
- A failed checkpoint cannot replace the last valid checkpoint or make a partial checkpoint resumable, and its consumed VM is not reused.
- `.agents/resume` runs after each checkpoint resume because processes are not restored; failure is visible and does not block the prompt.
- The continued model response has prior conversation context and current workspace state.
- No RAM/process checkpoint, lease system, or process restoration is introduced.

## Tests

- Manual stop rejection during active work, successful idle stop, and shortened idle timeout.
- Root-disk and workspace persistence across checkpoint resume, plus verification that tmpfs-backed paths and process state are not restored.
- Repeated checkpoint/resume/checkpoint cycles and safe current-checkpoint replacement.
- Checkpoint failure before and after VM shutdown, restart-safe candidate/obsolete cleanup, and resume failure with incompatible or unavailable guest assets or backend.
- Resume-hook success/failure and verification that setup is not rerun.
- Pi JSONL continuation after process/VM recreation.

## Not included

RAM/process snapshots, service restoration, terminal leases, previews, user-managed or multiple retained checkpoint generations, or archive semantics.
