# OO-016 — Guest Git report and Changes UI

**Slice:** 5 — Review and push  
**Depends on:** OO-015

## Outcome

After each settled run, the user reviews a bounded Git status/diff produced inside Gondolin and cached by the runner.

## Scope

- Run controlled status/diff commands inside the session VM after Pi settles.
- Disable external diff, textconv, configured filesystem monitors, pagers, prompts, and other avoidable executable Git features.
- Parse, bound, and sanitize the result before writing reports outside the guest-writable workspace.
- Proxy the current/cached report through the connected runner without control-panel persistence.
- Add aggregate status, changed-file list, and patch display to the session Changes view.
- Mark incomplete/stale reports visibly.

## Acceptance criteria

- Modified, added, deleted, renamed, staged, and untracked states used by the test fixture render correctly.
- Large/binary/control-character output is bounded and safely represented.
- No native host Git process consumes the workspace.
- A connected runner can serve the cached report while its VM is stopped.
- An offline runner makes changes unavailable rather than serving a control-panel copy.

## Tests

- Git state fixtures generated inside Gondolin.
- Hostile `.git/config`, hooks, attributes, textconv, filters, fsmonitor, and external commands cannot create a host marker.
- Output bounds and terminal-control sanitization.
- Changes route/controller and rendering tests.

## Not included

Host-side Git parsing, editable files, patch download, control-panel commit/push, or a file browser.
