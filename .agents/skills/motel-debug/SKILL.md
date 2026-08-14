---
name: motel-debug
description: Debug applications with motel, a local OpenTelemetry ingest and query server. Use when the user wants runtime-evidence debugging with traces or logs, wants temporary debug instrumentation that can be removed later, or needs a repo wired to send OTLP/HTTP telemetry to a local motel server.
---

# Motel Debug

You are in **debug mode**. Debug with runtime evidence, not guesswork.

Motel is the local OpenTelemetry server that collects traces and logs. Use it as the evidence loop.

Default local server details:

- Base URL: `http://127.0.0.1:27686`
- OTLP traces: `POST /v1/traces`
- OTLP logs: `POST /v1/logs`
- Query API: `GET /api/*`
- OpenAPI: `GET /openapi.json`
- Auth: none by default

If the user provides a different Motel URL, use that instead.

## Workflow

### 1. Verify Motel is running

Check `GET /api/health`. If it returns 200, continue.

If it fails, start Motel as a background daemon. Do not launch the interactive TUI:

```bash
motel start
```

In an Amp orb whose repository declares Motel in `.amp/services.yaml`, use `amp orb services ensure`
instead so Amp supervises the process. If `motel` is not on `PATH`, fall back to
`bunx @kitlangton/motel@0.2.6 start`.

After starting, re-check `GET /api/health`. If it still fails, inspect
`${XDG_STATE_HOME:-~/.local/state}/motel/daemon.log` or the supervised service logs.

Discover reporting services with `GET /api/services`.

### 2. Generate hypotheses

Before changing code, generate 3–5 specific hypotheses about why the bug occurs.

### 3. Instrument tagged debug blocks

Add the minimum instrumentation needed to confirm or reject all hypotheses in parallel. Every debug
block must:

- Be wrapped in `#region motel debug` / `#endregion motel debug` markers.
- Include a `debug.hypothesis` attribute linked to a specific hypothesis.
- Use the codebase's tracing or structured logging mechanism, not raw OTLP `fetch` calls.

Reuse these keys:

| Key                | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `debug.session`    | Groups instrumentation for one debug session |
| `debug.hypothesis` | Links evidence to a hypothesis               |
| `debug.step`       | Identifies a position in the flow            |
| `debug.label`      | Describes what the point captures            |

Use 2–6 instrumentation points in typical cases and never more than 10. Do not log secrets, tokens,
passwords, raw prompts, raw tool output, or personally identifiable information.

### 4. Reproduce the issue

- Run a focused failing test when one exists.
- Otherwise use a direct CLI, HTTP, or script reproduction when practical.
- Ask the user to reproduce only when the agent cannot exercise the path itself.
- Reuse the same reproduction for subsequent iterations.

### 5. Analyze evidence

```bash
curl "http://127.0.0.1:27686/api/spans/search?service=<service>&attr.debug.hypothesis=<id>"
curl "http://127.0.0.1:27686/api/logs/search?service=<service>&attr.debug.session=<session>"
curl "http://127.0.0.1:27686/api/traces/search?service=<service>&attr.debug.hypothesis=<id>"
```

Evaluate each hypothesis as **CONFIRMED**, **REJECTED**, or **INCONCLUSIVE**, citing concrete spans,
logs, and attribute values.

### 6. Fix only with evidence

Keep debug instrumentation while making the smallest fix supported by the evidence. Do not allow
speculative changes from rejected hypotheses to accumulate.

### 7. Verify the fix

Run the same reproduction with instrumentation still active and compare before/after evidence. If
the fix fails, remove changes based on rejected hypotheses and investigate a different subsystem.

### 8. Clean up

Only after the fix is verified and the user confirms no issue remains, run the cleanup script or
remove marked blocks manually. Then inspect `git diff` to ensure only the intentional fix remains.

## Instrumentation markers

```ts
// #region motel debug
// temporary debug instrumentation
// #endregion motel debug
```

Adapt the comment syntax for non-TypeScript files.

Do not use sleeps or artificial delays as fixes. Do not remove instrumentation before post-fix
verification succeeds.

## Query patterns

Attribute filters support exact `attr.<key>=<value>` and case-insensitive substring
`attrContains.<key>=<substring>` matches.

```bash
curl http://127.0.0.1:27686/api/health
curl http://127.0.0.1:27686/api/services
curl "http://127.0.0.1:27686/api/traces/search?service=<service>&operation=<text>&attr.debug.session=<session>"
curl "http://127.0.0.1:27686/api/spans/search?service=<service>&traceId=<trace-id>&attr.debug.hypothesis=<id>"
curl "http://127.0.0.1:27686/api/logs/search?service=<service>&severity=ERROR&body=<text>"
curl http://127.0.0.1:27686/openapi.json
```

List and search responses include `meta.nextCursor` when more data is available. Navigate correlated
evidence with `GET /api/traces/<trace-id>/spans` and `GET /api/spans/<span-id>/logs`.

## Cleanup

Run `deno run --allow-read --allow-write scripts/clear-motel-debug.ts [path]` to remove marked debug
blocks from JavaScript and TypeScript files. The script fails on unmatched markers.
