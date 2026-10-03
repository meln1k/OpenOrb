// deno-lint-ignore-file openorb/no-runtime-typeof -- This module implements the structural JSON wire schema itself.
import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";
import { assertValidOp, type Op } from "@earendil-works/chord/delta";
import { trySync } from "../../result/src/index.ts";

export type { ConversationView, Op };
export type ConversationFrame =
  | { readonly type: "conversation.snapshot"; readonly view: ConversationView }
  | { readonly type: "conversation.ops"; readonly ops: readonly Op[] };

/** Only plain, finite JSON crosses this boundary, never Durable handles or host objects. */
export function isSerializable(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (Array.isArray(value) && key === "length") return true;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true &&
      isSerializable(descriptor.value, ancestors);
  }) && (!Array.isArray(value) || Object.keys(value).length === value.length);
  ancestors.delete(value);
  return valid;
}

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isConversationView(value: unknown): value is ConversationView {
  if (
    !isSerializable(value) || !record(value) || !record(value.conversation) ||
    !id(value.conversation.id) || !Array.isArray(value.entries) || !record(value.docs)
  ) return false;
  const { parent, owner } = value.conversation;
  if (
    parent !== undefined &&
    (!record(parent) || !id(parent.conversationId) || !id(parent.at))
  ) return false;
  if (
    owner !== undefined &&
    (!record(owner) || !id(owner.conversationId) || !id(owner.taskId))
  ) return false;
  return Object.values(value.docs).every(record) &&
    value.entries.every((entry) =>
      record(entry) && id(entry.id) && id(entry.conversationId) && typeof entry.kind === "string" &&
      (entry.head === undefined || id(entry.head)) &&
      (entry.byTaskId === undefined || id(entry.byTaskId)) &&
      (entry.model === undefined || messages(entry.model)) &&
      (entry.edits === undefined ||
        Array.isArray(entry.edits) && entry.edits.every((edit) =>
            record(edit) && id(edit.target) &&
            (edit.action === "omit" || edit.action === "replace" && messages(edit.messages))
          ))
    );
}

function messages(value: unknown): boolean {
  return Array.isArray(value) &&
    value.every((message) =>
      record(message) &&
      ["user", "assistant", "toolResult", "system"].includes(String(message.role)) &&
      (typeof message.content === "string" || Array.isArray(message.content) &&
          message.content.every((block) => record(block) && typeof block.type === "string"))
    );
}

export function isConversationOps(value: unknown): value is readonly Op[] {
  if (!Array.isArray(value) || !isSerializable(value)) return false;
  const [, error] = trySync(() => {
    for (const op of value) assertValidOp(op);
  }, () => true);
  if (error !== undefined) return false;
  return true;
}
