import { any, literal, object, optional, parse, string } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";

import type { OptionalSchemaProperties } from "@/src/schema-output.ts";

export const runnerMessageSchema = object(
  {
    version: literal(1 as const),
    id: string(),
    type: string(),
    sessionId: optional(string()),
    correlationId: optional(string()),
    payload: any(),
  },
  { unknownKeys: "error" },
);

type RunnerMessageEnvelope = OptionalSchemaProperties<
  InferOutput<typeof runnerMessageSchema>,
  "sessionId" | "correlationId"
>;

export type RunnerMessage<T = unknown> = Omit<RunnerMessageEnvelope, "payload"> & { payload: T };

export function parseRunnerMessage(input: unknown): RunnerMessage {
  return parse(runnerMessageSchema, input);
}
