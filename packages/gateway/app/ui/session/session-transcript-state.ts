import type {
  SessionEvent,
  SessionProvisioningStage,
  SessionUsage,
} from "@openorb/protocol/browser-session-events";

export type SessionState =
  | "created"
  | "provisioning"
  | "running"
  | "ready"
  | "error"
  | "offline";

function runnerSessionStateForProvisioningStage(stage: SessionProvisioningStage): SessionState {
  switch (stage) {
    case "created":
      return "created";
    case "ready":
      return "ready";
    case "running":
      return "running";
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

export interface ProvisioningEntry {
  readonly role: "provisioning";
  readonly text: string;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ToolEntry
  | ActivityEntry
  | ProvisioningEntry;

export interface SessionTranscriptState {
  readonly sessionState: SessionState;
  readonly status: string;
  readonly retryVisible: boolean;
  readonly warningVisible: boolean;
  readonly followUpQueue: readonly string[];
  readonly entries: readonly TranscriptEntry[];
  readonly latestUsage: SessionUsage | undefined;
  readonly contextUsage: SessionUsage | undefined;
  readonly lastCompletedContextUsage: SessionUsage | undefined;
  readonly contextInvalidatedByCompaction: boolean;
  readonly usageByMessageId: ReadonlyMap<string, SessionUsage>;
  readonly nextActivityId: number;
  readonly entryIndex: ReadonlyMap<string, number>;
}

interface ActivityUpdate {
  readonly label: string;
  readonly detail?: string;
  readonly status?: string;
  readonly inProgress?: boolean;
}

const MAX_VISIBLE_ACTIVITY_EVENTS = 50;
const ACTIVE_ASSISTANT_KEY = "assistant:active";
const PROVISIONING_ENTRY_KEY = "provisioning:output";

export function createSessionTranscriptState(
  initialState: SessionState,
  canRetry: boolean,
): SessionTranscriptState {
  return {
    sessionState: initialState,
    status: statusLabel(initialState),
    retryVisible: canRetry,
    warningVisible: false,
    followUpQueue: [],
    entries: [],
    latestUsage: undefined,
    contextUsage: undefined,
    lastCompletedContextUsage: undefined,
    contextInvalidatedByCompaction: false,
    usageByMessageId: new Map(),
    nextActivityId: 1,
    entryIndex: new Map(),
  };
}

export function appendOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
  text: string,
): SessionTranscriptState {
  return appendEntry(state, messageKey(messageId), {
    role: "user",
    messageId,
    text,
    delivery: "pending",
  });
}

export function failOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
  deliveryError: string,
): SessionTranscriptState {
  const index = state.entryIndex.get(messageKey(messageId));
  if (index === undefined) return state;
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "user" && entry.delivery === "pending"
    ? replaceEntry(state, index, { ...entry, delivery: "failed", deliveryError })
    : state;
}

export function removeOptimisticUserMessage(
  state: SessionTranscriptState,
  messageId: string,
): SessionTranscriptState {
  const index = state.entryIndex.get(messageKey(messageId));
  if (index === undefined) return state;
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "user" && entry.delivery !== undefined
    ? removeEntry(state, index)
    : state;
}

export function reduceSessionTranscriptState(
  state: SessionTranscriptState,
  event: SessionEvent,
): SessionTranscriptState {
  if (event.type === "provisioning.log") return appendProvisioningOutput(state, event.text);
  if (event.type === "session.state") {
    const sessionState = runnerSessionStateForProvisioningStage(event.stage);
    const next = {
      ...state,
      sessionState,
      status: sessionStageLabel(event.stage),
      warningVisible: state.warningVisible || event.checkoutState === "unavailable",
      retryVisible: sessionState === "error",
      followUpQueue: sessionState === "ready" || sessionState === "error"
        ? []
        : state.followUpQueue,
    };
    return sessionState === "ready" || sessionState === "error"
      ? settleSessionTranscriptState(next)
      : next;
  }
  if (event.type === "conversation.reset") return resetConversation(state);

  let next = reduceUsage(state, event);
  next = reduceConversation(next, event);
  if (event.type === "queue.updated") next = { ...next, followUpQueue: event.followUp };
  const activity = activityForEvent(event);
  if (activity !== null) next = appendActivity(next, activity);
  return event.type === "agent.settled" ||
      event.type === "assistant.stream.failed" ||
      !isSessionBusy(next.sessionState)
    ? settleSessionTranscriptState(next)
    : next;
}

export function settleSessionTranscriptState(
  state: SessionTranscriptState,
): SessionTranscriptState {
  let changed = false;
  const entries: TranscriptEntry[] = [];
  for (const entry of state.entries) {
    if (!("role" in entry)) {
      if (entry.inProgress) {
        entries.push({ ...entry, inProgress: false });
        changed = true;
      } else {
        entries.push(entry);
      }
      continue;
    }
    if (entry.role === "assistant" && !entry.completed) {
      changed = true;
      if (entry.text.length > 0 || entry.thinking.length > 0) {
        entries.push({ ...entry, completed: true });
      }
      continue;
    }
    if (entry.role === "tool" && entry.active) {
      entries.push({ ...entry, active: false });
      changed = true;
      continue;
    }
    entries.push(entry);
  }
  return changed ? replaceEntries(state, entries) : state;
}

export function activeActivityId(state: SessionTranscriptState): number | undefined {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry && !("role" in entry) && entry.inProgress) return entry.id;
  }
  return undefined;
}

export function isSessionBusy(state: SessionState): boolean {
  return state === "created" || state === "provisioning" || state === "running";
}

export function totalSessionUsage(state: SessionTranscriptState): SessionUsage {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  for (const usage of state.usageByMessageId.values()) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.totalTokens += usage.totalTokens;
    total.totalCost += usage.totalCost;
  }
  return total;
}

export function usageContextTokens(usage: SessionUsage): number {
  return usage.totalTokens ||
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function reduceUsage(state: SessionTranscriptState, event: SessionEvent): SessionTranscriptState {
  if (event.type === "message.started" && event.role === "assistant") {
    if (!state.usageByMessageId.has(ACTIVE_ASSISTANT_KEY)) return state;
    const usageByMessageId = new Map(state.usageByMessageId);
    usageByMessageId.delete(ACTIVE_ASSISTANT_KEY);
    return {
      ...state,
      latestUsage: state.lastCompletedContextUsage,
      contextUsage: state.contextInvalidatedByCompaction
        ? undefined
        : state.lastCompletedContextUsage,
      usageByMessageId,
    };
  }
  if (event.type === "assistant.usage.updated") {
    const usageByMessageId = new Map(state.usageByMessageId);
    usageByMessageId.set(ACTIVE_ASSISTANT_KEY, event.usage);
    return {
      ...state,
      latestUsage: event.usage,
      contextUsage: state.contextInvalidatedByCompaction ? state.contextUsage : event.usage,
      usageByMessageId,
    };
  }
  if (event.type === "assistant.completed") {
    const usageByMessageId = new Map(state.usageByMessageId);
    usageByMessageId.delete(ACTIVE_ASSISTANT_KEY);
    usageByMessageId.set(event.messageId, event.usage);
    if (hasValidContextUsage(event)) {
      return {
        ...state,
        latestUsage: event.usage,
        contextUsage: event.usage,
        lastCompletedContextUsage: event.usage,
        contextInvalidatedByCompaction: false,
        usageByMessageId,
      };
    }
    return {
      ...state,
      latestUsage: event.usage,
      contextUsage: state.contextInvalidatedByCompaction
        ? undefined
        : state.lastCompletedContextUsage,
      usageByMessageId,
    };
  }
  if (event.type !== "context.compacted") return state;
  const usageByMessageId = new Map(state.usageByMessageId);
  if (event.usage !== undefined) {
    usageByMessageId.set(`compaction:${event.compactionId}`, event.usage);
  }
  return {
    ...state,
    contextUsage: undefined,
    lastCompletedContextUsage: undefined,
    contextInvalidatedByCompaction: true,
    usageByMessageId,
  };
}

function reduceConversation(
  state: SessionTranscriptState,
  event: SessionEvent,
): SessionTranscriptState {
  switch (event.type) {
    case "user.message": {
      const key = messageKey(event.messageId);
      if (state.entryIndex.has(key)) return state;
      const reconciled = removeMatchingOptimisticUserMessage(state, event.text);
      return appendEntry(reconciled, key, {
        role: "user",
        messageId: event.messageId,
        text: event.text,
      });
    }
    case "message.started":
      return event.role === "assistant" ? discardActiveAssistant(state) : state;
    case "assistant.text.delta":
      return updateActiveAssistant(state, (entry) => ({
        ...entry,
        text: entry.text + event.delta,
        completed: false,
      }));
    case "assistant.thinking.delta":
      return updateActiveAssistant(state, (entry) => ({
        ...entry,
        thinking: entry.thinking + event.delta,
        completed: false,
      }));
    case "assistant.completed": {
      const rekeyed = commitActiveAssistant(state, event.messageId);
      const key = messageKey(event.messageId);
      const index = rekeyed.entryIndex.get(key);
      if (event.text.length === 0 && event.thinking.length === 0) {
        return index === undefined ? rekeyed : removeEntry(rekeyed, index);
      }
      return updatePersistedAssistant(rekeyed, event.messageId, (entry) => ({
        ...entry,
        text: event.text,
        thinking: event.thinking,
        completed: true,
      }));
    }
    case "tool.started":
      return updateTool(state, event.toolCallId, event.toolName, (entry) => ({
        ...entry,
        toolName: event.toolName,
        active: entry.result === undefined,
        arguments: event.arguments,
      }));
    case "tool.completed":
      return updateTool(state, event.toolCallId, event.toolName, (entry) => ({
        ...entry,
        toolName: event.toolName,
        active: false,
        result: event.result,
        partialResult: undefined,
        isError: event.isError,
      }));
    case "tool.updated":
      return updateTool(
        state,
        event.toolCallId,
        event.toolName,
        (entry) =>
          entry.result === undefined
            ? {
              ...entry,
              toolName: event.toolName,
              active: true,
              partialResult: event.partialResult,
            }
            : entry,
      );
    default:
      return state;
  }
}

function removeMatchingOptimisticUserMessage(
  state: SessionTranscriptState,
  text: string,
): SessionTranscriptState {
  const normalizedText = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (
      entry && "role" in entry && entry.role === "user" && entry.delivery !== undefined &&
      entry.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n") === normalizedText
    ) {
      return removeEntry(state, index);
    }
  }
  return state;
}

function updateActiveAssistant(
  state: SessionTranscriptState,
  update: (entry: AssistantEntry) => AssistantEntry,
): SessionTranscriptState {
  const index = state.entryIndex.get(ACTIVE_ASSISTANT_KEY);
  if (index === undefined) {
    return appendEntry(
      state,
      ACTIVE_ASSISTANT_KEY,
      update({ role: "assistant", text: "", thinking: "", completed: false }),
    );
  }
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "assistant"
    ? replaceEntry(state, index, update(entry))
    : state;
}

function updatePersistedAssistant(
  state: SessionTranscriptState,
  messageId: string,
  update: (entry: AssistantEntry) => AssistantEntry,
): SessionTranscriptState {
  const key = messageKey(messageId);
  const index = state.entryIndex.get(key);
  if (index === undefined) {
    return appendEntry(
      state,
      key,
      update({ role: "assistant", messageId, text: "", thinking: "", completed: false }),
    );
  }
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "assistant"
    ? replaceEntry(state, index, update(entry))
    : state;
}

function updateTool(
  state: SessionTranscriptState,
  toolCallId: string,
  toolName: string,
  update: (entry: ToolEntry) => ToolEntry,
): SessionTranscriptState {
  const key = toolKey(toolCallId);
  const index = state.entryIndex.get(key);
  if (index === undefined) {
    return appendEntry(
      state,
      key,
      update({ role: "tool", toolCallId, toolName, active: true }),
    );
  }
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "tool"
    ? replaceEntry(state, index, update(entry))
    : state;
}

function commitActiveAssistant(
  state: SessionTranscriptState,
  messageId: string,
): SessionTranscriptState {
  const activeIndex = state.entryIndex.get(ACTIVE_ASSISTANT_KEY);
  if (activeIndex === undefined) return state;
  const canonicalIndex = state.entryIndex.get(messageKey(messageId));
  if (canonicalIndex !== undefined) return removeEntry(state, activeIndex);
  const entry = state.entries[activeIndex];
  if (!entry || !("role" in entry) || entry.role !== "assistant") return state;
  const entries = [...state.entries];
  entries[activeIndex] = { ...entry, messageId };
  const entryIndex = new Map(state.entryIndex);
  entryIndex.delete(ACTIVE_ASSISTANT_KEY);
  entryIndex.set(messageKey(messageId), activeIndex);
  return { ...state, entries, entryIndex };
}

function discardActiveAssistant(state: SessionTranscriptState): SessionTranscriptState {
  const index = state.entryIndex.get(ACTIVE_ASSISTANT_KEY);
  return index === undefined ? state : removeEntry(state, index);
}

function appendProvisioningOutput(
  state: SessionTranscriptState,
  text: string,
): SessionTranscriptState {
  const index = state.entryIndex.get(PROVISIONING_ENTRY_KEY);
  if (index === undefined) {
    return appendEntry(state, PROVISIONING_ENTRY_KEY, { role: "provisioning", text });
  }
  const entry = state.entries[index];
  return entry && "role" in entry && entry.role === "provisioning"
    ? replaceEntry(state, index, { ...entry, text: entry.text + text })
    : state;
}

function appendActivity(
  state: SessionTranscriptState,
  update: ActivityUpdate,
): SessionTranscriptState {
  let entries = state.entries.map((entry): TranscriptEntry =>
    !("role" in entry) && entry.inProgress ? { ...entry, inProgress: false } : entry
  );
  const activity: ActivityEntry = { id: state.nextActivityId, ...update };
  entries = [...entries, activity];
  const activityCount = entries.reduce(
    (count, entry) => count + Number(!("role" in entry)),
    0,
  );
  if (activityCount > MAX_VISIBLE_ACTIVITY_EVENTS) {
    const oldest = entries.findIndex((entry) => !("role" in entry));
    if (oldest !== -1) entries.splice(oldest, 1);
  }
  return {
    ...replaceEntries(state, entries),
    status: update.status ?? state.status,
    nextActivityId: state.nextActivityId + 1,
  };
}

function resetConversation(state: SessionTranscriptState): SessionTranscriptState {
  const entries = state.entries.filter(
    (entry): entry is ProvisioningEntry => "role" in entry && entry.role === "provisioning",
  );
  return {
    ...replaceEntries(state, entries),
    latestUsage: undefined,
    contextUsage: undefined,
    lastCompletedContextUsage: undefined,
    contextInvalidatedByCompaction: false,
    followUpQueue: [],
    usageByMessageId: new Map(),
    nextActivityId: 1,
  };
}

function appendEntry(
  state: SessionTranscriptState,
  key: string,
  entry: TranscriptEntry,
): SessionTranscriptState {
  const entries = [...state.entries, entry];
  const entryIndex = new Map(state.entryIndex);
  entryIndex.set(key, entries.length - 1);
  return { ...state, entries, entryIndex };
}

function replaceEntry(
  state: SessionTranscriptState,
  index: number,
  entry: TranscriptEntry,
): SessionTranscriptState {
  if (state.entries[index] === entry) return state;
  const entries = [...state.entries];
  entries[index] = entry;
  return { ...state, entries };
}

function removeEntry(state: SessionTranscriptState, index: number): SessionTranscriptState {
  const entries = [...state.entries];
  entries.splice(index, 1);
  return replaceEntries(state, entries);
}

function replaceEntries(
  state: SessionTranscriptState,
  entries: readonly TranscriptEntry[],
): SessionTranscriptState {
  return { ...state, entries, entryIndex: indexEntries(entries) };
}

function indexEntries(entries: readonly TranscriptEntry[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  entries.forEach((entry, entryIndex) => index.set(entryKey(entry), entryIndex));
  return index;
}

function entryKey(entry: TranscriptEntry): string {
  if (!("role" in entry)) return `activity:${entry.id}`;
  switch (entry.role) {
    case "user":
      return messageKey(entry.messageId);
    case "assistant":
      return entry.messageId === undefined ? ACTIVE_ASSISTANT_KEY : messageKey(entry.messageId);
    case "tool":
      return toolKey(entry.toolCallId);
    case "provisioning":
      return PROVISIONING_ENTRY_KEY;
  }
}

function messageKey(messageId: string): string {
  return `message:${messageId}`;
}

function toolKey(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function hasValidContextUsage(
  event: Extract<SessionEvent, { type: "assistant.completed" }>,
): boolean {
  return event.stopReason !== "aborted" &&
    event.stopReason !== "error" &&
    usageContextTokens(event.usage) > 0;
}

function activityForEvent(event: SessionEvent): ActivityUpdate | null {
  switch (event.type) {
    case "agent.started":
      return null;
    case "agent.ended":
      return event.willRetry
        ? {
          label: "Agent run ended",
          detail: "Pi will retry.",
          status: "Waiting to retry",
          inProgress: true,
        }
        : null;
    case "agent.settled":
    case "turn.started":
    case "turn.completed":
      return null;
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
        status: count > 0 ? `${count} prompt${count === 1 ? "" : "s"} queued` : "Agent running",
      };
    }
    case "context.compacted":
      return {
        label: "Context compacted",
        detail: [event.summary, `${event.tokensBefore} tokens before compaction`]
          .filter(Boolean).join("\n"),
        status: "Context compacted",
      };
    case "compaction.started":
      return {
        label: "Context compaction started",
        detail: event.reason,
        status: "Compacting context",
        inProgress: true,
      };
    case "compaction.completed": {
      if (!event.aborted && event.summary !== undefined) return null;
      const details = [event.errorMessage ?? event.summary];
      if (event.tokensBefore !== undefined) {
        details.push(
          event.estimatedTokensAfter === undefined
            ? `${event.tokensBefore} tokens before compaction`
            : `${event.tokensBefore} → ${event.estimatedTokensAfter} estimated tokens`,
        );
      }
      return {
        label: event.aborted ? "Context compaction aborted" : "Context compaction failed",
        detail: details.filter((detail) => detail !== undefined).join("\n"),
        status: event.willRetry
          ? "Compaction will retry"
          : event.aborted
          ? "Compaction aborted"
          : "Compaction failed",
      };
    }
    case "model.retry.started":
      return {
        label: `Model retry ${event.attempt} of ${event.maxAttempts}`,
        detail: `${event.errorMessage}\nRetrying in ${event.delayMs} ms`,
        status: "Waiting to retry model",
        inProgress: true,
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
        inProgress: true,
      };
    case "summarization.retry.started":
      return {
        label: "Summary retry started",
        detail: event.source === "compaction" ? `Compaction · ${event.reason}` : "Branch summary",
        status: "Summarizing context",
        inProgress: true,
      };
    case "summarization.retry.completed":
      return { label: "Summary retry completed" };
    case "message.started":
    case "message.completed":
    case "assistant.stream.started":
    case "assistant.content.started":
    case "assistant.content.completed":
    case "assistant.tool-call.started":
    case "assistant.tool-call.delta":
    case "assistant.tool-call.completed":
    case "assistant.stream.completed":
    case "assistant.usage.updated":
    case "assistant.text.delta":
    case "assistant.thinking.delta":
    case "session.entry.appended":
    case "session.info.changed":
    case "thinking-level.changed":
    case "bash.output.delta":
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
  stage: Extract<SessionEvent, { type: "session.state" }>["stage"],
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

function assertNever(_value: never): null {
  return null;
}
