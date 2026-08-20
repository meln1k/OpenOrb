import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MAX_SESSION_MESSAGE_TEXT_BYTES,
  MAX_TOOL_EVENT_TEXT_BYTES,
  MAX_USER_MESSAGE_TEXT_BYTES,
  type SessionConversationEvent,
} from "@openorb/protocol";

import {
  messageContentText,
  piMessageId,
  sessionUsage,
  stringify,
  truncateUtf8,
} from "@/src/pi-event-normalizer.ts";

export async function readPiSessionEvents(
  sessionFile: string,
): Promise<SessionConversationEvent[]> {
  if (!(await Deno.readTextFile(sessionFile)).trim()) return [];
  return eventsFromPiEntries(SessionManager.open(sessionFile).getBranch());
}

export function eventsFromPiEntries(entries: readonly SessionEntry[]): SessionConversationEvent[] {
  return entries.flatMap((entry): SessionConversationEvent[] => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") {
      const text = messageContentText(message.content);
      return text
        ? [{
          type: "user.message" as const,
          messageId: piMessageId("user", message.timestamp),
          text: truncateUtf8(text, MAX_USER_MESSAGE_TEXT_BYTES),
        }]
        : [];
    }
    if (message.role === "assistant") {
      return [
        {
          type: "assistant.completed" as const,
          messageId: piMessageId("assistant", message.timestamp),
          text: truncateUtf8(
            message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
            MAX_SESSION_MESSAGE_TEXT_BYTES,
          ),
          thinking: truncateUtf8(
            message.content.flatMap((block) => block.type === "thinking" ? [block.thinking] : [])
              .join(""),
            MAX_SESSION_MESSAGE_TEXT_BYTES,
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
              arguments: truncateUtf8(stringify(block.arguments), MAX_TOOL_EVENT_TEXT_BYTES),
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
        result: truncateUtf8(messageContentText(message.content), MAX_TOOL_EVENT_TEXT_BYTES),
        isError: message.isError,
      }];
    }
    return [];
  });
}
