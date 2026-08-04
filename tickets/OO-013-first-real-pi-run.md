# OO-013 — First real Pi run

**Slice:** 4 — Run a coding conversation  
**Depends on:** OO-003, OO-007, OO-008, OO-012

## Outcome

After provisioning, the stored initial prompt runs through host-side Pi with `opencode-go/deepseek-v4-flash`, and real text/thinking/tool activity streams to the browser.

## Scope

- Deliver the selected OpenCode Go credential to the pinned trusted runner only for the active session.
- Configure Pi's model runtime in memory without writing an auth file or falling back to runner-global credentials.
- Create persistent Pi JSONL through the audited factory and enable only Gondolin-backed `read`, `write`, `edit`, and `bash`.
- Normalize the minimum required Pi events, append completed semantic events/state transitions to runner `events.jsonl`, and relay live deltas.
- Add runner-backed SSE from browser through control panel, including keepalives and disconnect cleanup.
- Render status, user/assistant content, thinking, tool calls, and tool results in the session page.
- Settle only after Pi's complete retry/compaction lifecycle is idle.

## Acceptance criteria

- A browser-created real prompt receives a real DeepSeek V4 Flash response.
- A prompt can inspect and change the repository only through Gondolin tools.
- Text/thinking/tool activity appears while the run is active.
- Completed semantic records survive browser reconnect in runner storage.
- Token deltas, prompt content, and tool output are not persisted by the control panel or infrastructure logs.
- The model key never enters Gondolin or Pi auth files.
- Composer state reflects real runner/Pi state rather than optimistic completion.

## Tests

- Real-model opt-in E2E test using an externally supplied OpenCode Go key.
- Pi event normalization and settled-state tests.
- SSE framing/keepalive/disconnect tests.
- Credential location/leakage assertions.
- Hostile resource and host-tool security tests remain green in the real run.

## Not included

Follow-up, steering, offline queueing, edit-last, or model selection beyond the fixed MVP model.
