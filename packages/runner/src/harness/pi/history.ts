import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type DurableSessionEvent,
  MAX_RPC_SESSION_EVENT_TEXT_BYTES,
} from "@openorb/protocol/runner-api";

import {
  boundedCount,
  messageContentText,
  normalizeCompletedAssistantText,
  sessionUsage,
  stringify,
  truncateUtf8,
} from "./event-normalizer.ts";

export async function readPiSessionEvents(
  sessionFile: string,
): Promise<DurableSessionEvent[]> {
  if (!(await Deno.readTextFile(sessionFile)).trim()) return [];
  return eventsFromPiEntries(SessionManager.open(sessionFile).getBranch());
}

export function eventsFromPiEntries(entries: readonly SessionEntry[]): DurableSessionEvent[] {
  return entries.flatMap((entry): DurableSessionEvent[] => {
    if (entry.type === "compaction") {
      return [{
        type: "context.compacted",
        compactionId: entry.id,
        summary: truncateUtf8(entry.summary, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
        tokensBefore: boundedCount(entry.tokensBefore),
        ...(entry.usage === undefined ? {} : { usage: sessionUsage(entry.usage) }),
      }];
    }
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") {
      const text = messageContentText(message.content);
      return text
        ? [{
          type: "user.message" as const,
          messageId: entry.id,
          text: truncateUtf8(text, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
        }]
        : [];
    }
    if (message.role === "assistant") {
      return [
        {
          type: "assistant.completed" as const,
          messageId: entry.id,
          text: normalizeCompletedAssistantText(
            truncateUtf8(
              message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(
                "",
              ),
              MAX_RPC_SESSION_EVENT_TEXT_BYTES,
            ),
          ),
          thinking: normalizeCompletedAssistantText(
            truncateUtf8(
              message.content.flatMap((block) => block.type === "thinking" ? [block.thinking] : [])
                .join(""),
              MAX_RPC_SESSION_EVENT_TEXT_BYTES,
            ),
          ),
          stopReason: message.stopReason,
          usage: sessionUsage(message.usage),
        },
        ...message.content.flatMap((block) =>
          block.type === "toolCall"
            ? [{
              type: "tool.started" as const,
              toolCallId: block.id,
              toolName: block.name,
              arguments: truncateUtf8(
                stringify(block.arguments),
                MAX_RPC_SESSION_EVENT_TEXT_BYTES,
              ),
            }]
            : []
        ),
      ];
    }
    if (message.role === "toolResult") {
      return [{
        type: "tool.completed" as const,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        result: truncateUtf8(
          messageContentText(message.content),
          MAX_RPC_SESSION_EVENT_TEXT_BYTES,
        ),
        isError: message.isError,
      }];
    }
    return [];
  });
}
