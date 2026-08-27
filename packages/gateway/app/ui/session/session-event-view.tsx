import {
  type SessionEvent,
  sessionEventSchema,
  type SessionUsage,
} from "@openorb/protocol/browser-session-events";
import { tryAsync, trySync } from "../../../../result/src/index.ts";
import { literal, object, parseSafe, string } from "remix/data-schema";
import { clientEntry, css, type Dispatched, type Handle, on } from "remix/ui";

import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@/app/ui/components/marker.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@/app/ui/components/message-scroller.tsx";
import { media } from "@/app/ui/responsive.ts";
import { AssistantMarkdown } from "@/app/ui/session/session-markdown.tsx";
import {
  activeActivityId,
  appendOptimisticUserMessage,
  createSessionTranscriptState,
  failOptimisticUserMessage,
  isSessionBusy,
  reduceSessionTranscriptState,
  removeOptimisticUserMessage,
  type SessionState,
  type ToolEntry,
  totalSessionUsage,
  type TranscriptEntry,
  usageContextTokens,
} from "@/app/ui/session/session-transcript-state.ts";

export type SessionEventViewProps = {
  abortHref: string;
  canRetry: boolean;
  contextWindow: number;
  csrfToken: string;
  eventsHref: string;
  initialState: SessionState;
  messageHref: string;
  retryHref: string;
  sessionId: string;
};
const bashToolArgumentsSchema = object(
  { command: string() },
  { unknownKeys: "passthrough" },
);
const readToolArgumentsSchema = object(
  { path: string() },
  { unknownKeys: "passthrough" },
);
const actionAcceptedResponseSchema = object(
  { status: literal("accepted" as const) },
  { unknownKeys: "error" },
);
const actionErrorResponseSchema = object(
  { error: string() },
  { unknownKeys: "error" },
);

export const SessionEventView = clientEntry<SessionEventViewProps>(
  import.meta.url,
  function SessionEventView(handle: Handle<SessionEventViewProps>) {
    // Remix applies keys while reconciling child lists, so keep the keyed child in a fragment.
    return () => (
      <>
        <ActiveSessionEventView key={handle.props.sessionId} {...handle.props} />
      </>
    );
  },
);

function ActiveSessionEventView(handle: Handle<SessionEventViewProps>) {
  let transcriptState = createSessionTranscriptState(
    handle.props.initialState,
    handle.props.canRetry,
  );
  let connectionInterrupted = false;
  let promptRequestPending = false;
  let promptDraftPresent = false;
  let abortPending = false;
  let actionError: string | undefined;
  const abortFormId = `session-${handle.props.sessionId}-abort`;

  async function submitAbort(
    event: Dispatched<SubmitEvent, HTMLFormElement>,
  ) {
    event.preventDefault();
    if (
      transcriptState.sessionState !== "running" || connectionInterrupted || abortPending
    ) return;

    const form = event.currentTarget;
    abortPending = true;
    actionError = undefined;
    await handle.update();
    if (handle.signal.aborted) return;

    const [response, requestError] = await tryAsync(
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: handle.signal,
      }),
      () => true,
    );
    if (requestError !== undefined) {
      if (handle.signal.aborted) return;
      abortPending = false;
      actionError =
        "Abort acknowledgement was lost. The run may still be stopping; wait for session state before trying again.";
      await handle.update();
      return;
    }
    if (handle.signal.aborted) return;
    if (response.ok) {
      const accepted = await actionResponseAccepted(response);
      if (handle.signal.aborted || accepted) return;
      abortPending = false;
      actionError =
        "Abort acknowledgement was invalid. The run may still be stopping; wait for session state before trying again.";
      await handle.update();
      return;
    }
    abortPending = false;
    actionError = await actionResponseError(response, "Abort was not accepted");
    if (!handle.signal.aborted) await handle.update();
  }

  const abortSubmit = on<HTMLFormElement, "submit">("submit", submitAbort);

  handle.queueTask(() => {
    if (handle.props.initialState === "offline") return;
    let updateFrame: number | undefined;
    const stream = new EventSource(handle.props.eventsHref);
    // Reconcile at most once per paint while retaining every event in transcriptState.
    const scheduleUpdate = () => {
      if (updateFrame !== undefined) return;
      updateFrame = requestAnimationFrame(() => {
        updateFrame = undefined;
        if (!handle.signal.aborted) void handle.update();
      });
    };
    stream.addEventListener("open", () => {
      if (!connectionInterrupted) return;
      connectionInterrupted = false;
      scheduleUpdate();
    });
    stream.addEventListener("session", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const encoded = parseSafe(string(), message.data);
      if (!encoded.success) return;
      const event = parseSessionEvent(encoded.value);
      if (!event) return;
      if (event.type === "session.state" && event.stage !== "running") abortPending = false;
      const next = reduceSessionTranscriptState(transcriptState, event);
      if (next === transcriptState) return;
      transcriptState = next;
      scheduleUpdate();
    });
    stream.addEventListener("error", () => {
      if (!connectionInterrupted) {
        connectionInterrupted = true;
        scheduleUpdate();
      }
    });
    handle.signal.addEventListener("abort", () => {
      stream.close();
      if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
    }, {
      once: true,
    });
  });

  return () => {
    const currentActivityId = activeActivityId(transcriptState);
    const busy = isSessionBusy(transcriptState.sessionState) && !connectionInterrupted;
    const hasActiveRun = transcriptState.sessionState === "running";
    const canComposePrompt = (transcriptState.sessionState === "ready" || hasActiveRun) &&
      !connectionInterrupted && !abortPending;
    const canSubmitPrompt = canComposePrompt && !promptRequestPending;
    const canAbort = hasActiveRun && !connectionInterrupted && !abortPending;
    const usage = totalSessionUsage(transcriptState);
    const status = connectionInterrupted
      ? "Connection interrupted"
      : abortPending
      ? "Aborting…"
      : transcriptState.status;

    return (
      <section
        id={handle.id}
        aria-label="Session conversation"
        data-session-state={transcriptState.sessionState}
        mix={sessionFrameStyle}
      >
        <span role="status" data-session-status mix={screenReaderOnlyStyle}>{status}</span>
        {hasActiveRun
          ? (
            <form
              id={abortFormId}
              method="post"
              action={handle.props.abortHref}
              mix={abortSubmit}
            >
              <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
            </form>
          )
          : null}
        {transcriptState.retryVisible
          ? (
            <form method="post" action={handle.props.retryHref} mix={retryStyle}>
              <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
              <Button type="submit" size="sm">Retry provisioning</Button>
            </form>
          )
          : null}
        {actionError ? <p role="alert" mix={actionErrorStyle}>{actionError}</p> : null}
        <MessageScroller
          autoScroll
          defaultScrollPosition="last-anchor"
          scrollPreviousItemPeek={64}
        >
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={busy || undefined}
              data-session-conversation
            >
              {transcriptState.warningVisible
                ? (
                  <MessageScrollerItem messageId="session:checkout-warning">
                    <Marker data-session-warning mix={richMarkerStyle}>
                      <MarkerIcon>
                        <Icon name="activity" />
                      </MarkerIcon>
                      <MarkerContent>
                        Repository checkout is unavailable. Provisioning completed without branch or
                        setup steps.
                      </MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )
                : null}
              {transcriptState.followUpQueue.length > 0
                ? (
                  <MessageScrollerItem messageId="session:follow-up-queue">
                    <Marker data-follow-up-queue mix={richMarkerStyle}>
                      <MarkerIcon>
                        <Icon name="activity" />
                      </MarkerIcon>
                      <MarkerContent mix={queueDetailStyle}>
                        <strong>
                          {transcriptState.followUpQueue.length}{" "}
                          follow-up{transcriptState.followUpQueue.length === 1 ? "" : "s"} queued
                        </strong>
                        <ol>
                          {transcriptState.followUpQueue.map((prompt, index) => (
                            <li key={`${index}:${prompt}`}>{prompt}</li>
                          ))}
                        </ol>
                      </MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )
                : null}
              {transcriptState.entries.length === 0
                ? (
                  <MessageScrollerItem>
                    <p data-conversation-placeholder mix={emptyConversationStyle}>
                      {transcriptState.sessionState === "offline"
                        ? "Conversation history is unavailable while the pinned runner is offline."
                        : "Waiting for the initial prompt to reach Pi…"}
                    </p>
                  </MessageScrollerItem>
                )
                : transcriptState.entries.map((entry) =>
                  renderTranscriptEntry(entry, currentActivityId)
                )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton mix={scrollButtonStyle} />
        </MessageScroller>
        <form
          method="post"
          action={handle.props.messageHref}
          mix={[
            sessionFooterItemStyle,
            promptFormStyle,
            on<HTMLFormElement, "submit">("submit", async (event) => {
              event.preventDefault();
              if (
                promptRequestPending || connectionInterrupted ||
                abortPending ||
                (transcriptState.sessionState !== "ready" &&
                  transcriptState.sessionState !== "running")
              ) return;

              const form = event.currentTarget;
              const formData = new FormData(form);
              const prompt = parseSafe(string(), formData.get("prompt"));
              if (!prompt.success || prompt.value.trim().length === 0) return;

              const optimisticId = `optimistic:${crypto.randomUUID()}`;
              const followUpSubmission = transcriptState.sessionState === "running";
              actionError = undefined;
              promptRequestPending = true;
              transcriptState = appendOptimisticUserMessage(
                transcriptState,
                optimisticId,
                prompt.value,
              );
              const action = form.action;
              form.reset();
              promptDraftPresent = false;
              await handle.update();
              if (handle.signal.aborted) return;

              const [response, requestError] = await tryAsync(
                fetch(action, {
                  method: "POST",
                  body: formData,
                  credentials: "same-origin",
                  headers: { Accept: "application/json" },
                  redirect: "manual",
                  signal: handle.signal,
                }),
                () => true,
              );
              if (requestError !== undefined) {
                if (handle.signal.aborted) return;
                promptRequestPending = false;
                transcriptState = failOptimisticUserMessage(
                  transcriptState,
                  optimisticId,
                  "Message acknowledgement was lost. Delivery is uncertain; check the live session before trying again.",
                );
                await handle.update();
                return;
              }
              if (handle.signal.aborted) return;
              if (response.ok) {
                const accepted = await actionResponseAccepted(response);
                if (handle.signal.aborted) return;
                promptRequestPending = false;
                if (!accepted) {
                  transcriptState = failOptimisticUserMessage(
                    transcriptState,
                    optimisticId,
                    "Message acknowledgement was invalid. Delivery is uncertain; check the live session before trying again.",
                  );
                  await handle.update();
                  return;
                }
                if (followUpSubmission) {
                  transcriptState = removeOptimisticUserMessage(transcriptState, optimisticId);
                }
                await handle.update();
                return;
              }
              const deliveryError = await actionResponseError(
                response,
                "Message was not accepted",
              );
              if (handle.signal.aborted) return;

              promptRequestPending = false;
              transcriptState = failOptimisticUserMessage(
                transcriptState,
                optimisticId,
                deliveryError,
              );
              await handle.update();
            }),
          ]}
        >
          <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
          <textarea
            name="prompt"
            aria-label="Continue session"
            placeholder={canComposePrompt
              ? hasActiveRun ? "Queue a follow-up…" : "Continue the session…"
              : abortPending
              ? "Wait for the abort to finish…"
              : "Wait until the session can accept a prompt…"}
            required
            disabled={!canComposePrompt}
            mix={[
              promptInputStyle,
              on<HTMLTextAreaElement, "input">("input", (event) => {
                const nextPromptDraftPresent = event.currentTarget.value.trim().length > 0;
                if (promptDraftPresent === nextPromptDraftPresent) return;
                promptDraftPresent = nextPromptDraftPresent;
                void handle.update();
              }),
              on<HTMLTextAreaElement, "keydown">("keydown", (event) => {
                if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
                event.preventDefault();
                if (!event.currentTarget.disabled) event.currentTarget.form?.requestSubmit();
              }),
            ]}
          />
          {!hasActiveRun || promptDraftPresent
            ? (
              <Button
                type="submit"
                size="icon-lg"
                aria-label={hasActiveRun ? "Queue follow-up" : "Send prompt"}
                title={canSubmitPrompt
                  ? hasActiveRun ? "Queue follow-up" : "Send prompt"
                  : promptRequestPending
                  ? "Wait for prompt acknowledgement"
                  : "Session cannot accept a prompt"}
                disabled={!canSubmitPrompt}
                mix={sendButtonStyle}
              >
                <Icon name="arrow-right" size={16} />
              </Button>
            )
            : null}
          {hasActiveRun
            ? (
              <Button
                type="submit"
                form={abortFormId}
                size="icon-lg"
                aria-label="Stop active turn"
                title={canAbort
                  ? "Stop active turn"
                  : abortPending
                  ? "Stopping active turn"
                  : "Active turn cannot be stopped"}
                disabled={!canAbort}
                mix={sendButtonStyle}
              >
                <span aria-hidden="true" data-slot="stop-icon" mix={stopIconStyle} />
              </Button>
            )
            : null}
        </form>
        {renderUsageStatus(
          usage,
          transcriptState.latestUsage,
          transcriptState.contextUsage,
          handle.props.contextWindow,
        )}
      </section>
    );
  };
}

function renderTranscriptEntry(entry: TranscriptEntry, activeActivityId: number | undefined) {
  if (!("role" in entry)) {
    const active = entry.id === activeActivityId;
    return (
      <MessageScrollerItem key={`activity:${entry.id}`} messageId={`activity:${entry.id}`}>
        <Marker
          role={active ? "status" : undefined}
          data-session-activity
          mix={richMarkerStyle}
        >
          <MarkerIcon>
            {active ? <span data-slot="spinner" mix={spinnerStyle} /> : <Icon name="activity" />}
          </MarkerIcon>
          <MarkerContent mix={markerDetailStyle}>
            <strong>{entry.label}</strong>
            {entry.detail
              ? entry.detail.includes("\n") || entry.detail.length > 160
                ? (
                  <details>
                    <summary>Details</summary>
                    <pre>{entry.detail}</pre>
                  </details>
                )
                : <span data-activity-detail>{entry.detail}</span>
              : null}
          </MarkerContent>
        </Marker>
      </MessageScrollerItem>
    );
  }

  switch (entry.role) {
    case "user":
      return (
        <MessageScrollerItem
          key={`message:${entry.messageId}`}
          messageId={`message:${entry.messageId}`}
          scrollAnchor
        >
          <article
            data-conversation-entry
            data-role="user"
            data-delivery={entry.delivery}
            aria-invalid={entry.delivery === "failed" || undefined}
            mix={userMessageStyle}
          >
            <p>{entry.text}</p>
            {entry.delivery === "pending"
              ? <small role="status" data-prompt-delivery>Sending…</small>
              : entry.delivery === "failed"
              ? <small role="alert" data-prompt-delivery>{entry.deliveryError}</small>
              : null}
          </article>
        </MessageScrollerItem>
      );
    case "assistant": {
      const hasText = entry.text.trim().length > 0;
      const hasThinking = entry.thinking.trim().length > 0;
      if (!hasText && !hasThinking) return null;
      const assistantKey = entry.messageId === undefined
        ? "assistant:active"
        : `message:${entry.messageId}`;
      return (
        <MessageScrollerItem
          key={assistantKey}
          messageId={assistantKey}
        >
          <article data-conversation-entry data-role="assistant" mix={assistantMessageStyle}>
            {hasThinking
              ? (
                <Marker
                  role={entry.completed ? undefined : "status"}
                  data-assistant-thinking
                  mix={richMarkerStyle}
                >
                  <MarkerIcon>
                    {entry.completed
                      ? <Icon name="brain" />
                      : <span data-slot="spinner" mix={spinnerStyle} />}
                  </MarkerIcon>
                  <MarkerContent mix={markerDetailStyle}>
                    <details>
                      <summary>Thinking</summary>
                      <pre>{entry.thinking}</pre>
                    </details>
                  </MarkerContent>
                </Marker>
              )
              : null}
            {hasText ? <AssistantMarkdown text={entry.text} completed={entry.completed} /> : null}
          </article>
        </MessageScrollerItem>
      );
    }
    case "tool": {
      const bashCommand = commandForBashTool(entry);
      const readPath = pathForReadTool(entry);
      return (
        <MessageScrollerItem
          key={`tool:${entry.toolCallId}`}
          messageId={`tool:${entry.toolCallId}`}
          mix={toolItemStyle}
        >
          <Marker
            role={entry.active ? "status" : undefined}
            data-conversation-entry
            data-tool-call-id={entry.toolCallId}
            data-role="tool"
            mix={richMarkerStyle}
          >
            <MarkerIcon>
              {entry.active ? <span data-slot="spinner" mix={spinnerStyle} /> : (
                <Icon
                  name={entry.toolName === "bash"
                    ? "terminal"
                    : entry.toolName === "read"
                    ? "book-open-text"
                    : "wrench"}
                />
              )}
            </MarkerIcon>
            <MarkerContent mix={markerDetailStyle}>
              {readPath === undefined
                ? (
                  <details open={entry.active && bashCommand === undefined ? true : undefined}>
                    <summary title={bashCommand}>{bashCommand ?? entry.toolName}</summary>
                    {bashCommand === undefined && entry.arguments
                      ? <pre data-tool-arguments>{entry.arguments}</pre>
                      : null}
                    {entry.result === undefined && entry.partialResult
                      ? <pre data-tool-partial-result>{entry.partialResult}</pre>
                      : null}
                    {entry.result !== undefined
                      ? (
                        <pre data-tool-result data-error={String(entry.isError)}>
                          {entry.result || "No output"}
                        </pre>
                      )
                      : null}
                  </details>
                )
                : (
                  <span data-read-path title={readPath}>
                    <span dir="ltr">{readPath}</span>
                  </span>
                )}
            </MarkerContent>
          </Marker>
        </MessageScrollerItem>
      );
    }
    case "provisioning":
      return (
        <MessageScrollerItem key="provisioning:output" messageId="provisioning:output">
          <Marker data-session-output mix={richMarkerStyle}>
            <MarkerIcon>
              <Icon name="terminal" />
            </MarkerIcon>
            <MarkerContent mix={markerDetailStyle}>
              <details>
                <summary>Provisioning output</summary>
                <pre>{entry.text}</pre>
              </details>
            </MarkerContent>
          </Marker>
        </MessageScrollerItem>
      );
  }
}

function commandForBashTool(entry: ToolEntry): string | undefined {
  const argumentsText = entry.arguments;
  if (entry.toolName !== "bash" || argumentsText === undefined) return undefined;
  const [argumentsValue, parseError] = trySync(
    () => JSON.parse(argumentsText),
    () => true,
  );
  if (parseError !== undefined) return undefined;
  const parsed = parseSafe(bashToolArgumentsSchema, argumentsValue);
  return parsed.success && parsed.value.command.length > 0 ? parsed.value.command : undefined;
}

function pathForReadTool(entry: ToolEntry): string | undefined {
  const argumentsText = entry.arguments;
  if (entry.toolName !== "read" || argumentsText === undefined) return undefined;
  const [argumentsValue, parseError] = trySync(
    () => JSON.parse(argumentsText),
    () => true,
  );
  if (parseError !== undefined) return undefined;
  const parsed = parseSafe(readToolArgumentsSchema, argumentsValue);
  return parsed.success && parsed.value.path.length > 0 ? parsed.value.path : undefined;
}

function renderUsageStatus(
  usage: SessionUsage,
  latestUsage: SessionUsage | undefined,
  contextUsage: SessionUsage | undefined,
  contextWindow: number,
) {
  const latestPromptTokens = latestUsage === undefined
    ? 0
    : latestUsage.inputTokens + latestUsage.cacheReadTokens + latestUsage.cacheWriteTokens;
  const cacheHitRate = latestPromptTokens > 0 && latestUsage !== undefined
    ? latestUsage.cacheReadTokens / latestPromptTokens * 100
    : undefined;
  const contextTokens = contextUsage === undefined ? 0 : usageContextTokens(contextUsage);
  const contextPercent = contextUsage !== undefined && contextWindow > 0
    ? contextTokens / contextWindow * 100
    : undefined;

  return (
    <div data-session-usage mix={[sessionFooterItemStyle, sessionUsageStyle]}>
      {usage.inputTokens > 0
        ? (
          <span title="Cumulative input tokens">
            <span mix={screenReaderOnlyStyle}>Input tokens:</span>
            <span aria-hidden="true">↑</span>
            {formatTokens(usage.inputTokens)}
          </span>
        )
        : null}
      {usage.outputTokens > 0
        ? (
          <span title="Cumulative output tokens">
            <span mix={screenReaderOnlyStyle}>Output tokens:</span>
            <span aria-hidden="true">↓</span>
            {formatTokens(usage.outputTokens)}
          </span>
        )
        : null}
      {usage.cacheWriteTokens > 0
        ? (
          <span title="Cumulative prompt-cache writes">
            <span mix={screenReaderOnlyStyle}>Prompt-cache write tokens:</span>
            <span aria-hidden="true">W</span>
            {formatTokens(usage.cacheWriteTokens)}
          </span>
        )
        : null}
      {(usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) && cacheHitRate !== undefined
        ? (
          <span title="Latest prompt cache hit rate">
            <span mix={screenReaderOnlyStyle}>Latest prompt cache hit rate:</span>
            <span aria-hidden="true">CH</span>
            {cacheHitRate.toFixed(1)}%
          </span>
        )
        : null}
      {usage.totalCost > 0
        ? (
          <span title="Cumulative model cost">
            <span mix={screenReaderOnlyStyle}>Cumulative model cost in US dollars:</span>
            <span aria-hidden="true">$</span>
            {formatCost(usage.totalCost)}
          </span>
        )
        : null}
      {contextWindow > 0
        ? (
          <span title="Context window use">
            <span aria-hidden="true">
              {contextPercent === undefined ? "?" : `${contextPercent.toFixed(1)}%`}/
              {formatTokens(contextWindow)}
            </span>
            <span mix={screenReaderOnlyStyle}>
              {contextPercent === undefined
                ? ` Context use unknown; ${contextWindow.toLocaleString("en")} token window`
                : ` ${contextPercent.toFixed(1)} percent of ${
                  contextWindow.toLocaleString("en")
                } token context window used`}
            </span>
          </span>
        )
        : null}
    </div>
  );
}

async function actionResponseAccepted(response: Response): Promise<boolean> {
  const [body, readError] = await tryAsync(response.json(), () => true);
  if (readError !== undefined) return false;
  return parseSafe(actionAcceptedResponseSchema, body).success;
}

async function actionResponseError(response: Response, label: string): Promise<string> {
  const fallback = response.status > 0 ? `${label} (${response.status}).` : `${label}.`;
  const [body, readError] = await tryAsync(response.json(), () => true);
  if (readError !== undefined) return fallback;
  const parsed = parseSafe(actionErrorResponseSchema, body);
  return parsed.success && parsed.value.error.trim() ? parsed.value.error : fallback;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3);
}

function parseSessionEvent(source: string): SessionEvent | null {
  const [value, parseError] = trySync(
    () => parseSafe(sessionEventSchema, JSON.parse(source)),
    () => true,
  );
  if (parseError !== undefined) return null;
  return value.success ? value.value : null;
}

const sessionFrameStyle = css({
  display: "flex",
  flexDirection: "column",
  width: "100%",
  maxWidth: "1100px",
  height: "calc(100svh - 80px)",
  minHeight: "440px",
  marginInline: "auto",
  overflow: "hidden",
  color: "var(--foreground)",
  background: "transparent",
  [media.md]: {
    // Extend into 8px of shell padding without changing the frame's outer size.
    height: "calc(100svh - 104px + 8px)",
    marginBottom: "-8px",
  },
});
const sessionFooterItemStyle = css({
  boxSizing: "border-box",
  flexShrink: 0,
  width: "min(calc(100% - 16px), calc(50% + 400px))",
  minWidth: 0,
  marginInline: "auto",
});
const sessionUsageStyle = css({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "flex-start",
  flexWrap: "wrap",
  columnGap: "10px",
  rowGap: "2px",
  minHeight: "18px",
  marginBlock: 0,
  paddingInline: "12px",
  color: "var(--muted-foreground)",
  fontSize: "12px",
  fontVariantNumeric: "tabular-nums",
  "& > span": { whiteSpace: "nowrap" },
});
const actionErrorStyle = css({
  flexShrink: 0,
  margin: 0,
  padding: "10px 16px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 10%, transparent)",
  fontSize: "13px",
});
const userMessageStyle = css({
  display: "grid",
  gap: "4px",
  width: "fit-content",
  maxWidth: "min(84%, 640px)",
  marginLeft: "auto",
  padding: "12px 16px",
  color: "var(--accent-foreground)",
  background: "var(--accent)",
  borderRadius: "var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl)",
  "& p": { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  "&[data-delivery='pending']": { opacity: 0.72 },
  "&[data-delivery='failed']": {
    color: "var(--destructive)",
    background: "color-mix(in oklab, var(--destructive) 10%, var(--background))",
  },
  "& [data-prompt-delivery]": {
    color: "var(--muted-foreground)",
    fontSize: "11px",
    lineHeight: 1.4,
  },
  "&[data-delivery='failed'] [data-prompt-delivery]": { color: "var(--destructive)" },
});
const assistantMessageStyle = css({
  display: "grid",
  gap: "16px",
  minWidth: 0,
  color: "var(--foreground)",
});
const toolItemStyle = css({ marginTop: "-16px" });
const richMarkerStyle = css({ alignItems: "flex-start" });
const markerDetailStyle = css({
  display: "grid",
  flex: 1,
  gap: "6px",
  "& strong, & summary, & [data-read-path]": {
    color: "var(--muted-foreground)",
    fontSize: "13px",
    fontWeight: 500,
  },
  "& summary": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
    paddingLeft: "24px",
    overflow: "hidden",
    cursor: "pointer",
    listStyle: "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  "& summary::marker": { content: "''" },
  "& summary::-webkit-details-marker": { display: "none" },
  "& [data-read-path]": {
    display: "block",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    direction: "rtl",
    textAlign: "left",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  "& details": {
    width: "calc(100% + 24px)",
    minWidth: 0,
    marginLeft: "-24px",
  },
  "& [data-activity-detail]": {
    color: "var(--muted-foreground)",
    fontSize: "12px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  "& pre": {
    boxSizing: "border-box",
    width: "100%",
    maxHeight: "280px",
    margin: "8px 0 0",
    padding: "12px",
    overflow: "auto",
    color: "var(--foreground)",
    background: "var(--muted)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  "& [data-tool-result][data-error='true']": { color: "var(--destructive)" },
});
const queueDetailStyle = css({
  display: "grid",
  gap: "6px",
  color: "var(--muted-foreground)",
  fontSize: "13px",
  "& strong": { color: "var(--foreground)", fontWeight: 500 },
  "& ol": { display: "grid", gap: "4px", margin: 0, paddingLeft: "20px" },
  "& li": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
});
const emptyConversationStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  textAlign: "center",
});
const promptFormStyle = css({
  display: "flex",
  alignItems: "flex-end",
  gap: "8px",
  minHeight: "104px",
  marginBlock: "0 8px",
  padding: "12px",
  background: "color-mix(in oklab, var(--muted) 50%, var(--background))",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  boxShadow: "0 1px 3px rgb(0 0 0 / 0.08)",
  transition: "border-color 150ms ease",
  "&:focus-within": {
    borderColor: "color-mix(in oklab, var(--border) 88%, black)",
  },
});
const promptInputStyle = css({
  boxSizing: "border-box",
  flex: 1,
  width: "100%",
  minWidth: 0,
  minHeight: "76px",
  maxHeight: "160px",
  padding: "8px",
  color: "var(--foreground)",
  background: "transparent",
  border: 0,
  borderRadius: 0,
  outline: "none",
  resize: "none",
  font: "inherit",
  fontSize: "14px",
  lineHeight: 1.5,
  "&:focus": { boxShadow: "none" },
  "&:disabled": { cursor: "not-allowed", opacity: 0.6 },
});
const sendButtonStyle = css({
  width: "33px",
  height: "33px",
  borderRadius: "999px",
});
const stopIconStyle = css({
  width: "10px",
  height: "10px",
  background: "currentColor",
  borderRadius: "2px",
});
const scrollButtonStyle = css({ border: 0 });
const spinnerStyle = css({
  display: "block",
  width: "14px",
  height: "14px",
  border: "2px solid color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
  borderTopColor: "var(--muted-foreground)",
  borderRadius: "999px",
  animation: "openorb-session-spin 800ms linear infinite",
  "@keyframes openorb-session-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});
const retryStyle = css({ flexShrink: 0, margin: 0 });
const screenReaderOnlyStyle = css({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
});
