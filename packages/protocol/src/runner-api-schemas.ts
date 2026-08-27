import { Schema } from "effect";

import {
  DurableSessionEvent,
  EphemeralSessionEvent,
  RunnerCheckoutState,
} from "./runner-api-session-events.ts";

export const MAX_RPC_INITIAL_PROMPT_BYTES = 32 * 1024;
export const RUNNER_PROTOCOL_VERSION = 3;

const Uuid = Schema.String.check(Schema.isUUID());

export const SessionId = Uuid.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const ProjectId = Uuid.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

export const RunnerId = Uuid.pipe(Schema.brand("RunnerId"));
export type RunnerId = typeof RunnerId.Type;

export const RunId = boundedString(1, 100, "Run identifiers").pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const ClientRequestId = boundedString(1, 100, "Client request identifiers").pipe(
  Schema.brand("ClientRequestId"),
);
export type ClientRequestId = typeof ClientRequestId.Type;

export const SessionCursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const RunnerRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SafeMessage = Schema.String.check(
  Schema.isMinLength(1, { message: "Error messages must not be empty." }),
  Schema.isMaxLength(1_000, { message: "Error messages must contain at most 1000 characters." }),
);
const RunnerToken = Schema.String.check(
  Schema.isStartsWith("openorb_runner_"),
  Schema.isMinLength("openorb_runner_".length + 1),
  Schema.isMaxLength(128),
);
const RunnerVersion = boundedString(1, 64, "Runner versions");
const ProtocolVersion = NonNegativeInt;
const Capability = boundedString(1, 64, "Runner capabilities");
const Capabilities = Schema.Array(Capability).check(
  Schema.isMaxLength(32, { message: "A runner may advertise at most 32 capabilities." }),
  Schema.makeFilter((values) =>
    new Set(values).size === values.length ? undefined : "Runner capabilities must be unique."
  ),
);

export class RunnerIdentity extends Schema.Class<RunnerIdentity>("RunnerIdentity")({
  token: RunnerToken,
  runnerId: RunnerId,
  runnerVersion: RunnerVersion,
  protocolVersion: ProtocolVersion,
  capabilities: Capabilities,
}) {}

export class RunnerCapacity extends Schema.Class<RunnerCapacity>("RunnerCapacity")({
  maxConcurrentSessions: Schema.optionalKey(PositiveInt),
  activeSessions: NonNegativeInt,
  vmCpuCount: PositiveInt,
  vmMemoryMiB: PositiveInt,
  diskFreeMiB: NonNegativeInt,
}) {}

export const RunnerSessionState = Schema.Literals([
  "created",
  "provisioning",
  "running",
  "ready",
  "error",
]);
export type RunnerSessionState = typeof RunnerSessionState.Type;

const ModelProviderId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
);

export const ModelReference = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator >= value.length - 1) {
      return "Expected a provider/model reference.";
    }
    if (/\s/u.test(value.slice(separator + 1))) {
      return "Model identifiers must not contain whitespace.";
    }
    const provider = Schema.decodeUnknownResult(ModelProviderId)(value.slice(0, separator));
    return provider._tag === "Success" ? undefined : "Expected a valid model provider identifier.";
  }),
);

export const OrbSize = Schema.Literals(["tiny", "small", "medium", "large", "xxlarge"]);
export type OrbSize = typeof OrbSize.Type;

export const RunnerSessionCreatedAt = Schema.String.check(
  Schema.makeFilter((value) =>
    Schema.decodeUnknownResult(Schema.DateTimeUtcFromString)(value)._tag === "Success"
      ? undefined
      : "Expected an ISO 8601 instant."
  ),
);

const InitialPromptPreview = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value === collapseWhitespace(value) && Array.from(value).length <= 200
      ? undefined
      : "Initial prompt previews must contain 1 to 200 normalized Unicode code points."
  ),
);

export function initialPromptPreview(prompt: string): string {
  return Array.from(collapseWhitespace(prompt)).slice(0, 200).join("").trimEnd();
}

export class RunnerSessionSnapshot extends Schema.Class<RunnerSessionSnapshot>(
  "RunnerSessionSnapshot",
)({
  id: SessionId,
  projectId: ProjectId,
  createdAt: RunnerSessionCreatedAt,
  initialPromptPreview: InitialPromptPreview,
  model: ModelReference,
  orbSize: OrbSize,
  state: RunnerSessionState,
  lastEventCursor: SessionCursor,
  activeRunId: Schema.optionalKey(RunId),
}) {}

const ObservedAt = NonNegativeInt;

const SnapshotSessionEvent = Schema.Struct({
  type: Schema.Literal("snapshot.session"),
  session: RunnerSessionSnapshot,
});

const SnapshotCompleteEvent = Schema.Struct({
  type: Schema.Literal("snapshot.complete"),
  revision: RunnerRevision,
  sessionCount: NonNegativeInt,
  observedAt: ObservedAt,
  capacity: RunnerCapacity,
});

const RunnerObservedEvent = Schema.Struct({
  type: Schema.Literal("runner.observed"),
  revision: RunnerRevision,
  observedAt: ObservedAt,
  capacity: RunnerCapacity,
});

const SessionUpdatedEvent = Schema.Struct({
  type: Schema.Literal("session.updated"),
  revision: RunnerRevision,
  session: RunnerSessionSnapshot,
});

const SessionRemovedEvent = Schema.Struct({
  type: Schema.Literal("session.removed"),
  revision: RunnerRevision,
  sessionId: SessionId,
});

export const RunnerStateEvent = Schema.Union([
  SnapshotSessionEvent,
  SnapshotCompleteEvent,
  RunnerObservedEvent,
  SessionUpdatedEvent,
  SessionRemovedEvent,
]);

const ThinkingLevel = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
const Secret = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);

export class SessionModelRuntime extends Schema.Class<SessionModelRuntime>("SessionModelRuntime")({
  model: ModelReference,
  thinkingLevel: ThinkingLevel,
  credential: Schema.Struct({
    type: Schema.Literal("api_key"),
    value: Secret,
  }),
}) {}

export const SessionRepositoryUrl = Schema.String.check(
  Schema.makeFilter((value) =>
    isCanonicalGitHubRepository(value)
      ? undefined
      : "Expected a canonical GitHub HTTPS repository URL."
  ),
);
export const SessionGitReference = Schema.String.check(
  Schema.makeFilter((value) =>
    isSafeGitReference(value) ? undefined : "Expected a valid Git branch or tag reference."
  ),
);
const InitialPrompt = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 && utf8Length(value) <= MAX_RPC_INITIAL_PROMPT_BYTES
      ? undefined
      : `Initial prompts must contain text and be at most ${MAX_RPC_INITIAL_PROMPT_BYTES} UTF-8 bytes.`
  ),
);
const Prompt = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 && utf8Length(value) <= MAX_RPC_INITIAL_PROMPT_BYTES
      ? undefined
      : `Session prompts must contain text and be at most ${MAX_RPC_INITIAL_PROMPT_BYTES} UTF-8 bytes.`
  ),
);

const CreateSessionPayload = Schema.Struct({
  mode: Schema.Literal("create"),
  sessionId: SessionId,
  projectId: ProjectId,
  repositoryUrl: SessionRepositoryUrl,
  ref: SessionGitReference,
  branchName: SessionGitReference,
  orbSize: OrbSize,
  initialPrompt: InitialPrompt,
  modelRuntime: SessionModelRuntime,
  githubToken: Schema.optionalKey(Secret),
});

const RetrySessionPayload = Schema.Struct({
  mode: Schema.Literal("retry"),
  sessionId: SessionId,
  modelRuntime: SessionModelRuntime,
  githubToken: Schema.optionalKey(Secret),
});

export const ProvisionSessionPayload = Schema.Union([
  CreateSessionPayload,
  RetrySessionPayload,
]);

export class ProvisionSessionSuccess extends Schema.Class<ProvisionSessionSuccess>(
  "ProvisionSessionSuccess",
)({
  session: RunnerSessionSnapshot,
  ref: SessionGitReference,
  branchName: SessionGitReference,
  checkoutState: RunnerCheckoutState,
}) {}

export class PromptSessionPayload extends Schema.Class<PromptSessionPayload>(
  "PromptSessionPayload",
)({
  sessionId: SessionId,
  clientRequestId: ClientRequestId,
  prompt: Prompt,
  modelRuntime: SessionModelRuntime,
}) {}

export class PromptSessionAccepted extends Schema.Class<PromptSessionAccepted>(
  "PromptSessionAccepted",
)({
  clientRequestId: ClientRequestId,
  runId: RunId,
  mode: Schema.Literals(["started", "follow-up"]),
}) {}

export class AbortSessionPayload extends Schema.Class<AbortSessionPayload>("AbortSessionPayload")({
  sessionId: SessionId,
  runId: RunId,
}) {}

export class AbortSessionAccepted extends Schema.Class<AbortSessionAccepted>(
  "AbortSessionAccepted",
)({
  runId: RunId,
}) {}

export class WatchSessionPayload extends Schema.Class<WatchSessionPayload>("WatchSessionPayload")({
  sessionId: SessionId,
  afterCursor: SessionCursor,
}) {}

const DurableSessionEventDelivery = Schema.Struct({
  runId: Schema.NullOr(RunId),
  cursor: Schema.Int.check(Schema.isGreaterThan(0)),
  event: DurableSessionEvent,
});

const EphemeralSessionEventDelivery = Schema.Struct({
  runId: Schema.NullOr(RunId),
  event: EphemeralSessionEvent,
});

export const WatchSessionEvent = Schema.Union([
  DurableSessionEventDelivery,
  EphemeralSessionEventDelivery,
]);

export class RunnerIdentityError extends Schema.TaggedError<RunnerIdentityError>()(
  "RunnerIdentityError",
  { message: SafeMessage },
) {}

export class RunnerWatchError extends Schema.TaggedError<RunnerWatchError>()(
  "RunnerWatchError",
  { message: SafeMessage },
) {}

export class CapacityExceeded extends Schema.TaggedError<CapacityExceeded>()(
  "CapacityExceeded",
  { message: SafeMessage },
) {}

export class SessionConflict extends Schema.TaggedError<SessionConflict>()(
  "SessionConflict",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class ProvisionRejected extends Schema.TaggedError<ProvisionRejected>()(
  "ProvisionRejected",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class PromptRejected extends Schema.TaggedError<PromptRejected>()(
  "PromptRejected",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class AbortRejected extends Schema.TaggedError<AbortRejected>()(
  "AbortRejected",
  { sessionId: SessionId, runId: RunId, message: SafeMessage },
) {}

export class SessionCorrupt extends Schema.TaggedError<SessionCorrupt>()(
  "SessionCorrupt",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class HistoryReadError extends Schema.TaggedError<HistoryReadError>()(
  "HistoryReadError",
  { sessionId: SessionId, message: SafeMessage },
) {}

function boundedString(minimumLength: number, maximumLength: number, label: string) {
  return Schema.String.check(
    Schema.isMinLength(minimumLength, {
      message: `${label} must contain at least ${minimumLength} character(s).`,
    }),
    Schema.isMaxLength(maximumLength, {
      message: `${label} must contain at most ${maximumLength} characters.`,
    }),
  );
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isCanonicalGitHubRepository(value: string): boolean {
  const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(value);
  if (decoded._tag === "Failure") return false;
  const url = decoded.success;
  if (
    url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username ||
    url.password || url.search || url.hash || !url.pathname.endsWith(".git")
  ) {
    return false;
  }
  const parts = url.pathname.slice(1, -4).split("/");
  const owner = parts[0];
  const repository = parts[1];
  return parts.length === 2 && owner !== undefined && repository !== undefined &&
    /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repository) && repository !== "." &&
    repository !== ".." && value === `https://github.com/${owner}/${repository}.git`;
}

export function isSafeGitReference(value: string): boolean {
  return value.length > 0 && value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") &&
    !value.includes("//") && !value.includes("@{") && !value.endsWith("/") &&
    !value.endsWith(".") && !value.endsWith(".lock");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
