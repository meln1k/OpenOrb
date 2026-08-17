import { array, literal, number, object, string, union } from "@remix-run/data-schema";
import { validate as validateUuid } from "@std/uuid";

export const RUNNER_RECONCILE_START_MESSAGE_TYPE = "runner.reconcile.start";
export const RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE = "runner.reconcile.chunk";
export const RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE = "runner.reconcile.complete";
export const RUNNER_RECONCILE_CHUNK_SESSION_LIMIT = 25;

export type RunnerSessionState = "created" | "error";

export interface RunnerSessionSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  initialPromptPreview: string;
  state: RunnerSessionState;
  lastEventCursor: number;
}

export interface RunnerReconcileStartPayload {
  snapshotId: string;
}

export interface RunnerReconcileChunkPayload {
  snapshotId: string;
  sequence: number;
  sessions: RunnerSessionSnapshot[];
}

export interface RunnerReconcileCompletePayload {
  snapshotId: string;
  chunkCount: number;
  sessionCount: number;
}

export const sessionIdSchema = string().refine(validateUuid, "Expected a session UUID.");
export const projectIdSchema = string().refine(validateUuid, "Expected a project UUID.");
export const runnerSessionStateSchema = union([
  literal("created" as const),
  literal("error" as const),
]);
export const runnerSessionCreatedAtSchema = string().refine(
  isInstant,
  "Expected an ISO 8601 instant.",
);

const snapshotIdSchema = string().refine(validateUuid, "Expected a snapshot UUID.");
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
    state: runnerSessionStateSchema,
    lastEventCursor: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

export const runnerReconcileStartPayloadSchema = object(
  { snapshotId: snapshotIdSchema },
  { unknownKeys: "error" },
);

export const runnerReconcileChunkPayloadSchema = object(
  {
    snapshotId: snapshotIdSchema,
    sequence: nonNegativeIntegerSchema,
    sessions: array(runnerSessionSnapshotSchema).refine(
      (sessions) =>
        sessions.length > 0 &&
        sessions.length <= RUNNER_RECONCILE_CHUNK_SESSION_LIMIT &&
        new Set(sessions.map((session) => session.id)).size === sessions.length,
      `Reconcile chunks must contain 1 to ${RUNNER_RECONCILE_CHUNK_SESSION_LIMIT} unique sessions.`,
    ),
  },
  { unknownKeys: "error" },
);

export const runnerReconcileCompletePayloadSchema = object(
  {
    snapshotId: snapshotIdSchema,
    chunkCount: nonNegativeIntegerSchema,
    sessionCount: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

export function initialPromptPreview(prompt: string): string {
  return Array.from(collapseWhitespace(prompt)).slice(0, 200).join("");
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isInstant(value: string): boolean {
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}
