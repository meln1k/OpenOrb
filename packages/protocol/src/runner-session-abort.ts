import { type InferOutput, object, string } from "@remix-run/data-schema";

import type { RunnerMessage } from "@/src/runner-message.ts";

export const SESSION_ABORT_MESSAGE_TYPE = "session.abort" as const;
export const SESSION_ABORT_ACCEPTED_MESSAGE_TYPE = "session.abort.accepted" as const;
export const SESSION_ABORT_REJECTED_MESSAGE_TYPE = "session.abort.rejected" as const;

export const sessionAbortCommandPayloadSchema = object(
  {
    runId: string().refine(
      (value) => value.length > 0 && value.length <= 100,
      "Abort run identifiers must be between 1 and 100 characters.",
    ),
  },
  { unknownKeys: "error" },
);
export interface SessionAbortCommandPayload {
  runId: string;
}
export type SessionAbortCommand = RunnerMessage<SessionAbortCommandPayload> & {
  type: typeof SESSION_ABORT_MESSAGE_TYPE;
  sessionId: string;
};

export const sessionAbortAcceptedPayloadSchema = object({}, { unknownKeys: "error" });
export type SessionAbortAcceptedPayload = InferOutput<typeof sessionAbortAcceptedPayloadSchema>;
export type SessionAbortAcceptedMessage = RunnerMessage<SessionAbortAcceptedPayload> & {
  type: typeof SESSION_ABORT_ACCEPTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

export const sessionAbortRejectedPayloadSchema = object(
  {
    message: string().refine(
      (value) => value.trim().length > 0 && value.length <= 1_000,
      "Abort rejection messages must be between 1 and 1000 characters.",
    ),
  },
  { unknownKeys: "error" },
);
export type SessionAbortRejectedPayload = InferOutput<typeof sessionAbortRejectedPayloadSchema>;
export type SessionAbortRejectedMessage = RunnerMessage<SessionAbortRejectedPayload> & {
  type: typeof SESSION_ABORT_REJECTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};
