import {
  type SessionEvent,
  sessionEventSchema,
  type SessionUsage,
} from "@openorb/protocol/runner-session-events";
import { trySync } from "../../../../result/src/index.ts";
import { object, parseSafe, string } from "remix/data-schema";
import { clientEntry, css, type Handle } from "remix/ui";

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
import {
  activeActivityId,
  createSessionTranscriptState,
  isSessionBusy,
  reduceSessionTranscriptState,
  type SessionState,
  settleSessionTranscriptState,
  type ToolEntry,
  totalSessionUsage,
  type TranscriptEntry,
  usageContextTokens,
} from "@/app/ui/session/session-transcript-state.ts";

export type SessionEventViewProps = {
  canRetry: boolean;
  contextWindow: number;
  csrfToken: string;
  eventsHref: string;
  initialState: SessionState;
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

  handle.queueTask(() => {
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    // Remix flushes updates in microtasks, so use a timer task to coalesce replay bursts.
    const scheduleUpdate = () => {
      if (updateTimer !== undefined) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        if (!handle.signal.aborted) void handle.update();
      }, 0);
    };
    const stream = new EventSource(handle.props.eventsHref);
    stream.addEventListener("open", () => {
      if (!connectionInterrupted) return;
      connectionInterrupted = false;
      scheduleUpdate();
    });
    stream.addEventListener("session", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const source = parseSafe(string(), message.data);
      if (!source.success) return;
      const event = parseSessionEvent(source.value);
      if (!event) return;
      const next = reduceSessionTranscriptState(transcriptState, event);
      if (next === transcriptState) return;
      transcriptState = next;
      scheduleUpdate();
    });
    stream.addEventListener("error", () => {
      const next = settleSessionTranscriptState(transcriptState);
      const interrupted = transcriptState.sessionState !== "ready" &&
        transcriptState.sessionState !== "error";
      if (next === transcriptState && interrupted === connectionInterrupted) return;
      transcriptState = next;
      connectionInterrupted = interrupted;
      scheduleUpdate();
    });
    handle.signal.addEventListener("abort", () => {
      stream.close();
      if (updateTimer !== undefined) clearTimeout(updateTimer);
    }, {
      once: true,
    });
  });

  return () => {
    const currentActivityId = activeActivityId(transcriptState);
    const busy = isSessionBusy(transcriptState.sessionState) && !connectionInterrupted;
    const usage = totalSessionUsage(transcriptState);

    return (
      <section
        id={handle.id}
        aria-label="Session conversation"
        data-session-state={transcriptState.sessionState}
        mix={sessionFrameStyle}
      >
        <header data-session-toolbar mix={sessionToolbarStyle}>
          <Marker mix={sessionStatusMarkerStyle}>
            <MarkerIcon>
              {busy ? <span data-slot="spinner" mix={spinnerStyle} /> : <Icon name="sparkles" />}
            </MarkerIcon>
            <MarkerContent mix={sessionStatusContentStyle}>
              <strong role={busy ? "status" : undefined} data-session-status>
                {connectionInterrupted ? "Connection interrupted" : transcriptState.status}
              </strong>
              {renderUsageStatus(
                usage,
                transcriptState.latestUsage,
                transcriptState.contextUsage,
                handle.props.contextWindow,
              )}
            </MarkerContent>
          </Marker>
          {transcriptState.retryVisible
            ? (
              <form method="post" action={handle.props.retryHref} mix={retryStyle}>
                <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
                <Button type="submit" size="sm">Retry provisioning</Button>
              </form>
            )
            : null}
        </header>
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
              {transcriptState.entries.length === 0
                ? (
                  <MessageScrollerItem>
                    <p data-conversation-placeholder mix={emptyConversationStyle}>
                      Waiting for the initial prompt to reach Pi…
                    </p>
                  </MessageScrollerItem>
                )
                : transcriptState.entries.map((entry) =>
                  renderTranscriptEntry(entry, currentActivityId)
                )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
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
          <article data-conversation-entry data-role="user" mix={userMessageStyle}>
            <p>{entry.text}</p>
          </article>
        </MessageScrollerItem>
      );
    case "assistant": {
      if (entry.text.length === 0 && entry.thinking.length === 0) return null;
      const assistantKey = entry.messageId === undefined
        ? "assistant:active"
        : `message:${entry.messageId}`;
      return (
        <MessageScrollerItem
          key={assistantKey}
          messageId={assistantKey}
        >
          <article data-conversation-entry data-role="assistant" mix={assistantMessageStyle}>
            {entry.thinking.length > 0
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
            {entry.text ? <p data-assistant-text>{entry.text}</p> : null}
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

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    usage.totalCost === 0 &&
    contextWindow <= 0
  ) return null;

  return (
    <div data-session-usage mix={sessionUsageStyle}>
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
  overflow: "hidden",
  color: "var(--foreground)",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  [media.md]: { height: "calc(100svh - 104px)" },
});
const sessionToolbarStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "12px",
  flexShrink: 0,
  minHeight: "56px",
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
});
const sessionStatusMarkerStyle = css({ flex: 1, minWidth: 0, width: "auto" });
const sessionStatusContentStyle = css({
  display: "flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  columnGap: "12px",
  rowGap: "4px",
  minWidth: 0,
  "& strong": { color: "var(--foreground)", fontSize: "14px", fontWeight: 500 },
});
const sessionUsageStyle = css({
  display: "flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  columnGap: "10px",
  rowGap: "2px",
  minWidth: 0,
  fontSize: "12px",
  fontVariantNumeric: "tabular-nums",
  "& > span": { whiteSpace: "nowrap" },
});
const userMessageStyle = css({
  width: "fit-content",
  maxWidth: "min(84%, 640px)",
  marginLeft: "auto",
  padding: "12px 16px",
  color: "var(--accent-foreground)",
  background: "var(--accent)",
  borderRadius: "var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl)",
  "& p": { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
});
const assistantMessageStyle = css({
  display: "grid",
  gap: "16px",
  color: "var(--foreground)",
  "& > p": {
    margin: 0,
    fontSize: "15px",
    lineHeight: 1.75,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
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
const emptyConversationStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  textAlign: "center",
});
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
