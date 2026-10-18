import { applyImmutable } from "@earendil-works/chord/delta";
import type { JsonObject } from "@earendil-works/pi-durable";
import type {
  ConversationView,
  SessionEvent,
  SessionProvisioningStage,
  SessionState as ViewState,
} from "../../../cells/session/view.ts";
import {
  THREAD_MESSAGE_KIND,
  threadMessageBody,
  type ThreadMessageData,
} from "../../../../../protocol/src/thread-message.ts";
import {
  SESSION_THINKING_LEVELS,
  type SessionThinkingLevel,
} from "../../../../../protocol/src/thinking-level.ts";

export class ConversationFrameError extends Error {}

export type SessionState = ViewState | "offline";

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly totalCost: number;
}
export function runnerSessionStateForProvisioningStage(
  stage: SessionProvisioningStage,
): SessionState {
  switch (stage) {
    case "created":
    case "ready":
    case "stopped":
    case "running":
      return stage;
    case "failed":
      return "error";
    default:
      return "provisioning";
  }
}
export interface UserEntry {
  readonly role: "user";
  readonly messageId: string;
  readonly text: string;
  readonly delivery?: "pending" | "failed";
  readonly deliveryError?: string;
}
/** A prompt another thread sent this one: its parent or one of its children (ADR 0010). */
export interface ThreadMessageEntry extends ThreadMessageData {
  readonly role: "thread";
  readonly messageId: string;
  /** What the sender wrote, without the label the model reads. */
  readonly text: string;
}
/** A prompt waiting for the run to end: the user's follow-up, or a message from another thread. */
export interface QueuedPrompt {
  /** What the user or the sending thread wrote, without the label the model reads. */
  readonly text: string;
  readonly sender?: ThreadMessageData;
}
export interface AssistantEntry {
  readonly role: "assistant";
  readonly messageId?: string;
  readonly text: string;
  readonly thinking: string;
  readonly completed: boolean;
}
export interface ToolEntry {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly active: boolean;
  readonly arguments?: string;
  readonly partialResult?: string | undefined;
  readonly result?: string;
  readonly isError?: boolean;
}
export interface ActivityEntry {
  readonly id: number;
  readonly label: string;
  readonly detail?: string;
  readonly inProgress?: boolean;
}
/** A project command's outcome while the environment was prepared: clone, setup, or resume. */
export interface SetupEntry {
  readonly role: "setup";
  readonly id: number;
  readonly step: string;
  readonly exitCode: number;
  readonly output: string;
}
export type TranscriptEntry =
  | UserEntry
  | ThreadMessageEntry
  | AssistantEntry
  | ToolEntry
  | ActivityEntry
  | SetupEntry;
export interface SessionTranscriptState {
  readonly view: ConversationView | undefined;
  readonly status: string;
  readonly thinkingLevel: SessionThinkingLevel;
  readonly warningVisible: boolean;
  readonly followUpQueue: readonly QueuedPrompt[];
  readonly entries: readonly TranscriptEntry[];
  readonly latestUsage: SessionUsage | undefined;
  readonly contextUsage: SessionUsage | undefined;
  readonly totalUsage: SessionUsage;
}

export function createSessionTranscriptState(
  initialState: SessionState,
  thinkingLevel: SessionThinkingLevel,
): SessionTranscriptState {
  return {
    view: undefined,
    status: initialState,
    thinkingLevel,
    warningVisible: false,
    followUpQueue: [],
    entries: [],
    latestUsage: undefined,
    contextUsage: undefined,
    totalUsage: emptyUsage(),
  };
}
export function appendOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
  text: string,
): SessionTranscriptState {
  return {
    ...state,
    entries: [...state.entries, { role: "user", messageId, text, delivery: "pending" }],
  };
}
export function failOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
  deliveryError: string,
): SessionTranscriptState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      "role" in entry && entry.role === "user" && entry.messageId === messageId && entry.delivery
        ? { ...entry, delivery: "failed", deliveryError }
        : entry,
    ),
  };
}
export function removeOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
): SessionTranscriptState {
  return {
    ...state,
    entries: state.entries.filter(
      (entry) =>
        !(
          "role" in entry &&
          entry.role === "user" &&
          entry.messageId === messageId &&
          entry.delivery
        ),
    ),
  };
}

/** Snapshots replace; an ops batch is applied atomically, then projected once. */
export function reduceSessionTranscriptState(
  state: SessionTranscriptState,
  event: SessionEvent,
  _sessionState?: SessionState,
): SessionTranscriptState {
  if (event.type === "session.state") {
    return {
      ...state,
      status: `Agent ${event.agentState} · Environment ${event.environmentState}`,
      warningVisible: event.checkoutState === "unavailable",
    };
  }
  if (event.type === "git.snapshot.updated") return state;
  if (event.type === "conversation.ops" && state.view === undefined) {
    throw new ConversationFrameError("Conversation ops received before a snapshot.");
  }
  const view =
    event.type === "conversation.snapshot" ? event.view : applyImmutable(state.view, event.ops);
  const projected = projectConversation(view, state.thinkingLevel);
  // Local pending input is not part of the replicated state. Match only newly observed user entries,
  // so an old identical prompt cannot acknowledge a new submission on reconnect.
  const previousIds = new Set(state.view?.entries.map((entry) => entry.id));
  const newTexts = view.entries
    .filter((entry) => !previousIds.has(entry.id))
    .flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role === "user")
        .map((message) => normalizeText(contentText(message.content))),
    );
  const local = state.entries.filter((entry) => {
    if (!("role" in entry) || entry.role !== "user" || !entry.delivery) return false;
    const index = newTexts.indexOf(normalizeText(entry.text));
    if (index === -1) return true;
    newTexts.splice(index, 1);
    return false;
  });
  return { ...state, ...projected, view, entries: [...projected.entries, ...local] };
}

/** Pure presentation of the complete Durable mount; never an event accumulator. */
export function projectConversation(
  view: ConversationView,
  initialThinkingLevel: SessionThinkingLevel,
) {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, number>();
  let latestUsage: SessionUsage | undefined;
  let contextUsage: SessionUsage | undefined;
  const putTool = (tool: ToolEntry) => {
    const index = tools.get(tool.toolCallId);
    if (index === undefined) {
      tools.set(tool.toolCallId, entries.length);
      entries.push(tool);
    } else {
      const previous = entries[index];
      entries[index] = {
        ...(previous && "role" in previous && previous.role === "tool" ? previous : {}),
        ...tool,
      };
    }
  };
  const message = (value: unknown, messageId: string, completed: boolean) => {
    const item = object(value);
    const content = array(item.content);
    if (item.role === "user") {
      entries.push({ role: "user", messageId, text: contentText(item.content) });
    }
    if (item.role === "assistant") {
      const text = contentText(content);
      const thinking = content
        .filter((block) => object(block).type === "thinking")
        .map((block) => string(object(block).thinking))
        .join("");
      if (text || thinking) {
        entries.push({ role: "assistant", messageId, text, thinking, completed });
      }
      for (const block of content) {
        const call = object(block);
        if (call.type === "toolCall") {
          putTool({
            role: "tool",
            toolCallId: string(call.id),
            toolName: string(call.name),
            arguments: JSON.stringify(call.arguments ?? {}),
            active: false,
          });
        }
      }
      if (item.usage) {
        latestUsage = usage(item.usage);
        if (
          item.stopReason !== "error" &&
          item.stopReason !== "aborted" &&
          latestUsage.totalTokens > 0
        )
          contextUsage = latestUsage;
      }
    }
    if (item.role === "toolResult") {
      putTool({
        role: "tool",
        toolCallId: string(item.toolCallId),
        toolName: string(item.toolName),
        active: false,
        result: contentText(
          item.toolName === "read" && item.isError !== true
            ? content.filter((block) => object(block).type === "image")
            : item.content,
        ),
        isError: item.isError === true,
      });
    }
  };
  for (const entry of view.entries) {
    const sender = entry.kind === THREAD_MESSAGE_KIND ? threadSender(entry.data) : undefined;
    if (sender !== undefined) {
      (entry.model ?? []).forEach((item, index) => {
        if (item.role !== "user") return message(item, `${entry.id}:${index}`, true);
        entries.push({
          role: "thread",
          messageId: `${entry.id}:${index}`,
          ...sender,
          text: threadMessageBody(contentText(item.content), sender),
        });
      });
    } else if (entry.kind === "pi.compaction") {
      entries.push({
        id: entry.id,
        label: "Context compacted",
        detail: (entry.model ?? []).map((item) => contentText(item.content)).join("\n"),
      });
      contextUsage = undefined;
    } else if (entry.kind === "openorb.setup") {
      // Its model message only tells the agent about a failure; viewers see the output itself.
      const data = object(entry.data);
      entries.push({
        role: "setup",
        id: entry.id,
        step: string(data.step),
        exitCode: number(data.exitCode),
        output: string(data.output),
      });
    } else {
      (entry.model ?? []).forEach((item, index) => message(item, `${entry.id}:${index}`, true));
    }
  }
  const live = object(view.docs["pi.live"]);
  const generation = object(live.generation);
  if (generation.message) message(generation.message, "active", false);
  for (const value of array(live.tools)) {
    const slot = object(value);
    if (slot.status === "done") continue;
    putTool({
      role: "tool",
      toolCallId: string(slot.callId),
      toolName: string(slot.name),
      active: slot.status === "running",
      ...(slot.name === "read" || slot.output === undefined
        ? {}
        : { partialResult: string(slot.output) }),
    });
  }
  for (const value of array(live.compactions)) {
    const compaction = object(value);
    entries.push({ id: number(compaction.taskId), label: "Compacting context", inProgress: true });
  }
  if (generation.retry) {
    entries.push({
      id: -1,
      label: "Waiting to retry model",
      detail: string(object(generation.retry).error),
      inProgress: true,
    });
  }
  const level = view.docs["pi.agent"]?.thinkingLevel;
  const thinkingLevel =
    SESSION_THINKING_LEVELS.find((candidate) => candidate === level) ?? initialThinkingLevel;
  const followUpQueue = array(view.docs["pi.inbox"]?.items)
    .map(object)
    .filter((item) => item.mode !== "write")
    .map((item): QueuedPrompt => {
      // A queued input names the entry it will be placed as, so a thread message is known now.
      const entry = object(item.entry);
      const sender = entry.kind === THREAD_MESSAGE_KIND ? threadSender(entry.data) : undefined;
      const text = contentText(item.content);
      return sender === undefined ? { text } : { text: threadMessageBody(text, sender), sender };
    });
  const ledger = object(view.docs["pi.usage"]);
  const totalUsage = emptyUsage();
  for (const bucket of [ledger.models, ledger.tools]) {
    for (const value of Object.values(object(bucket))) addUsage(totalUsage, usage(value));
  }
  if (object(generation.message).usage) {
    addUsage(totalUsage, usage(object(generation.message).usage));
  }
  return { entries, thinkingLevel, followUpQueue, latestUsage, contextUsage, totalUsage };
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function threadSender(value: unknown): ThreadMessageData | undefined {
  const data = object(value);
  const relation =
    data.relation === "parent" || data.relation === "child" ? data.relation : undefined;
  const sessionId = string(data.sessionId);
  if (relation === undefined || !sessionId) return undefined;
  return { relation, sessionId, title: string(data.title) };
}
function object(value: unknown): JsonObject {
  // SAFETY: Every caller reads JSON from the ConversationView, never host objects.
  // oxlint-disable-next-line openorb/no-runtime-typeof -- Narrow the JSON union to its object member for presentation.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  // oxlint-disable-next-line openorb/no-runtime-typeof -- Narrow a field in the already validated JSON document.
  return typeof value === "string" ? value : "";
}
function number(value: unknown): number {
  // oxlint-disable-next-line openorb/no-runtime-typeof -- Narrow a field in the already validated JSON document.
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function contentText(value: unknown): string {
  // oxlint-disable-next-line openorb/no-runtime-typeof -- Durable UserInput is a string or content-block array.
  if (typeof value === "string") return value;
  return array(value)
    .map((block) => {
      const item = object(block);
      if (item.type === "text") return string(item.text);
      if (item.type === "image") {
        return item.artifactId
          ? `\n\n![Image](openorb-artifact:image:${string(item.artifactId)})\n\n`
          : string(item.text);
      }
      return "";
    })
    .join("");
}
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}
function usage(value: unknown): SessionUsage {
  const item = object(value);
  return {
    inputTokens: number(item.input),
    outputTokens: number(item.output),
    cacheReadTokens: number(item.cacheRead),
    cacheWriteTokens: number(item.cacheWrite),
    totalTokens: number(item.totalTokens),
    totalCost: number(object(item.cost).total),
  };
}
function addUsage(total: ReturnType<typeof emptyUsage>, item: SessionUsage) {
  total.inputTokens += item.inputTokens;
  total.outputTokens += item.outputTokens;
  total.cacheReadTokens += item.cacheReadTokens;
  total.cacheWriteTokens += item.cacheWriteTokens;
  total.totalTokens += item.totalTokens;
  total.totalCost += item.totalCost;
}
export function totalSessionUsage(state: SessionTranscriptState): SessionUsage {
  return state.totalUsage;
}
export function usageContextTokens(usage: SessionUsage): number {
  return (
    usage.totalTokens ||
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  );
}
export function activeActivityId(state: SessionTranscriptState): number | undefined {
  return state.entries.findLast(
    (entry): entry is ActivityEntry => !("role" in entry) && entry.inProgress === true,
  )?.id;
}
