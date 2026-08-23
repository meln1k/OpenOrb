import { object, string } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";

import type { RunnerMessage } from "@/src/runner-message.ts";
import {
  MAX_INITIAL_PROMPT_BYTES,
  type SessionModelRuntime,
  sessionModelRuntimeSchema,
} from "@/src/runner-session-provisioning.ts";

export const SESSION_PROMPT_MESSAGE_TYPE = "session.prompt";
export const SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE = "session.prompt.accepted";
export const SESSION_PROMPT_REJECTED_MESSAGE_TYPE = "session.prompt.rejected";

const promptSchema = string().refine(
  (value) => value.trim().length > 0 && byteLength(value) <= MAX_INITIAL_PROMPT_BYTES,
  `Session prompts must contain text and be at most ${MAX_INITIAL_PROMPT_BYTES} UTF-8 bytes.`,
);

export const sessionPromptCommandPayloadSchema = object(
  {
    prompt: promptSchema,
    modelRuntime: sessionModelRuntimeSchema,
  },
  { unknownKeys: "error" },
);

export interface SessionPromptCommandPayload {
  prompt: string;
  modelRuntime: SessionModelRuntime;
}

export type SessionPromptCommand = RunnerMessage<SessionPromptCommandPayload> & {
  type: typeof SESSION_PROMPT_MESSAGE_TYPE;
  sessionId: string;
};

export const sessionPromptAcceptedPayloadSchema = object({}, { unknownKeys: "error" });

export type SessionPromptAcceptedPayload = InferOutput<typeof sessionPromptAcceptedPayloadSchema>;

export type SessionPromptAcceptedMessage = RunnerMessage<SessionPromptAcceptedPayload> & {
  type: typeof SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

export const sessionPromptRejectedPayloadSchema = object(
  {
    message: string().refine(
      (value) => value.trim().length > 0 && value.length <= 1000,
      "Prompt rejection messages must contain at most 1000 characters.",
    ),
  },
  { unknownKeys: "error" },
);

export type SessionPromptRejectedPayload = InferOutput<typeof sessionPromptRejectedPayloadSchema>;

export type SessionPromptRejectedMessage = RunnerMessage<SessionPromptRejectedPayload> & {
  type: typeof SESSION_PROMPT_REJECTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
