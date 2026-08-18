import { literal, number, object, string, union } from "@remix-run/data-schema";

import type { InferOutput } from "@remix-run/data-schema";
import type { RunnerMessage } from "@/src/runner-message.ts";
import type { RunnerSessionState } from "@/src/runner-session-inventory.ts";

export const SESSION_EVENT_MESSAGE_TYPE = "session.event";
export const MAX_PROVISIONING_EVENT_TEXT_BYTES = 16 * 1024;

export const runnerCheckoutStateSchema = union([
  literal("pending" as const),
  literal("available" as const),
  literal("unavailable" as const),
]);

export type RunnerCheckoutState = InferOutput<typeof runnerCheckoutStateSchema>;

export const sessionProvisioningStageSchema = union([
  literal("created" as const),
  literal("starting-vm" as const),
  literal("cloning" as const),
  literal("creating-branch" as const),
  literal("setup" as const),
  literal("ready" as const),
  literal("failed" as const),
]);

export type SessionProvisioningStage = InferOutput<typeof sessionProvisioningStageSchema>;

export function runnerSessionStateForProvisioningStage(
  stage: SessionProvisioningStage,
): RunnerSessionState {
  switch (stage) {
    case "created":
      return "created";
    case "ready":
      return "ready";
    case "failed":
      return "error";
    default:
      return "provisioning";
  }
}

const provisioningStateEventSchema = object(
  {
    type: literal("session.state" as const),
    stage: sessionProvisioningStageSchema,
    checkoutState: runnerCheckoutStateSchema,
  },
  { unknownKeys: "error" },
);

const provisioningLogEventSchema = object(
  {
    type: literal("provisioning.log" as const),
    stream: union([literal("stdout" as const), literal("stderr" as const)]),
    text: string().refine(
      (value) => value.length > 0 && byteLength(value) <= MAX_PROVISIONING_EVENT_TEXT_BYTES,
      `Provisioning log events must contain at most ${MAX_PROVISIONING_EVENT_TEXT_BYTES} UTF-8 bytes.`,
    ),
  },
  { unknownKeys: "error" },
);

export const sessionProvisioningEventSchema = union([
  provisioningStateEventSchema,
  provisioningLogEventSchema,
]);

export type SessionProvisioningEvent = InferOutput<typeof sessionProvisioningEventSchema>;

export const sessionEventPayloadSchema = object(
  {
    cursor: number().refine(
      (value) => Number.isSafeInteger(value) && value > 0,
      "Session event cursors must be positive safe integers.",
    ),
    event: sessionProvisioningEventSchema,
  },
  { unknownKeys: "error" },
);

export type SessionEventPayload = InferOutput<typeof sessionEventPayloadSchema>;

export type SessionEventMessage = RunnerMessage<SessionEventPayload> & {
  type: typeof SESSION_EVENT_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
