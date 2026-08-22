# OO-013 — First real Pi run

**Slice:** 4 — Run a coding conversation  
**Depends on:** OO-003, OO-007, OO-008, OO-012

## Outcome

After provisioning, the stored initial prompt runs through host-side Pi with the browser-selected Pi API-key model, and real text/thinking/tool activity streams to the browser. Tests use `opencode-go/deepseek-v4-flash` with thinking level `high` by default.

## Scope

- Store one encrypted credential per configured Pi provider. The browser selects one opaque `provider/model` reference and never receives or submits the credential value.
- Let the browser select the `tiny` (1 CPU/2 GB), `small` (2 CPUs/4 GB), `medium` (4 CPUs/8 GB), `large` (8 CPUs/16 GB), or `xxlarge` (16 CPUs/32 GB) orb size, defaulting to `medium`.
- Carry the selected orb size in validated provisioning traffic and runner session manifests, persist it only in runner-owned session metadata, and reuse it on retry. Reject sizes above the selected runner's advertised limits without adding gateway session columns.
- Resolve the provider from the model reference at the gateway and deliver that provider's credential, the complete model reference, and the thinking level to the pinned trusted runner only for the active session.
- Configure Pi's model runtime in memory without writing an auth file or falling back to runner-global credentials.
- Create persistent Pi JSONL through the audited factory and enable only Gondolin-backed `read`, `write`, `edit`, and `bash`.
- Treat Pi's `session.jsonl` as the sole durable conversation transcript. Project its active branch into bounded replay/wire events and relay live Pi deltas without creating an OpenOrb transcript or event log.
- Stream a visible warning when `.agents/setup` exits non-zero, then continue to Pi so the prompt can diagnose or repair the project.
- Add runner-backed SSE from browser through gateway, including keepalives and disconnect cleanup.
- Render status, user/assistant content, thinking, tool calls, and tool results in the session page.
- Settle only after Pi's complete retry/compaction lifecycle is idle.

## Acceptance criteria

- A browser-created real prompt receives a response from its selected configured Pi API-key model; the default real-model test uses DeepSeek V4 Flash.
- A browser-created session starts Gondolin with the selected predefined CPU/memory values, and a retry retains that size.
- A prompt can inspect and change the repository only through Gondolin tools.
- Text/thinking/tool activity appears while the run is active.
- Completed conversation history survives browser reconnect through Pi JSONL, with no duplicate OpenOrb transcript.
- Token deltas, full prompt content, and tool output are not persisted by the gateway or infrastructure logs; the only gateway prompt-derived value is the required trimmed `initial_prompt_preview` catalog field.
- The model key never enters Gondolin or Pi auth files.
- A failed `.agents/setup` does not prevent Pi from receiving the stored prompt.
- Composer state reflects real runner/Pi state rather than optimistic completion.

## Tests

- Real-model opt-in E2E test using an externally supplied OpenCode Go key and the default `opencode-go/deepseek-v4-flash` model.
- Pi event normalization and settled-state tests.
- Pi JSONL replay/projection tests proving no OpenOrb transcript file is created.
- SSE framing/keepalive/disconnect tests.
- Credential location/leakage assertions.
- Orb-size protocol, browser, capacity-rejection, persistence, and retry assertions.
- Hostile resource and host-tool security tests remain green in the real run.

## Not included

Follow-up, steering, offline queueing, edit-last, custom provider definitions, or OAuth/subscription provider credentials.
