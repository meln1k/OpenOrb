import { Schema } from "effect";

import { MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES } from "./runner-api-limits.ts";

export const MAX_SESSION_ENVIRONMENT_SECRETS = 64;
export const MAX_SESSION_SECRET_HOSTS = 32;
export const MAX_SESSION_SECRET_HOST_CHARACTERS = 253;
export const RUNNER_PROTOCOL_VERSION = 29;

export * from "./runner-api-limits.ts";

export const EnvironmentState = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type EnvironmentState = typeof EnvironmentState.Type;

const Uuid = Schema.String.check(Schema.isUUID());

export const SessionId = Uuid.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const RunnerId = Uuid.pipe(Schema.brand("RunnerId"));
export type RunnerId = typeof RunnerId.Type;

export const WorkspaceId = Uuid.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SafeMessage = Schema.String.check(
  Schema.isMinLength(1, { message: "Error messages must not be empty." }),
  Schema.isMaxLength(1_000, { message: "Error messages must contain at most 1000 characters." }),
);
const RunnerToken = Schema.String.check(
  Schema.isStartingWith("openorb_runner_"),
  Schema.isMinLength("openorb_runner_".length + 1),
  Schema.isMaxLength(128),
);
const RunnerVersion = boundedString(1, 64, "Runner versions");
const ProtocolVersion = NonNegativeInt;

export class RunnerIdentity extends Schema.Class<RunnerIdentity>("RunnerIdentity")({
  token: RunnerToken,
  runnerId: RunnerId,
  runnerVersion: RunnerVersion,
  protocolVersion: ProtocolVersion,
}) {}

export class RunnerCapacity extends Schema.Class<RunnerCapacity>("RunnerCapacity")({
  activeSessions: NonNegativeInt,
  vmCpuCount: PositiveInt,
  vmMemoryMiB: PositiveInt,
  diskFreeMiB: NonNegativeInt,
}) {}

export const OrbSize = Schema.Literals(["tiny", "small", "medium", "large", "xxlarge"]);
export type OrbSize = typeof OrbSize.Type;

/** An environment-only Session on a runner (ADR 0006). */
export class RunnerEnvironmentSnapshot extends Schema.Class<RunnerEnvironmentSnapshot>(
  "RunnerEnvironmentSnapshot",
)({
  sessionId: SessionId,
  state: EnvironmentState,
}) {}

const ObservedAt = NonNegativeInt;

/**
 * A runner's environments and capacity (ADR 0006), in order on one stream: the snapshot first,
 * then changes. Sessions live in Session Durable Objects.
 */
export const RunnerStateEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    observedAt: ObservedAt,
    capacity: RunnerCapacity,
    environments: Schema.Array(RunnerEnvironmentSnapshot),
  }),
  Schema.Struct({
    type: Schema.Literal("runner.observed"),
    observedAt: ObservedAt,
    capacity: RunnerCapacity,
  }),
  Schema.Struct({
    type: Schema.Literal("environment.changed"),
    environment: RunnerEnvironmentSnapshot,
  }),
]);
export type RunnerStateEvent = typeof RunnerStateEvent.Type;

const Secret = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);
const SessionEnvironmentSecretName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.makeFilter((value) =>
    isReservedSessionEnvironmentName(value)
      ? "Environment secret names must not use OpenOrb's reserved variables."
      : undefined,
  ),
);
const SessionSecretHost = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SESSION_SECRET_HOST_CHARACTERS),
  Schema.makeFilter((value) =>
    isValidSessionSecretHost(value)
      ? undefined
      : "Expected a hostname or leading-wildcard hostname such as api.example.com or *.example.com.",
  ),
);
const SessionSecretHosts = Schema.Array(SessionSecretHost).check(
  Schema.isMaxLength(MAX_SESSION_SECRET_HOSTS),
  Schema.makeFilter((hosts) =>
    new Set(hosts.map((host) => host.toLowerCase())).size === hosts.length
      ? undefined
      : "Environment secret host patterns must be unique.",
  ),
  Schema.makeFilter((hosts) =>
    !hosts.includes("*") || hosts.length === 1
      ? undefined
      : "The wildcard host must be the only environment secret host pattern.",
  ),
);

export class SessionEnvironmentSecret extends Schema.Class<SessionEnvironmentSecret>(
  "SessionEnvironmentSecret",
)({
  name: SessionEnvironmentSecretName,
  value: Secret,
  allowedHosts: Schema.optionalKey(SessionSecretHosts),
}) {}

export const SessionEnvironmentSecrets = Schema.Array(SessionEnvironmentSecret).check(
  Schema.isMaxLength(MAX_SESSION_ENVIRONMENT_SECRETS),
  Schema.makeFilter((secrets) =>
    new Set(secrets.map((secret) => secret.name)).size === secrets.length
      ? undefined
      : "Environment secret names must be unique.",
  ),
  Schema.makeFilter((secrets) =>
    utf8Length(JSON.stringify(secrets)) <= MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES
      ? undefined
      : `Environment secrets must fit within ${MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES} JSON bytes.`,
  ),
);

const GitAuthorName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) =>
    value.includes("\0") ? "Git author names must not contain NUL bytes." : undefined,
  ),
);
const GitAuthorEmail = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: "Expected a valid Git author email." }),
);

export class GitAuthor extends Schema.Class<GitAuthor>("GitAuthor")({
  name: GitAuthorName,
  email: GitAuthorEmail,
}) {}

export const SessionRepositoryUrl = Schema.String.check(
  Schema.makeFilter((value) =>
    isCanonicalGitHubRepository(value)
      ? undefined
      : "Expected a canonical GitHub HTTPS repository URL.",
  ),
);
export class RunnerIdentityError extends Schema.TaggedError<RunnerIdentityError>()(
  "RunnerIdentityError",
  { message: SafeMessage },
) {}

export class RunnerWatchError extends Schema.TaggedError<RunnerWatchError>()("RunnerWatchError", {
  message: SafeMessage,
}) {}

export class CapacityExceeded extends Schema.TaggedError<CapacityExceeded>()("CapacityExceeded", {
  message: SafeMessage,
}) {}

export class SessionConflict extends Schema.TaggedError<SessionConflict>()("SessionConflict", {
  sessionId: SessionId,
  message: SafeMessage,
}) {}

export class DeleteFailed extends Schema.TaggedError<DeleteFailed>()("DeleteFailed", {
  sessionId: SessionId,
  message: SafeMessage,
}) {}

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

export function isReservedSessionEnvironmentName(value: string): boolean {
  return (
    value.startsWith("OPENORB_") ||
    value === "GH_TOKEN" ||
    value === "GH_HOST" ||
    value === "GH_PROMPT_DISABLED" ||
    value === "GIT_TERMINAL_PROMPT" ||
    value === "GIT_CONFIG_COUNT" ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(value)
  );
}

export function isValidSessionSecretHost(value: string): boolean {
  return (
    value.length <= MAX_SESSION_SECRET_HOST_CHARACTERS &&
    /^(?:\*|(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)$/.test(
      value,
    )
  );
}

function isCanonicalGitHubRepository(value: string): boolean {
  const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(value);
  if (decoded._tag === "Failure") return false;
  const url = decoded.success;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(".git")
  ) {
    return false;
  }
  const parts = url.pathname.slice(1, -4).split("/");
  const owner = parts[0];
  const repository = parts[1];
  return (
    parts.length === 2 &&
    owner !== undefined &&
    repository !== undefined &&
    /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repository) &&
    repository !== "." &&
    repository !== ".." &&
    value === `https://github.com/${owner}/${repository}.git`
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
