# OO-016 — Guest Git Snapshot and Changes UI

**Slice:** 5 — Review and push
**Depends on:** OO-015

## Outcome

During and after each Agent Run, the user reviews a bounded Git Snapshot produced inside Gondolin,
cached by the runner, and kept current while the checkout's Agent Environment remains available.
The user can stage and unstage complete files through the same Changes view, including during an
active Agent Run.

## Scope

- Run controlled status/diff commands inside the session VM at completed tool and turn boundaries,
  every 15 seconds while the Agent Environment is available, and in an awaited run-end flush.
- Schedule tool/turn boundary inspections immediately, prevent overlapping inspections, and
  coalesce repeated triggers into at most one pending inspection.
- Disable external diff, textconv, configured filesystem monitors, pagers, prompts, and other avoidable executable Git features.
- Parse, bound, and sanitize the result before atomically writing the Git Snapshot outside the
  guest-writable workspace.
- Persist and notify the browser only when semantic snapshot content changes; timestamps and stale
  metadata do not by themselves count as a change.
- Proxy the current cached Git Snapshot through the connected runner without gateway persistence.
  Live events carry only a change notification, and the browser fetches the full snapshot only while
  the Changes sidebar is open.
- Add aggregate status plus staged and unstaged file groups to a collapsible right sidebar. Each
  complete file row expands/collapses its `@pierre/diffs` viewer and has a Stage or Unstage action.
- Expand omitted diff context through `@pierre/diffs`; do not implement a custom diff renderer.
- Proxy Stage as `git add -A -- <current> [<previous>]` and Unstage as
  `git restore --staged -- <current> [<previous>]` directly to Git inside Gondolin. Always regenerate
  and sync the Git Snapshot after the command, including when it fails.
- Run Stage/Unstage independently of the serial agent-command actor whenever the checkout's Agent
  Environment is available.
- Mark incomplete, stale, and truncated Git Snapshots visibly.

## Acceptance criteria

- Modified, added, deleted, renamed, staged, and untracked states used by the test fixture render correctly.
- Every staged/unstaged file item is one expandable/collapsible row with its action on the right.
- Omitted unmodified lines can be expanded in each renderable diff.
- Stage/Unstage remains available during an active Agent Run without blocking agent commands.
- Staging and unstaging update the workspace's durable real Git index and object database rather
  than a temporary repository.
- A failed mutation refreshes the browser from the latest Git state so the user can try again.
- Large/binary/control-character output is bounded and safely represented.
- No native host Git process consumes the workspace.
- A connected runner can serve the cached Git Snapshot while its VM is stopped.
- An offline runner makes changes unavailable rather than serving a gateway copy.
- Immediate tool/turn scheduling, the worker-lifetime 15-second heartbeat, non-overlap/coalescing,
  semantic deduplication, and awaited run-end flush behave as specified.

## Tests

- Git state fixtures generated inside Gondolin.
- Hostile `.git/config`, hooks, attributes, textconv, filters, fsmonitor, and external commands cannot create a host marker.
- Output bounds and terminal-control sanitization.
- Fixed Stage/Unstage argument arrays, durable index/object writes, and failure refresh.
- Snapshot scheduling, persistence, notification, protocol, route/controller, and rendering tests.

## Not included

Host-side Git parsing, line/hunk staging, editable files, patch download, gateway commit/push, or a
file browser.
