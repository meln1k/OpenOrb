import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  MAX_QUEUED_SESSION_MESSAGES,
  MAX_SESSION_EVENT_TEXT_BYTES,
  type SessionConversationEvent,
  type SessionLiveEvent,
  type SessionUsage,
} from "@openorb/protocol";
import { array, literal, object, parseSafe, string, union } from "@remix-run/data-schema";
import { trySync } from "@openorb/result";

const toolResultSchema = object({
  content: array(union([
    object({ type: literal("text" as const), text: string() }),
    object({ type: literal("image" as const) }),
  ])),
});

type PiMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

export interface PiEventNormalizerOptions {
  getCompactionEntryId(): string | undefined;
  getMessageEntryId(message: PiMessage): string | undefined;
  publishConversation(event: SessionConversationEvent): Promise<void>;
  publishLive(event: SessionLiveEvent): Promise<void>;
  secrets?: readonly string[];
}

export class PiEventNormalizer {
  readonly #options: PiEventNormalizerOptions;
  #publications: Promise<void> = Promise.resolve();
  #publicationError?: unknown;

  constructor(options: PiEventNormalizerOptions) {
    this.#options = options;
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#publishLive({ type: "agent.started" });
        return;
      case "agent_end":
        this.#publishLive({ type: "agent.ended", willRetry: event.willRetry });
        return;
      case "agent_settled":
        this.#publishLive({ type: "agent.settled" });
        return;
      case "turn_start":
        this.#publishLive({ type: "turn.started" });
        return;
      case "turn_end":
        this.#publishLive({
          type: "turn.completed",
          toolResultCount: event.toolResults.length,
        });
        return;
      case "message_start":
        this.#publishLive({
          type: "message.started",
          role: event.message.role,
        });
        return;
      case "message_update":
        this.#handleAssistantUpdate(event);
        return;
      case "message_end": {
        if (event.message.role === "user") {
          const text = messageContentText(event.message.content);
          if (text) {
            const entryId = this.#captureMessageEntryId(event.message);
            this.#enqueue(async () => {
              const messageId = await entryId;
              if (messageId === undefined) {
                throw new PiEventNormalizationError(
                  "Pi completed a user message without a durable session entry.",
                  undefined,
                );
              }
              await this.#options.publishConversation({
                type: "user.message",
                messageId,
                text: truncateUtf8(text, MAX_SESSION_EVENT_TEXT_BYTES),
              });
            });
          }
        } else if (event.message.role === "assistant") {
          const message = event.message;
          const content = message.content;
          const entryId = this.#captureMessageEntryId(message);
          this.#enqueue(async () => {
            const messageId = await entryId;
            if (messageId === undefined) return;
            await this.#options.publishConversation({
              type: "assistant.completed",
              messageId,
              text: this.#safeCompletedAssistantText(
                content.flatMap((block) => block.type === "text" ? [block.text] : [])
                  .join(""),
                MAX_SESSION_EVENT_TEXT_BYTES,
              ),
              thinking: this.#safeCompletedAssistantText(
                content.flatMap((block) => block.type === "thinking" ? [block.thinking] : [])
                  .join(
                    "",
                  ),
                MAX_SESSION_EVENT_TEXT_BYTES,
              ),
              stopReason: message.stopReason,
              usage: sessionUsage(message.usage),
            });
          });
        }
        this.#publishLive({
          type: "message.completed",
          role: event.message.role,
        });
        return;
      }
      case "tool_execution_start":
        this.#enqueue(() =>
          this.#options.publishConversation({
            type: "tool.started",
            toolCallId: this.#safeIdentifier(event.toolCallId, "tool"),
            toolName: this.#safeIdentifier(event.toolName, "unknown"),
            arguments: this.#safeText(stringify(event.args), MAX_SESSION_EVENT_TEXT_BYTES),
          })
        );
        return;
      case "tool_execution_update":
        this.#publishLive({
          type: "tool.updated",
          toolCallId: this.#safeIdentifier(event.toolCallId, "tool"),
          toolName: this.#safeIdentifier(event.toolName, "unknown"),
          partialResult: this.#safeText(
            toolResultText(event.partialResult),
            MAX_SESSION_EVENT_TEXT_BYTES,
          ),
        });
        return;
      case "tool_execution_end":
        this.#enqueue(() =>
          this.#options.publishConversation({
            type: "tool.completed",
            toolCallId: this.#safeIdentifier(event.toolCallId, "tool"),
            toolName: this.#safeIdentifier(event.toolName, "unknown"),
            result: this.#safeText(
              toolResultText(event.result),
              MAX_SESSION_EVENT_TEXT_BYTES,
            ),
            isError: event.isError,
          })
        );
        return;
      case "queue_update":
        this.#publishLive({
          type: "queue.updated",
          steering: this.#queuedMessages(event.steering),
          followUp: this.#queuedMessages(event.followUp),
        });
        return;
      case "compaction_start":
        this.#publishLive({ type: "compaction.started", reason: event.reason });
        return;
      case "compaction_end": {
        const result = event.result;
        const summary = result === undefined
          ? undefined
          : this.#safeText(result.summary, MAX_SESSION_EVENT_TEXT_BYTES);
        const tokensBefore = result === undefined ? undefined : boundedCount(result.tokensBefore);
        if (result !== undefined) {
          const entryId = this.#options.getCompactionEntryId();
          if (entryId === undefined) {
            this.#enqueue(() =>
              Promise.reject(
                new PiEventNormalizationError(
                  "Pi completed compaction without a durable session entry.",
                  undefined,
                ),
              )
            );
          } else {
            this.#enqueue(() =>
              this.#options.publishConversation({
                type: "context.compacted",
                compactionId: entryId,
                summary: summary ?? "",
                tokensBefore: tokensBefore ?? 0,
                usage: result.usage === undefined ? undefined : sessionUsage(result.usage),
              })
            );
          }
        }
        this.#publishLive({
          type: "compaction.completed",
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          summary,
          tokensBefore,
          estimatedTokensAfter: result?.estimatedTokensAfter === undefined
            ? undefined
            : boundedCount(result.estimatedTokensAfter),
          errorMessage: event.errorMessage === undefined
            ? undefined
            : this.#safeError(event.errorMessage),
        });
        return;
      }
      case "auto_retry_start":
        this.#publishLive({
          type: "model.retry.started",
          attempt: boundedCount(event.attempt),
          maxAttempts: boundedCount(event.maxAttempts),
          delayMs: boundedCount(event.delayMs),
          errorMessage: this.#safeError(event.errorMessage),
        });
        return;
      case "auto_retry_end":
        this.#publishLive({
          type: "model.retry.completed",
          success: event.success,
          attempt: boundedCount(event.attempt),
          finalError: event.finalError === undefined
            ? undefined
            : this.#safeError(event.finalError),
        });
        return;
      case "summarization_retry_scheduled":
        this.#publishLive({
          type: "summarization.retry.scheduled",
          attempt: boundedCount(event.attempt),
          maxAttempts: boundedCount(event.maxAttempts),
          delayMs: boundedCount(event.delayMs),
          errorMessage: this.#safeError(event.errorMessage),
        });
        return;
      case "summarization_retry_attempt_start":
        this.#publishLive(
          event.source === "branchSummary"
            ? { type: "summarization.retry.started", source: event.source }
            : {
              type: "summarization.retry.started",
              source: event.source,
              reason: event.reason,
            },
        );
        return;
      case "summarization_retry_finished":
        this.#publishLive({ type: "summarization.retry.completed" });
        return;
      case "entry_appended": {
        const entryId = this.#safeIdentifier(event.entry.id, "entry");
        this.#publishLive({
          type: "session.entry.appended",
          entryId,
          entryType: event.entry.type,
        });
        return;
      }
      case "session_info_changed":
        this.#publishLive({
          type: "session.info.changed",
          name: event.name === undefined ? undefined : this.#safeText(event.name, 256),
        });
        return;
      case "thinking_level_changed":
        this.#publishLive({ type: "thinking-level.changed", level: event.level });
        return;
      case "bash_execution_update": {
        const delta = this.#safeText(event.delta, MAX_SESSION_EVENT_TEXT_BYTES);
        if (!delta) return;
        this.#publishLive({
          type: "bash.output.delta",
          id: event.id === undefined ? undefined : this.#safeIdentifier(event.id, "bash"),
          delta,
        });
        return;
      }
    }
    return assertNever(event);
  }

  async flush(): Promise<void> {
    await this.#publications;
    if (this.#publicationError !== undefined) throw this.#publicationError;
  }

  #captureMessageEntryId(message: PiMessage): Promise<string | undefined> {
    const captured = Promise.withResolvers<string | undefined>();
    queueMicrotask(() => {
      const [entryId, captureError] = trySync(
        () => this.#options.getMessageEntryId(message),
        (cause) =>
          new PiEventNormalizationError("Could not inspect Pi's durable message entry.", cause),
      );
      if (captureError !== undefined) {
        captured.reject(captureError);
        return;
      }
      captured.resolve(entryId);
    });
    return captured.promise;
  }

  #handleAssistantUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    this.#publishLive({
      type: "assistant.usage.updated",
      usage: sessionUsage(event.message.usage),
    });

    switch (update.type) {
      case "start":
        this.#publishLive({ type: "assistant.stream.started" });
        return;
      case "text_start":
      case "thinking_start":
        this.#publishLive({
          type: "assistant.content.started",
          contentIndex: boundedCount(update.contentIndex),
          contentType: update.type === "text_start" ? "text" : "thinking",
        });
        return;
      case "text_delta":
      case "thinking_delta": {
        const delta = this.#safeText(update.delta, MAX_SESSION_EVENT_TEXT_BYTES);
        if (!delta) return;
        this.#publishLive(
          update.type === "text_delta"
            ? { type: "assistant.text.delta", delta }
            : { type: "assistant.thinking.delta", delta },
        );
        return;
      }
      case "text_end":
      case "thinking_end":
        this.#publishLive({
          type: "assistant.content.completed",
          contentIndex: boundedCount(update.contentIndex),
          contentType: update.type === "text_end" ? "text" : "thinking",
        });
        return;
      case "toolcall_start":
        this.#publishLive({
          type: "assistant.tool-call.started",
          contentIndex: boundedCount(update.contentIndex),
        });
        return;
      case "toolcall_delta": {
        const delta = this.#safeText(update.delta, MAX_SESSION_EVENT_TEXT_BYTES);
        if (!delta) return;
        this.#publishLive({
          type: "assistant.tool-call.delta",
          contentIndex: boundedCount(update.contentIndex),
          delta,
        });
        return;
      }
      case "toolcall_end":
        this.#publishLive({
          type: "assistant.tool-call.completed",
          contentIndex: boundedCount(update.contentIndex),
          toolCallId: this.#safeIdentifier(update.toolCall.id, "tool"),
          toolName: this.#safeIdentifier(update.toolCall.name, "unknown"),
          arguments: this.#safeText(
            stringify(update.toolCall.arguments),
            MAX_SESSION_EVENT_TEXT_BYTES,
          ),
        });
        return;
      case "done":
        this.#publishLive({
          type: "assistant.stream.completed",
          reason: update.reason,
        });
        return;
      case "error":
        this.#publishLive({
          type: "assistant.stream.failed",
          reason: update.reason,
          errorMessage: update.error.errorMessage === undefined
            ? undefined
            : this.#safeError(update.error.errorMessage),
        });
        return;
    }
    return assertNever(update);
  }

  #publishLive(event: SessionLiveEvent): void {
    this.#enqueue(() => this.#options.publishLive(event));
  }

  #safeError(value: string): string {
    return this.#safeText(value, MAX_SESSION_EVENT_TEXT_BYTES);
  }

  #safeIdentifier(value: string, fallback: string): string {
    return boundedIdentifier(this.#redact(value), fallback);
  }

  #safeCompletedAssistantText(value: string, maxBytes: number): string {
    const normalized = normalizeCompletedAssistantText(sanitizeText(this.#redact(value)));
    return truncateUtf8(normalized, maxBytes);
  }

  #safeText(value: string, maxBytes: number): string {
    return truncateUtf8(sanitizeText(this.#redact(value)), maxBytes);
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of this.#options.secrets ?? []) {
      if (secret.length === 0) continue;
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }

  #queuedMessages(messages: readonly string[]): string[] {
    return messages.slice(0, MAX_QUEUED_SESSION_MESSAGES).map((message) =>
      this.#safeText(message, MAX_SESSION_EVENT_TEXT_BYTES)
    );
  }

  #enqueue(publish: () => Promise<void>): void {
    this.#publications = this.#publications.then(publish).catch((error) => {
      this.#publicationError ??= error;
    });
  }
}

class PiEventNormalizationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "PiEventNormalizationError";
  }
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
  const [serialized, serializationError] = trySync(
    () => JSON.stringify(value) ?? "null",
    () => true,
  );
  if (serializationError !== undefined) return "[Unserializable tool arguments]";
  return serialized;
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
