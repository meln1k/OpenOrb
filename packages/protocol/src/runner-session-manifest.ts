import { array, literal, number, object, string, union } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";
import { trySync } from "@openorb/result";
import { validate as validateUuid } from "@std/uuid";
import { modelReferenceSchema } from "@/src/model-provider.ts";
import { orbSizeSchema } from "@/src/orb-size.ts";

export const RUNNER_SESSION_SYNC_START_MESSAGE_TYPE = "runner.session-sync.start";
export const RUNNER_SESSION_SYNC_CHUNK_MESSAGE_TYPE = "runner.session-sync.chunk";
export const RUNNER_SESSION_SYNC_COMPLETE_MESSAGE_TYPE = "runner.session-sync.complete";
export const RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT = 25;

export const sessionIdSchema = string().refine(validateUuid, "Expected a session UUID.");
export const projectIdSchema = string().refine(validateUuid, "Expected a project UUID.");
export const runnerSessionStateSchema = union([
  literal("created" as const),
  literal("provisioning" as const),
  literal("running" as const),
  literal("ready" as const),
  literal("error" as const),
]);
export const runnerSessionCreatedAtSchema = string().refine(
  isInstant,
  "Expected an ISO 8601 instant.",
);

const manifestIdSchema = string().refine(validateUuid, "Expected a manifest UUID.");
const nonNegativeIntegerSchema = number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a non-negative safe integer.",
);
const initialPromptPreviewSchema = string().refine(
  (value) =>
    value.length > 0 &&
    value === collapseWhitespace(value) &&
    Array.from(value).length <= 200,
  "Initial prompt previews must contain 1 to 200 normalized Unicode code points.",
);

export const runnerSessionSnapshotSchema = object(
  {
    id: sessionIdSchema,
    projectId: projectIdSchema,
    createdAt: runnerSessionCreatedAtSchema,
    initialPromptPreview: initialPromptPreviewSchema,
    model: modelReferenceSchema,
    orbSize: orbSizeSchema,
    state: runnerSessionStateSchema,
    lastEventCursor: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

export const runnerSessionSyncStartPayloadSchema = object(
  { manifestId: manifestIdSchema },
  { unknownKeys: "error" },
);

export const runnerSessionSyncChunkPayloadSchema = object(
  {
    manifestId: manifestIdSchema,
    sequence: nonNegativeIntegerSchema,
    sessions: array(runnerSessionSnapshotSchema).refine(
      (sessions) =>
        sessions.length > 0 &&
        sessions.length <= RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT &&
        new Set(sessions.map((session) => session.id)).size === sessions.length,
      `Session sync chunks must contain 1 to ${RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT} unique sessions.`,
    ),
  },
  { unknownKeys: "error" },
);

export const runnerSessionSyncCompletePayloadSchema = object(
  {
    manifestId: manifestIdSchema,
    chunkCount: nonNegativeIntegerSchema,
    sessionCount: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

export type RunnerSessionState = InferOutput<typeof runnerSessionStateSchema>;
export type RunnerSessionSnapshot = InferOutput<typeof runnerSessionSnapshotSchema>;
export type RunnerSessionSyncStartPayload = InferOutput<
  typeof runnerSessionSyncStartPayloadSchema
>;
export type RunnerSessionSyncChunkPayload = InferOutput<
  typeof runnerSessionSyncChunkPayloadSchema
>;
export type RunnerSessionSyncCompletePayload = InferOutput<
  typeof runnerSessionSyncCompletePayloadSchema
>;

export function initialPromptPreview(prompt: string): string {
  return Array.from(collapseWhitespace(prompt)).slice(0, 200).join("").trimEnd();
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isInstant(value: string): boolean {
  const [, invalidInstant] = trySync(
    () => Temporal.Instant.from(value),
    (cause) => new InvalidProtocolInstantError(value, cause),
  );
  if (invalidInstant !== undefined) return false;
  return true;
}

class InvalidProtocolInstantError extends Error {
  constructor(readonly value: string, override readonly cause: unknown) {
    super("Runner session creation time is not an ISO 8601 instant.", { cause });
    this.name = "InvalidProtocolInstantError";
  }
}
