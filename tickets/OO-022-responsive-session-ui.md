# OO-022 — Responsive session UI

**Slice:** 7 — Failure and UX hardening  
**Depends on:** OO-021

## Outcome

The complete MVP workflow is usable at desktop and mobile widths without adding deferred terminal or preview surfaces.

## Scope

- Finish the required screens: setup/login, projects, model credential, GitHub credential, runners, session list/create/conversation/changes.
- Make conversation primary on mobile, session list accessible as a drawer, and Changes a separate tab/sheet.
- Keep composer or Abort reachable without horizontal scrolling.
- Make provisioning, VM, runner, agent, stopped, offline, and failed states distinguishable.
- Add keyboard/focus semantics and accessible labels/status announcements for streaming state.

## Acceptance criteria

- The full Slice 6 path can be completed at representative desktop and phone viewports.
- Streaming content/tool output cannot push primary actions off-screen horizontally.
- Composer visibility/enabled state and Abort match authoritative session state.
- Changes remain readable with bounded large patches.
- Core workflows pass keyboard-only and automated accessibility checks selected by the existing test stack.

## Tests

- Browser tests at desktop and mobile viewports.
- Keyboard navigation and focus after route/state changes.
- Accessibility scan for required screens.
- Long prompt/tool/diff overflow fixtures.

## Not included

Terminal, preview, file browser, full Pi tree UI, visual design system, or native mobile application.
