import { number, object, optional, parse } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";

import { runnerIdSchema, runnerTokenSchema } from "@/src/runner-enrollment.ts";
import { parseRunnerMessage, type RunnerMessage } from "@/src/runner-message.ts";
import {
  RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE,
  RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE,
  RUNNER_RECONCILE_START_MESSAGE_TYPE,
  type RunnerReconcileChunkPayload,
  runnerReconcileChunkPayloadSchema,
  type RunnerReconcileCompletePayload,
  runnerReconcileCompletePayloadSchema,
  type RunnerReconcileStartPayload,
  runnerReconcileStartPayloadSchema,
  sessionIdSchema,
} from "@/src/runner-session-inventory.ts";
import {
  SESSION_EVENT_MESSAGE_TYPE,
  type SessionEventMessage,
  sessionEventPayloadSchema,
} from "@/src/runner-session-events.ts";
import {
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionProvisionAcceptedMessage,
  sessionProvisionAcceptedPayloadSchema,
  type SessionProvisionCommand,
  type SessionProvisionCommandPayload,
  sessionProvisionCommandPayloadSchema,
  type SessionProvisionRejectedMessage,
  sessionProvisionRejectedPayloadSchema,
} from "@/src/runner-session-provisioning.ts";
import type { OptionalSchemaProperties } from "@/src/schema-output.ts";

export const RUNNER_HELLO_MESSAGE_TYPE = "runner.hello";
export const RUNNER_HEARTBEAT_MESSAGE_TYPE = "runner.heartbeat";
export const RUNNER_CONNECTED_MESSAGE_TYPE = "runner.connected";

export type RunnerClientMessage =
  | (RunnerMessage<RunnerHelloPayload> & { type: typeof RUNNER_HELLO_MESSAGE_TYPE })
  | (RunnerMessage<RunnerHeartbeatPayload> & { type: typeof RUNNER_HEARTBEAT_MESSAGE_TYPE })
  | (RunnerMessage<RunnerReconcileStartPayload> & {
    type: typeof RUNNER_RECONCILE_START_MESSAGE_TYPE;
  })
  | (RunnerMessage<RunnerReconcileChunkPayload> & {
    type: typeof RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE;
  })
  | (RunnerMessage<RunnerReconcileCompletePayload> & {
    type: typeof RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE;
  })
  | SessionProvisionAcceptedMessage
  | SessionProvisionRejectedMessage
  | SessionEventMessage;

export type RunnerServerMessage =
  | (RunnerMessage<RunnerConnectedPayload> & {
    type: typeof RUNNER_CONNECTED_MESSAGE_TYPE;
  })
  | SessionProvisionCommand;

const helloPayloadSchema = object(
  { token: runnerTokenSchema },
  { unknownKeys: "error" },
);

const nonNegativeIntegerSchema = number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a non-negative safe integer.",
);

const positiveIntegerSchema = number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  "Expected a positive safe integer.",
);

/** An omitted maxConcurrentSessions means the runner imposes no concurrent-session limit. */
const runnerCapacitySchema = object(
  {
    maxConcurrentSessions: optional(positiveIntegerSchema),
    activeSessions: nonNegativeIntegerSchema,
    vmCpuCount: positiveIntegerSchema,
    vmMemoryMiB: positiveIntegerSchema,
    diskFreeMiB: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

/** observedAt is a Unix epoch timestamp in milliseconds. */
const heartbeatPayloadSchema = object(
  {
    observedAt: number().refine(
      (value) => Number.isSafeInteger(value) && value >= 0,
      "Heartbeat time must be a non-negative Unix timestamp in milliseconds.",
    ),
    capacity: runnerCapacitySchema,
  },
  { unknownKeys: "error" },
);

const connectedPayloadSchema = object(
  {
    runnerId: runnerIdSchema,
  },
  { unknownKeys: "error" },
);

export type RunnerHelloPayload = InferOutput<typeof helloPayloadSchema>;
export type RunnerCapacity = OptionalSchemaProperties<
  InferOutput<typeof runnerCapacitySchema>,
  "maxConcurrentSessions"
>;
export type RunnerHeartbeatPayload =
  & Omit<
    InferOutput<typeof heartbeatPayloadSchema>,
    "capacity"
  >
  & { capacity: RunnerCapacity };
export type RunnerConnectedPayload = InferOutput<typeof connectedPayloadSchema>;

export function parseRunnerClientMessage(input: unknown): RunnerClientMessage {
  const message = parseRunnerMessage(input);

  if (message.type === RUNNER_HELLO_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    return { ...message, type: message.type, payload: parse(helloPayloadSchema, message.payload) };
  }
  if (message.type === RUNNER_HEARTBEAT_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(heartbeatPayloadSchema, message.payload),
    };
  }
  if (message.type === RUNNER_RECONCILE_START_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(runnerReconcileStartPayloadSchema, message.payload),
    };
  }
  if (message.type === RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(runnerReconcileChunkPayloadSchema, message.payload),
    };
  }
  if (message.type === RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(runnerReconcileCompletePayloadSchema, message.payload),
    };
  }
  if (message.type === SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE) {
    assertSessionResponseEnvelope(message);
    const payload = parse(sessionProvisionAcceptedPayloadSchema, message.payload);
    if (payload.session.id !== message.sessionId) {
      throw new TypeError("Provisioning acceptance session identifiers must match.");
    }
    return { ...message, type: message.type, payload };
  }
  if (message.type === SESSION_PROVISION_REJECTED_MESSAGE_TYPE) {
    assertSessionResponseEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(sessionProvisionRejectedPayloadSchema, message.payload),
    };
  }
  if (message.type === SESSION_EVENT_MESSAGE_TYPE) {
    assertSessionResponseEnvelope(message);
    return {
      ...message,
      type: message.type,
      payload: parse(sessionEventPayloadSchema, message.payload),
    };
  }
  throw new TypeError(`Unsupported runner client message type: ${message.type}`);
}

export function parseRunnerServerMessage(input: unknown): RunnerServerMessage {
  const message = parseRunnerMessage(input);
  if (message.type === RUNNER_CONNECTED_MESSAGE_TYPE) {
    assertConnectionEnvelope(message);
    const payload = parse(connectedPayloadSchema, message.payload);
    return { ...message, type: message.type, payload };
  }
  if (message.type === SESSION_PROVISION_MESSAGE_TYPE) {
    assertSessionCommandEnvelope(message);
    const payload: SessionProvisionCommandPayload = parse(
      sessionProvisionCommandPayloadSchema,
      message.payload,
    );
    return {
      ...message,
      type: message.type,
      sessionId: message.sessionId,
      payload,
    };
  }
  throw new TypeError(`Unsupported runner server message type: ${message.type}`);
}

function assertConnectionEnvelope(message: RunnerMessage): void {
  if (message.sessionId !== undefined || message.correlationId !== undefined) {
    throw new TypeError("Runner connection messages must not identify a session or correlation.");
  }
}

function assertSessionCommandEnvelope(
  message: RunnerMessage,
): asserts message is RunnerMessage & { sessionId: string } {
  if (message.sessionId === undefined || message.correlationId !== undefined) {
    throw new TypeError("Runner session commands require a session ID and no correlation ID.");
  }
  parse(sessionIdSchema, message.sessionId);
}

function assertSessionResponseEnvelope(
  message: RunnerMessage,
): asserts message is RunnerMessage & { sessionId: string; correlationId: string } {
  if (message.sessionId === undefined || message.correlationId === undefined) {
    throw new TypeError("Runner session responses require session and correlation IDs.");
  }
  parse(sessionIdSchema, message.sessionId);
  if (message.correlationId.length === 0) {
    throw new TypeError("Runner session response correlation IDs must not be empty.");
  }
}
