import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import type { ThreadContext } from "../api.ts";

/** Bounds one rendered transcript, keeping its newest part; it crosses native RPC as one string. */
export const MAX_TRANSCRIPT_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_TOOL_ARGUMENT_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 4_000;
const PREVIEW_CHARS = 600;

/**
 * Plain text of a conversation's messages for a reader model: user and assistant text in full up
 * to a bound, tool calls and results truncated, thinking and system messages left out.
 */
export function renderTranscript(messages: readonly Message[]): string {
  return joinTranscript(renderMessages(messages));
}

/** Each message as transcript text; images are dropped as they are rendered. */
export function renderMessages(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => renderMessage(message));
}

/**
 * Rendered messages as one transcript of at most MAX_TRANSCRIPT_CHARS, keeping the newest part;
 * `omitted` counts characters a caller already dropped from the front.
 */
export function joinTranscript(parts: readonly string[], omitted = 0): string {
  const rendered = parts.join("\n\n");
  const cut = Math.max(0, rendered.length - MAX_TRANSCRIPT_CHARS);
  if (cut + omitted === 0) return rendered;
  return `[${cut + omitted} earlier characters omitted]\n\n${rendered.slice(cut)}`;
}

/**
 * The transcript read_thread reads: the active context window, or the whole history including what
 * compaction replaced. A long history drops its oldest parts as it is read, so it never builds one
 * huge string.
 */
export async function conversationTranscript(
  conversation: Conversation,
  scope: ThreadContext,
  context: Context,
): Promise<string> {
  if (scope === "current") return renderTranscript((await conversation.context(context)).messages);
  const parts: string[] = [];
  let length = 0;
  let omitted = 0;
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const part of page.items.flatMap((entry) => renderMessages(entry.model ?? []))) {
      parts.push(part);
      length += part.length;
      while (parts.length > 1 && length - parts[0]!.length > MAX_TRANSCRIPT_CHARS) {
        const dropped = parts.shift()!;
        length -= dropped.length;
        omitted += dropped.length;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return joinTranscript(parts, omitted);
}

/** The newest user and assistant messages, shortened, for a status check. */
export function recentMessages(messages: readonly Message[], count = 3): string[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .flatMap((message) => renderMessage(message, PREVIEW_CHARS))
    .slice(-count);
}

function renderMessage(message: Message, limit?: number): string[] {
  switch (message.role) {
    case "system":
      return [];
    case "user": {
      const text =
        // Pi permits user content as either a string or content blocks.
        // oxlint-disable-next-line openorb/no-runtime-typeof
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : "[image]"))
              .join("\n");
      return [`[user]\n${truncate(text, limit ?? MAX_TEXT_CHARS)}`];
    }
    case "assistant": {
      const parts = message.content.flatMap((part) => {
        if (part.type === "text") return [truncate(part.text, limit ?? MAX_TEXT_CHARS)];
        if (part.type === "toolCall") {
          return [
            `(calls ${part.name} ${truncate(JSON.stringify(part.arguments), limit ?? MAX_TOOL_ARGUMENT_CHARS)})`,
          ];
        }
        return [];
      });
      const failure =
        message.stopReason === "error" && message.errorMessage !== undefined
          ? [`(model error: ${truncate(message.errorMessage, MAX_TOOL_RESULT_CHARS)})`]
          : [];
      const body = [...parts, ...failure];
      return body.length === 0 ? [] : [`[assistant]\n${body.join("\n")}`];
    }
    case "toolResult": {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : "[image]"))
        .join("\n");
      return [
        `[${message.toolName} ${message.isError ? "failed" : "result"}]\n${truncate(text, limit ?? MAX_TOOL_RESULT_CHARS)}`,
      ];
    }
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}… [${value.length - limit} characters truncated]`;
}
