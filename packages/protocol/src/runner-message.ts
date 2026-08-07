import { any, literal, object, optional, parse, string } from "@remix-run/data-schema";

export interface RunnerMessage<T = unknown> {
  version: 1;
  id: string;
  type: string;
  sessionId?: string;
  correlationId?: string;
  payload: T;
}

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

export function parseRunnerMessage(input: unknown): RunnerMessage {
  return parse(runnerMessageSchema, input);
}
