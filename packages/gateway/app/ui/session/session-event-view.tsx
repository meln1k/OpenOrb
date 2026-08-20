import {
  runnerSessionStateForProvisioningStage,
  type SessionEvent,
  sessionEventSchema,
  type SessionUsage,
} from "../../../../../packages/protocol/src/runner-session-events.ts";
import { trySync } from "../../../../result/src/index.ts";
import { parseSafe, string } from "remix/data-schema";
import { clientEntry, css, type Handle } from "remix/ui";

import { Button } from "@/app/ui/components/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/ui/components/card.tsx";

type SessionState = "created" | "provisioning" | "running" | "ready" | "error" | "offline";

export type SessionEventViewProps = {
  canRetry: boolean;
  createdAt: string;
  csrfToken: string;
  eventsHref: string;
  initialState: SessionState;
  projectName: string;
  repositoryUrl: string;
  retryHref: string;
  runnerLabel: string;
  sessionId: string;
};

type ConversationEntry = UserEntry | AssistantEntry | ToolEntry;

interface UserEntry {
  role: "user";
  messageId: string;
  text: string;
}

interface AssistantEntry {
  role: "assistant";
  messageId: string;
  text: string;
  thinking: string;
  stopReason?: string;
  usage?: SessionUsage;
}

interface ToolEntry {
  role: "tool";
  toolCallId: string;
  toolName: string;
  arguments?: string;
  partialResult?: string;
  result?: string;
  isError?: boolean;
}

interface ActivityEntry {
  id: number;
  label: string;
  detail?: string;
  appendKey?: string;
}

interface ActivityUpdate {
  label: string;
  detail?: string;
  status?: string;
  appendKey?: string;
}

const MAX_VISIBLE_ACTIVITY_EVENTS = 50;
const MAX_ACTIVITY_DETAIL_CHARACTERS = 8 * 1024;

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
  let state = handle.props.initialState;
  let status = statusLabel(state);
  let retryVisible = handle.props.canRetry;
  let warningVisible = false;
  let output = "";
  let latestUsage: SessionUsage | undefined;
  let nextActivityId = 1;
  const conversation: ConversationEntry[] = [];
  const activity: ActivityEntry[] = [];

  handle.queueTask(() => {
    const stream = new EventSource(handle.props.eventsHref);
    stream.addEventListener("session", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const source = parseSafe(string(), message.data);
      if (!source.success) return;
      const event = parseSessionEvent(source.value);
      if (!event) return;

      if (event.type === "provisioning.log") {
        output += event.text;
        void handle.update().then((signal) => {
          if (signal.aborted) return;
          const outputElement = document.getElementById(handle.id)?.querySelector<HTMLElement>(
            "[data-session-output]",
          );
          if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
        });
        return;
      }
      if (event.type === "session.state") {
        state = runnerSessionStateForProvisioningStage(event.stage);
        status = sessionStageLabel(event.stage);
        if (event.checkoutState === "unavailable") warningVisible = true;
        retryVisible = state === "error";
        void handle.update();
        return;
      }
      if (event.type === "conversation.reset") {
        conversation.splice(0, conversation.length);
        activity.splice(0, activity.length);
        latestUsage = undefined;
        void handle.update();
        return;
      }
      if (event.type === "assistant.usage.updated" || event.type === "assistant.completed") {
        latestUsage = event.usage;
      }
      const conversationChanged = applyConversationEvent(conversation, event);
      const activityUpdate = activityForEvent(event);
      if (activityUpdate) {
        nextActivityId = recordActivity(activity, activityUpdate, nextActivityId);
        if (activityUpdate.status) status = activityUpdate.status;
      }
      if (conversationChanged || activityUpdate || latestUsage) void handle.update();
    });
    stream.addEventListener("error", () => {
      if (state === "ready" || state === "error") return;
      status = "Connection interrupted";
      void handle.update();
    });
    handle.signal.addEventListener("abort", () => stream.close(), { once: true });
  });

  return () => (
    <section
      id={handle.id}
      aria-label="Session status and conversation"
      data-session-state={state}
      mix={detailGridStyle}
    >
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>
            Session <code>{handle.props.sessionId}</code>
          </CardDescription>
          <CardAction>
            <span data-session-status data-state={state} mix={statusStyle}>
              {status}
            </span>
          </CardAction>
        </CardHeader>
        <CardContent mix={metadataStyle}>
          <div>
            <span>Project</span>
            <strong>{handle.props.projectName}</strong>
          </div>
          <div>
            <span>Repository</span>
            <strong>{handle.props.repositoryUrl}</strong>
          </div>
          <div>
            <span>Runner</span>
            <strong>{handle.props.runnerLabel}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>{handle.props.createdAt}</strong>
          </div>
          {latestUsage
            ? (
              <div>
                <span>Model usage</span>
                <strong>{formatUsage(latestUsage)}</strong>
              </div>
            )
            : null}
          {warningVisible
            ? (
              <p data-session-warning mix={warningStyle}>
                Repository checkout is unavailable. Provisioning completed without branch or setup
                steps.
              </p>
            )
            : null}
          {retryVisible
            ? (
              <form method="post" action={handle.props.retryHref} mix={retryStyle}>
                <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
                <Button type="submit">Retry provisioning</Button>
              </form>
            )
            : null}
        </CardContent>
      </Card>
      {activity.length > 0
        ? (
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>
                Live Pi lifecycle, retry, compaction, and queue activity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol data-session-activity mix={activityStyle}>
                {activity.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.label}</strong>
                    {entry.detail ? <pre>{entry.detail}</pre> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )
        : null}
      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <CardDescription>Runner-owned Pi messages and Gondolin tool activity.</CardDescription>
        </CardHeader>
        <CardContent>
          <div data-session-conversation aria-live="polite" mix={conversationStyle}>
            {conversation.length === 0
              ? (
                <p data-conversation-placeholder mix={emptyConversationStyle}>
                  Waiting for the initial prompt to reach Pi…
                </p>
              )
              : conversation.map(renderConversationEntry)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Provisioning output</CardTitle>
          <CardDescription>Bounded stdout and stderr streamed from the runner.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre
            data-session-output
            aria-live="polite"
            aria-label="Provisioning output"
            mix={outputStyle}
          >{output || "Waiting for runner output…"}</pre>
        </CardContent>
      </Card>
    </section>
  );
}

function applyConversationEvent(
  conversation: ConversationEntry[],
  event: SessionEvent,
): boolean {
  switch (event.type) {
    case "user.message": {
      if (
        conversation.some((entry) => "messageId" in entry && entry.messageId === event.messageId)
      ) {
        return false;
      }
      conversation.push({ role: "user", messageId: event.messageId, text: event.text });
      return true;
    }
    case "assistant.text.delta": {
      const entry = ensureAssistantEntry(conversation, event.messageId);
      entry.text += event.delta;
      return true;
    }
    case "assistant.thinking.delta": {
      const entry = ensureAssistantEntry(conversation, event.messageId);
      entry.thinking += event.delta;
      return true;
    }
    case "assistant.completed": {
      const entry = ensureAssistantEntry(conversation, event.messageId);
      entry.text = event.text;
      entry.thinking = event.thinking;
      entry.stopReason = event.stopReason;
      entry.usage = event.usage;
      return true;
    }
    case "assistant.usage.updated": {
      const entry = ensureAssistantEntry(conversation, event.messageId);
      entry.usage = event.usage;
      return true;
    }
    case "tool.started": {
      if (
        conversation.some((entry) => "toolCallId" in entry && entry.toolCallId === event.toolCallId)
      ) {
        return false;
      }
      conversation.push({
        role: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.arguments,
      });
      return true;
    }
    case "tool.completed": {
      let entry = conversation.find(
        (candidate): candidate is ToolEntry =>
          candidate.role === "tool" && candidate.toolCallId === event.toolCallId,
      );
      if (!entry) {
        entry = {
          role: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        conversation.push(entry);
      }
      entry.result = event.result;
      entry.partialResult = undefined;
      entry.isError = event.isError;
      return true;
    }
    case "tool.updated": {
      let entry = conversation.find(
        (candidate): candidate is ToolEntry =>
          candidate.role === "tool" && candidate.toolCallId === event.toolCallId,
      );
      if (!entry) {
        entry = {
          role: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        conversation.push(entry);
      }
      entry.partialResult = event.partialResult;
      return true;
    }
    default:
      return false;
  }
}

function ensureAssistantEntry(
  conversation: ConversationEntry[],
  messageId: string,
): AssistantEntry {
  const existing = conversation.find(
    (entry): entry is AssistantEntry => entry.role === "assistant" && entry.messageId === messageId,
  );
  if (existing) return existing;
  const entry: AssistantEntry = { role: "assistant", messageId, text: "", thinking: "" };
  conversation.push(entry);
  return entry;
}

function renderConversationEntry(entry: ConversationEntry) {
  switch (entry.role) {
    case "user":
      return (
        <article
          key={`message:${entry.messageId}`}
          data-conversation-entry
          data-message-id={entry.messageId}
          data-role="user"
        >
          <p>{entry.text}</p>
        </article>
      );
    case "assistant":
      return (
        <article
          key={`message:${entry.messageId}`}
          data-conversation-entry
          data-message-id={entry.messageId}
          data-role="assistant"
        >
          <details hidden={entry.thinking.length === 0}>
            <summary>Thinking</summary>
            <pre data-assistant-thinking>{entry.thinking}</pre>
          </details>
          <p data-assistant-text>{entry.text}</p>
          {entry.usage
            ? (
              <small data-assistant-usage mix={entryMetadataStyle}>
                {formatUsage(entry.usage)}
                {entry.stopReason ? ` · ${formatStopReason(entry.stopReason)}` : ""}
              </small>
            )
            : null}
        </article>
      );
    case "tool":
      return (
        <aside
          key={`tool:${entry.toolCallId}`}
          data-conversation-entry
          data-tool-call-id={entry.toolCallId}
          data-role="tool"
        >
          <strong>Tool · {entry.toolName}</strong>
          {entry.arguments === undefined ? null : <pre>{entry.arguments}</pre>}
          {entry.result === undefined && entry.partialResult !== undefined
            ? <pre data-tool-partial-result>{entry.partialResult}</pre>
            : null}
          {entry.result === undefined
            ? null
            : <pre data-tool-result data-error={String(entry.isError)}>{entry.result}</pre>}
        </aside>
      );
  }
}

function activityForEvent(event: SessionEvent): ActivityUpdate | null {
  switch (event.type) {
    case "agent.started":
      return { label: "Agent started", status: "Agent running" };
    case "agent.ended":
      return event.willRetry
        ? { label: "Agent run ended", detail: "Pi will retry.", status: "Waiting to retry" }
        : { label: "Agent run ended", status: "Finishing" };
    case "agent.settled":
      return { label: "Agent settled", status: "Agent settled" };
    case "turn.started":
      return { label: "Turn started", status: "Model responding" };
    case "turn.completed":
      return {
        label: "Turn completed",
        detail: `${event.toolResultCount} tool result${event.toolResultCount === 1 ? "" : "s"}`,
      };
    case "message.started":
      return { label: `${formatMessageRole(event.role)} message started` };
    case "message.completed":
      return { label: `${formatMessageRole(event.role)} message completed` };
    case "assistant.stream.started":
      return { label: "Model stream started", status: "Model responding" };
    case "assistant.content.started":
      return {
        label: event.contentType === "thinking" ? "Thinking started" : "Response started",
        status: event.contentType === "thinking" ? "Agent thinking" : "Agent responding",
      };
    case "assistant.content.completed":
      return {
        label: event.contentType === "thinking" ? "Thinking completed" : "Response completed",
      };
    case "assistant.tool-call.started":
      return { label: "Preparing tool call", status: "Preparing tool" };
    case "assistant.tool-call.completed":
      return { label: `Prepared ${event.toolName} tool call` };
    case "assistant.stream.completed":
      return { label: "Model stream completed", detail: formatStopReason(event.reason) };
    case "assistant.stream.failed":
      return {
        label: event.reason === "aborted" ? "Model stream aborted" : "Model stream failed",
        ...(event.errorMessage === undefined ? {} : { detail: event.errorMessage }),
        status: event.reason === "aborted" ? "Agent aborted" : "Model stream failed",
      };
    case "queue.updated": {
      const count = event.steering.length + event.followUp.length;
      const queuedMessages = [
        ...event.steering.map((message) => `Steering: ${message}`),
        ...event.followUp.map((message) => `Follow-up: ${message}`),
      ];
      return {
        label: "Prompt queue updated",
        detail: queuedMessages.length > 0 ? queuedMessages.join("\n") : "Queue cleared",
        status: count > 0 ? `${count} prompt${count === 1 ? "" : "s"} queued` : undefined,
      };
    }
    case "compaction.started":
      return {
        label: "Context compaction started",
        detail: event.reason,
        status: "Compacting context",
      };
    case "compaction.completed": {
      const details = [event.errorMessage ?? event.summary];
      if (event.tokensBefore !== undefined) {
        details.push(
          event.estimatedTokensAfter === undefined
            ? `${event.tokensBefore} tokens before compaction`
            : `${event.tokensBefore} → ${event.estimatedTokensAfter} estimated tokens`,
        );
      }
      return {
        label: event.aborted ? "Context compaction aborted" : "Context compaction completed",
        detail: details.filter((detail) => detail !== undefined).join("\n"),
        status: event.willRetry ? "Compaction will retry" : "Context compacted",
      };
    }
    case "model.retry.started":
      return {
        label: `Model retry ${event.attempt} of ${event.maxAttempts}`,
        detail: `${event.errorMessage}\nRetrying in ${event.delayMs} ms`,
        status: "Waiting to retry model",
      };
    case "model.retry.completed":
      return {
        label: event.success ? "Model retry succeeded" : "Model retry failed",
        ...(event.finalError === undefined ? {} : { detail: event.finalError }),
        status: event.success ? "Model responding" : "Model retry failed",
      };
    case "summarization.retry.scheduled":
      return {
        label: `Summary retry ${event.attempt} of ${event.maxAttempts} scheduled`,
        detail: `${event.errorMessage}\nRetrying in ${event.delayMs} ms`,
        status: "Waiting to retry summary",
      };
    case "summarization.retry.started":
      return {
        label: "Summary retry started",
        detail: event.source === "compaction" ? `Compaction · ${event.reason}` : "Branch summary",
        status: "Summarizing context",
      };
    case "summarization.retry.completed":
      return { label: "Summary retry completed" };
    case "session.entry.appended":
      return { label: "Pi session updated", detail: event.entryType };
    case "session.info.changed":
      return { label: "Session information changed", detail: event.name ?? "Name cleared" };
    case "thinking-level.changed":
      return { label: "Thinking level changed", detail: event.level };
    case "bash.output.delta":
      return {
        label: "Bash output",
        detail: event.delta,
        appendKey: `bash:${event.id ?? "default"}`,
      };
    case "assistant.tool-call.delta":
    case "assistant.usage.updated":
    case "assistant.text.delta":
    case "assistant.thinking.delta":
    case "conversation.reset":
    case "provisioning.log":
    case "session.state":
    case "user.message":
    case "assistant.completed":
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      return null;
  }
  return assertNever(event);
}

function recordActivity(
  activity: ActivityEntry[],
  update: ActivityUpdate,
  nextId: number,
): number {
  if (update.appendKey) {
    const existing = activity.findLast((entry) => entry.appendKey === update.appendKey);
    if (existing) {
      existing.detail = `${existing.detail ?? ""}${update.detail ?? ""}`.slice(
        -MAX_ACTIVITY_DETAIL_CHARACTERS,
      );
      return nextId;
    }
  }
  activity.push({ id: nextId, ...update });
  if (activity.length > MAX_VISIBLE_ACTIVITY_EVENTS) activity.shift();
  return nextId + 1;
}

function formatUsage(usage: SessionUsage): string {
  const tokens = new Intl.NumberFormat("en").format(usage.totalTokens);
  return usage.totalCost > 0
    ? `${tokens} tokens · $${usage.totalCost.toFixed(4)}`
    : `${tokens} tokens`;
}

function formatStopReason(reason: string): string {
  return reason === "toolUse"
    ? "Tool use"
    : reason === "deferred"
    ? "Deferred"
    : reason.charAt(0).toUpperCase() + reason.slice(1);
}

function formatMessageRole(role: string): string {
  switch (role) {
    case "toolResult":
      return "Tool result";
    case "bashExecution":
      return "Bash";
    case "branchSummary":
      return "Branch summary";
    case "compactionSummary":
      return "Compaction summary";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

function assertNever(_value: never): null {
  return null;
}

function parseSessionEvent(source: string): SessionEvent | null {
  const [value, parseError] = trySync(
    () => parseSafe(sessionEventSchema, JSON.parse(source)),
    () => true,
  );
  if (parseError !== undefined) return null;
  return value.success ? value.value : null;
}

function statusLabel(state: SessionState): string {
  switch (state) {
    case "created":
      return "Queued";
    case "provisioning":
      return "Provisioning";
    case "running":
      return "Agent running";
    case "ready":
      return "Ready";
    case "error":
      return "Failed";
    case "offline":
      return "Runner offline";
  }
}

function sessionStageLabel(
  stage: Extract<SessionEvent, {
    type: "session.state";
  }>["stage"],
): string {
  switch (stage) {
    case "created":
      return "Queued";
    case "starting-vm":
      return "Starting VM";
    case "cloning":
      return "Cloning repository";
    case "creating-branch":
      return "Creating branch";
    case "setup":
      return "Running setup";
    case "running":
      return "Agent running";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

const detailGridStyle = css({ display: "grid", gap: "20px", maxWidth: "1000px" });
const conversationStyle = css({
  display: "grid",
  gap: "16px",
  "& [data-conversation-entry]": {
    display: "grid",
    gap: "8px",
    padding: "14px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  "& [data-role='user']": { background: "var(--muted)" },
  "& p, & pre": { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  "& summary": { color: "var(--muted-foreground)", cursor: "pointer", fontSize: "13px" },
  "& [data-tool-result][data-error='true']": { color: "var(--destructive)" },
});
const activityStyle = css({
  display: "grid",
  gap: "10px",
  margin: 0,
  padding: 0,
  listStyle: "none",
  "& li": {
    display: "grid",
    gap: "4px",
    padding: "10px 12px",
    background: "var(--muted)",
    borderRadius: "var(--radius-md)",
  },
  "& strong": { fontSize: "13px", fontWeight: 600 },
  "& pre": {
    maxHeight: "160px",
    margin: 0,
    overflow: "auto",
    color: "var(--muted-foreground)",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});
const entryMetadataStyle = css({ color: "var(--muted-foreground)", fontSize: "12px" });
const emptyConversationStyle = css({ color: "var(--muted-foreground)", fontSize: "14px" });
const statusStyle = css({
  display: "inline-flex",
  alignItems: "center",
  minHeight: "24px",
  padding: "2px 10px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  "&[data-state='ready']": {
    color: "var(--primary-foreground)",
    background: "var(--primary)",
  },
  "&[data-state='error']": {
    color: "#fff",
    background: "var(--destructive)",
  },
});
const metadataStyle = css({
  display: "grid",
  gap: "12px",
  "& > div": { display: "grid", gap: "2px" },
  "& span": { color: "var(--muted-foreground)", fontSize: "12px" },
  "& strong": { overflowWrap: "anywhere", fontSize: "14px", fontWeight: 500 },
});
const warningStyle = css({
  margin: "4px 0 0",
  padding: "10px 12px",
  color: "var(--foreground)",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  fontSize: "13px",
});
const retryStyle = css({ marginTop: "4px" });
const outputStyle = css({
  minHeight: "220px",
  maxHeight: "480px",
  margin: 0,
  padding: "16px",
  overflow: "auto",
  color: "var(--foreground)",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
});
