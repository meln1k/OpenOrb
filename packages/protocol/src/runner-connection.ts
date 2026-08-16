import { number, object, optional, parse } from "@remix-run/data-schema";

import { runnerIdSchema, runnerTokenSchema } from "@/src/runner-enrollment.ts";
import { parseRunnerMessage, type RunnerMessage } from "@/src/runner-message.ts";

export const RUNNER_HELLO_MESSAGE_TYPE = "runner.hello";
export const RUNNER_HEARTBEAT_MESSAGE_TYPE = "runner.heartbeat";
export const RUNNER_CONNECTED_MESSAGE_TYPE = "runner.connected";

export interface RunnerHelloPayload {
  token: string;
}

export interface RunnerCapacity {
  /** Omission means the runner does not impose a concurrent-session limit. */
  maxConcurrentSessions?: number;
  activeSessions: number;
  vmCpuCount: number;
  vmMemoryMiB: number;
  diskFreeMiB: number;
}

export interface RunnerHeartbeatPayload {
  /** Unix epoch time in milliseconds. */
  observedAt: number;
  capacity: RunnerCapacity;
}

export interface RunnerConnectedPayload {
  runnerId: string;
}

export type RunnerClientMessage =
  | (RunnerMessage<RunnerHelloPayload> & { type: typeof RUNNER_HELLO_MESSAGE_TYPE })
  | (RunnerMessage<RunnerHeartbeatPayload> & { type: typeof RUNNER_HEARTBEAT_MESSAGE_TYPE });

export type RunnerServerMessage = RunnerMessage<RunnerConnectedPayload> & {
  type: typeof RUNNER_CONNECTED_MESSAGE_TYPE;
};

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

export function parseRunnerClientMessage(input: unknown): RunnerClientMessage {
  const message = parseRunnerMessage(input);
  assertConnectionEnvelope(message);

  if (message.type === RUNNER_HELLO_MESSAGE_TYPE) {
    return { ...message, type: message.type, payload: parse(helloPayloadSchema, message.payload) };
  }
  if (message.type === RUNNER_HEARTBEAT_MESSAGE_TYPE) {
    return {
      ...message,
      type: message.type,
      payload: parse(heartbeatPayloadSchema, message.payload),
    };
  }
  throw new TypeError(`Unsupported runner client message type: ${message.type}`);
}

export function parseRunnerServerMessage(input: unknown): RunnerServerMessage {
  const message = parseRunnerMessage(input);
  assertConnectionEnvelope(message);
  if (message.type !== RUNNER_CONNECTED_MESSAGE_TYPE) {
    throw new TypeError(`Unsupported runner server message type: ${message.type}`);
  }
  const payload = parse(connectedPayloadSchema, message.payload);
  return { ...message, type: message.type, payload };
}

function assertConnectionEnvelope(message: RunnerMessage): void {
  if (message.sessionId !== undefined || message.correlationId !== undefined) {
    throw new TypeError("Runner connection messages must not identify a session or correlation.");
  }
}
