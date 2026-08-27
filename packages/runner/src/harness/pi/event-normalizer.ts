import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import {
  type EphemeralSessionEvent,
  MAX_RPC_QUEUED_SESSION_MESSAGES,
  MAX_RPC_SESSION_EVENT_TEXT_BYTES,
  type SessionUsage,
} from "@openorb/protocol/runner-api";
import { array, literal, object, parseSafe, string, union } from "@remix-run/data-schema";

const toolResultSchema = object({
  content: array(union([
    object({ type: literal("text" as const), text: string() }),
    object({ type: literal("image" as const) }),
  ])),
});

/** Converts provider-specific Pi callbacks into OpenOrb's stable event vocabulary. */
export interface PiEventNormalizerOptions {
  publishLive(event: EphemeralSessionEvent): Effect.Effect<void, unknown>;
  secrets?: readonly string[];
}

export function makePiEventNormalizer(options: PiEventNormalizerOptions) {
  const redact = (value: string): string => {
    let redacted = value;
    for (const secret of options.secrets ?? []) {
      if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  };
  const safeText = (value: string, maxBytes: number): string =>
    truncateUtf8(sanitizeText(redact(value)), maxBytes);
  const safeIdentifier = (value: string, fallback: string): string =>
    boundedIdentifier(redact(value), fallback);
  const queuedMessages = (messages: readonly string[]): string[] =>
    messages.slice(0, MAX_RPC_QUEUED_SESSION_MESSAGES).map((message) =>
      safeText(message, MAX_RPC_SESSION_EVENT_TEXT_BYTES)
    );
  return Effect.fn("PiEventNormalizer.handle")(function* (event: AgentSessionEvent) {
    const publications: Array<Effect.Effect<void, unknown>> = [];
    const publishLive = (event: EphemeralSessionEvent): void => {
      publications.push(options.publishLive(event));
    };

    switch (event.type) {
      case "agent_start":
        publishLive({ type: "agent.started" });
        break;
      case "agent_end":
        publishLive({ type: "agent.ended", willRetry: event.willRetry });
        break;
      case "agent_settled":
        publishLive({ type: "agent.settled" });
        break;
      case "turn_start":
        publishLive({ type: "turn.started" });
        break;
      case "turn_end":
        publishLive({ type: "turn.completed", toolResultCount: event.toolResults.length });
        break;
      case "message_start":
        publishLive({ type: "message.started", role: event.message.role });
        break;
      case "message_update":
        normalizeAssistantUpdate(event, publishLive, safeText, safeIdentifier);
        break;
      case "message_end": {
        publishLive({ type: "message.completed", role: event.message.role });
        break;
      }
      case "tool_execution_start":
        break;
      case "tool_execution_update":
        publishLive({
          type: "tool.updated",
          toolCallId: safeIdentifier(event.toolCallId, "tool"),
          toolName: safeIdentifier(event.toolName, "unknown"),
          partialResult: safeText(
            toolResultText(event.partialResult),
            MAX_RPC_SESSION_EVENT_TEXT_BYTES,
          ),
        });
        break;
      case "tool_execution_end":
        break;
      case "queue_update":
        publishLive({
          type: "queue.updated",
          steering: queuedMessages(event.steering),
          followUp: queuedMessages(event.followUp),
        });
        break;
      case "compaction_start":
        publishLive({ type: "compaction.started", reason: event.reason });
        break;
      case "compaction_end": {
        const result = event.result;
        const summary = result === undefined
          ? undefined
          : safeText(result.summary, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
        const tokensBefore = result === undefined ? undefined : boundedCount(result.tokensBefore);
        publishLive({
          type: "compaction.completed",
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(summary === undefined ? {} : { summary }),
          ...(tokensBefore === undefined ? {} : { tokensBefore }),
          ...(result?.estimatedTokensAfter === undefined
            ? {}
            : { estimatedTokensAfter: boundedCount(result.estimatedTokensAfter) }),
          ...(event.errorMessage === undefined ? {} : {
            errorMessage: safeText(event.errorMessage, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
          }),
        });
        break;
      }
      case "auto_retry_start":
        publishLive({
          type: "model.retry.started",
          attempt: boundedCount(event.attempt),
          maxAttempts: boundedCount(event.maxAttempts),
          delayMs: boundedCount(event.delayMs),
          errorMessage: safeText(event.errorMessage, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
        });
        break;
      case "auto_retry_end":
        publishLive({
          type: "model.retry.completed",
          success: event.success,
          attempt: boundedCount(event.attempt),
          ...(event.finalError === undefined
            ? {}
            : { finalError: safeText(event.finalError, MAX_RPC_SESSION_EVENT_TEXT_BYTES) }),
        });
        break;
      case "summarization_retry_scheduled":
        publishLive({
          type: "summarization.retry.scheduled",
          attempt: boundedCount(event.attempt),
          maxAttempts: boundedCount(event.maxAttempts),
          delayMs: boundedCount(event.delayMs),
          errorMessage: safeText(event.errorMessage, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
        });
        break;
      case "summarization_retry_attempt_start":
        publishLive(
          event.source === "branchSummary"
            ? { type: "summarization.retry.started", source: event.source }
            : { type: "summarization.retry.started", source: event.source, reason: event.reason },
        );
        break;
      case "summarization_retry_finished":
        publishLive({ type: "summarization.retry.completed" });
        break;
      case "entry_appended":
        publishLive({
          type: "session.entry.appended",
          entryId: safeIdentifier(event.entry.id, "entry"),
          entryType: event.entry.type,
        });
        break;
      case "session_info_changed":
        publishLive({
          type: "session.info.changed",
          ...(event.name === undefined ? {} : { name: safeText(event.name, 256) }),
        });
        break;
      case "thinking_level_changed":
        publishLive({ type: "thinking-level.changed", level: event.level });
        break;
      case "bash_execution_update": {
        const delta = safeText(event.delta, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
        if (delta) {
          publishLive({
            type: "bash.output.delta",
            ...(event.id === undefined ? {} : { id: safeIdentifier(event.id, "bash") }),
            delta,
          });
        }
        break;
      }
      default:
        assertNever(event);
    }

    yield* Effect.forEach(publications, (publication) => publication, { discard: true });
  });
}

function normalizeAssistantUpdate(
  event: Extract<AgentSessionEvent, { type: "message_update" }>,
  publishLive: (event: EphemeralSessionEvent) => void,
  safeText: (value: string, maxBytes: number) => string,
  safeIdentifier: (value: string, fallback: string) => string,
): void {
  if (event.message.role !== "assistant") return;
  const update = event.assistantMessageEvent;
  publishLive({ type: "assistant.usage.updated", usage: sessionUsage(event.message.usage) });
  switch (update.type) {
    case "start":
      publishLive({ type: "assistant.stream.started" });
      return;
    case "text_start":
    case "thinking_start":
      publishLive({
        type: "assistant.content.started",
        contentIndex: boundedCount(update.contentIndex),
        contentType: update.type === "text_start" ? "text" : "thinking",
      });
      return;
    case "text_delta":
    case "thinking_delta": {
      const delta = safeText(update.delta, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
      if (!delta) return;
      publishLive(
        update.type === "text_delta"
          ? { type: "assistant.text.delta", delta }
          : { type: "assistant.thinking.delta", delta },
      );
      return;
    }
    case "text_end":
    case "thinking_end":
      publishLive({
        type: "assistant.content.completed",
        contentIndex: boundedCount(update.contentIndex),
        contentType: update.type === "text_end" ? "text" : "thinking",
      });
      return;
    case "toolcall_start":
      publishLive({
        type: "assistant.tool-call.started",
        contentIndex: boundedCount(update.contentIndex),
      });
      return;
    case "toolcall_delta": {
      const delta = safeText(update.delta, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
      if (!delta) return;
      publishLive({
        type: "assistant.tool-call.delta",
        contentIndex: boundedCount(update.contentIndex),
        delta,
      });
      return;
    }
    case "toolcall_end":
      publishLive({
        type: "assistant.tool-call.completed",
        contentIndex: boundedCount(update.contentIndex),
        toolCallId: safeIdentifier(update.toolCall.id, "tool"),
        toolName: safeIdentifier(update.toolCall.name, "unknown"),
        arguments: safeText(
          stringify(update.toolCall.arguments),
          MAX_RPC_SESSION_EVENT_TEXT_BYTES,
        ),
      });
      return;
    case "done":
      publishLive({ type: "assistant.stream.completed", reason: update.reason });
      return;
    case "error":
      publishLive({
        type: "assistant.stream.failed",
        reason: update.reason,
        ...(update.error.errorMessage === undefined ? {} : {
          errorMessage: safeText(
            update.error.errorMessage,
            MAX_RPC_SESSION_EVENT_TEXT_BYTES,
          ),
        }),
      });
      return;
  }
  return assertNever(update);
}

export function normalizeCompletedAssistantText(value: string): string {
  return value.trim().length === 0 ? "" : value;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const marker = "\n[Truncated]";
  let bytes = encoder.encode(marker).byteLength;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result + marker;
}

export function stringify(value: unknown): string {
  return Result.getOrElse(
    Result.try(() => JSON.stringify(value) ?? "null"),
    () => "[Unserializable tool arguments]",
  );
}

export function toolResultText(value: unknown): string {
  const result = parseSafe(toolResultSchema, value);
  if (!result.success) return stringify(value);
  return result.value.content.map((block) =>
    block.type === "text" ? block.text : "[Image result omitted]"
  ).join("\n");
}

export function messageContentText(
  content: string | readonly { type: string; text?: string }[],
): string {
  return Array.isArray(content)
    ? content.map((block) => block.type === "text" ? block.text ?? "" : "[Image omitted]")
      .join("\n")
    : String(content);
}

export function sessionUsage(usage: Usage): SessionUsage {
  return {
    inputTokens: boundedCount(usage.input),
    outputTokens: boundedCount(usage.output),
    cacheReadTokens: boundedCount(usage.cacheRead),
    cacheWriteTokens: boundedCount(usage.cacheWrite),
    totalTokens: boundedCount(usage.totalTokens),
    totalCost: boundedCost(usage.cost.total),
  };
}

function boundedIdentifier(value: string, fallback: string): string {
  const sanitized = sanitizeText(value);
  if (sanitized.length === 0) return fallback;
  let result = "";
  for (const codePoint of sanitized) {
    if (result.length + codePoint.length > 256) break;
    result += codePoint;
  }
  return result;
}

export function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function boundedCost(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function sanitizeText(value: string): string {
  let sanitized = "";
  for (const codePoint of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) sanitized += codePoint;
  }
  return sanitized;
}

function assertNever(_value: never): void {}
