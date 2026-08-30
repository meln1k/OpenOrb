import {
  initialPromptPreview,
  type RunId,
  type RunnerCheckoutState,
  RunnerId,
  type RunnerSessionCreatedAt,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  SessionGitSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Data, DateTime, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { dirname, join } from "node:path";

import type { AgentEnvironmentCheckpoint } from "../environment/agent-environment.ts";
import { readPiSessionEvents } from "../harness/pi/history.ts";
import { RunnerSessionDefinition, runnerSessionDefinitionsEqual } from "./definition.ts";
import {
  applyLifecycleEvent,
  legacyMetadataSchema,
  metadataSchema,
  projectSessionLifecycle,
  provisioningUpdated,
  type RunnerSessionMetadata,
  type SessionLifecycleEvent,
  type SessionLifecycleEventEnvelope,
  SessionLifecycleEventEnvelope as SessionLifecycleEventEnvelopeSchema,
  type SessionLifecycleProjection,
} from "./lifecycle.ts";

export type { RunnerSessionMetadata } from "./lifecycle.ts";

const SESSIONS_DIRECTORY = "sessions";
const LIFECYCLE_FILE = "lifecycle.jsonl";
const LEGACY_METADATA_FILE = "metadata.json";
const PI_SESSION_FILE = join("pi", "session.jsonl");
const GIT_SNAPSHOT_FILE = join("snapshots", "git-snapshot.json");
const CHECKPOINTS_DIRECTORY = "checkpoints";

const gitSnapshotStateSchema = Schema.Struct({
  snapshot: SessionGitSnapshot,
  notificationPending: Schema.Boolean,
});
const MetadataJson = Schema.fromJsonString(Schema.Union([legacyMetadataSchema, metadataSchema]));
const GitSnapshotStateJson = Schema.fromJsonString(gitSnapshotStateSchema);
const LifecycleEventEnvelopeJson = Schema.fromJsonString(SessionLifecycleEventEnvelopeSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

export type RunnerSessionGitSnapshotState = typeof gitSnapshotStateSchema.Type;

export interface EnsureRunnerSessionResult {
  readonly disposition: "created" | "existing";
  readonly metadata: RunnerSessionMetadata;
}

export interface RunnerSessionPiPaths {
  agentDirectory: string;
  sessionFile: string;
}

export interface RunnerSessionCheckpointCandidate {
  readonly file: string;
  readonly path: string;
  readonly startedBy: number;
}

export interface RunnerSessionRunStarted {
  readonly metadata: RunnerSessionMetadata;
  readonly startedBy: number;
}

export interface RunnerSessionResumeStarted {
  readonly metadata: RunnerSessionMetadata;
  readonly startedBy: number;
}

export interface UpdateRunnerSessionProvisioningInput {
  state: RunnerSessionState;
  checkoutState: RunnerCheckoutState;
  baseCommit?: string;
}

export interface RunnerSessionManifestError {
  sessionDirectory: string;
  message: string;
}

export interface RunnerSessionManifest {
  sessions: RunnerSessionSnapshot[];
  errors: RunnerSessionManifestError[];
}

export type RunnerSessionStoreOperation =
  | "initialize"
  | "ensure-session"
  | "read-metadata"
  | "update-session-state"
  | "update-provisioning"
  | "get-workspace-path"
  | "get-pi-paths"
  | "start-run"
  | "accept-follow-up"
  | "settle-run"
  | "begin-resume"
  | "complete-resume"
  | "fail-resume"
  | "begin-checkpoint"
  | "publish-checkpoint"
  | "fail-checkpoint"
  | "read-checkpoint"
  | "reconcile-checkpoints"
  | "read-git-snapshot"
  | "write-git-snapshot"
  | "get-session-snapshot"
  | "load-session-manifest";

export class RunnerSessionDefinitionConflict extends Data.TaggedError(
  "RunnerSessionDefinitionConflict",
)<{
  readonly sessionId: SessionId;
  readonly message: string;
}> {}

export class RunnerSessionStoreFailure extends Data.TaggedError("RunnerSessionStoreFailure")<{
  readonly operation: RunnerSessionStoreOperation;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type RunnerSessionStoreError = RunnerSessionDefinitionConflict | RunnerSessionStoreFailure;

export interface RunnerSessionStore {
  readonly ensureSession: (
    sessionId: SessionId,
    definition: RunnerSessionDefinition,
    createdAt?: typeof RunnerSessionCreatedAt.Type,
  ) => Effect.Effect<EnsureRunnerSessionResult, RunnerSessionStoreError>;
  readonly readMetadata: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly updateSessionState: (
    sessionId: SessionId,
    state: RunnerSessionState,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly updateProvisioning: (
    sessionId: SessionId,
    input: UpdateRunnerSessionProvisioningInput,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly getSessionWorkspacePath: (
    sessionId: SessionId,
  ) => Effect.Effect<string, RunnerSessionStoreError>;
  readonly getSessionPiPaths: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionPiPaths, RunnerSessionStoreError>;
  readonly startRun: (
    sessionId: SessionId,
    runId: RunId,
    acceptedAt?: typeof RunnerSessionCreatedAt.Type,
  ) => Effect.Effect<RunnerSessionRunStarted, RunnerSessionStoreError>;
  readonly acceptFollowUp: (
    sessionId: SessionId,
    runId: RunId,
    acceptedAt?: typeof RunnerSessionCreatedAt.Type,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly settleRun: (
    sessionId: SessionId,
    runId: RunId,
    startedBy: number,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly beginResume: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionResumeStarted, RunnerSessionStoreError>;
  readonly completeResume: (
    sessionId: SessionId,
    startedBy: number,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly failResume: (
    sessionId: SessionId,
    startedBy: number,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly beginCheckpoint: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionCheckpointCandidate, RunnerSessionStoreError>;
  readonly publishCheckpoint: (
    sessionId: SessionId,
    candidate: RunnerSessionCheckpointCandidate,
    checkpoint: AgentEnvironmentCheckpoint,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly failCheckpoint: (
    sessionId: SessionId,
    candidate: RunnerSessionCheckpointCandidate,
    consumed: boolean,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly readCurrentCheckpoint: (
    sessionId: SessionId,
  ) => Effect.Effect<AgentEnvironmentCheckpoint, RunnerSessionStoreError>;
  readonly reconcileCheckpoints: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly readGitSnapshot: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionGitSnapshot, RunnerSessionStoreError>;
  readonly readGitSnapshotState: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionGitSnapshotState, RunnerSessionStoreError>;
  readonly writeGitSnapshotState: (
    sessionId: SessionId,
    state: RunnerSessionGitSnapshotState,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly getSessionSnapshot: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionSnapshot, RunnerSessionStoreError>;
  readonly loadSessionManifest: () => Effect.Effect<RunnerSessionManifest, RunnerSessionStoreError>;
}

export const RunnerSessionStore: Context.Service<RunnerSessionStore, RunnerSessionStore> = Context
  .Service("@openorb/runner/RunnerSessionStore");

export interface RunnerSessionStoreConfig {
  readonly workingDirectory: string;
  readonly runnerId: string;
}

export function makeRunnerSessionStore(
  config: RunnerSessionStoreConfig,
): Effect.Effect<RunnerSessionStore, RunnerSessionStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runnerId = yield* Schema.decodeUnknownEffect(RunnerId)(config.runnerId).pipe(
      Effect.mapError(storeError("initialize", "The runner ID is invalid")),
    );
    const sessionsPath = join(config.workingDirectory, SESSIONS_DIRECTORY);
    const sessionPath = (sessionId: SessionId) => join(sessionsPath, sessionId);
    const checkpointsPath = (sessionId: SessionId) =>
      join(sessionPath(sessionId), CHECKPOINTS_DIRECTORY);
    const fileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(sessionDataError));
    const lifecycleAccess = yield* Semaphore.make(1);
    yield* ensurePrivateDirectory(fs, sessionsPath).pipe(
      Effect.mapError(storeError("initialize", "Could not initialize runner session storage")),
    );

    const readLifecycleValueUnlocked = (
      sessionId: SessionId,
    ): Effect.Effect<SessionLifecycleProjection, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const path = sessionPath(sessionId);
        yield* assertRealDirectory(path, "Runner session directory");
        const lifecyclePath = join(path, LIFECYCLE_FILE);
        let projection: SessionLifecycleProjection;
        if (yield* pathExists(lifecyclePath)) {
          projection = yield* readLifecycleFile(fs, lifecyclePath);
        } else {
          const metadata = yield* readMetadataFile(fs, join(path, LEGACY_METADATA_FILE));
          const imported: SessionLifecycleEventEnvelope = {
            version: 1,
            sequence: 1,
            event: { type: "session.imported", metadata },
          };
          yield* writeNewLifecycleFile(lifecyclePath, imported);
          yield* syncDirectory(path);
          projection = yield* projectSessionLifecycle([imported]).pipe(
            Effect.mapError(sessionDataError),
          );
        }
        const metadata = projection.metadata;
        if (metadata.id !== sessionId) {
          return yield* new RunnerSessionDataError(
            `Session directory ${sessionId} contains lifecycle events for ${metadata.id}.`,
          );
        }
        if (metadata.runnerId !== runnerId) {
          return yield* new RunnerSessionDataError(
            `Session ${sessionId} belongs to a different runner.`,
          );
        }
        return projection;
      });

    const readLifecycleValue = (
      sessionId: SessionId,
    ): Effect.Effect<SessionLifecycleProjection, RunnerSessionDataError> =>
      lifecycleAccess.withPermit(readLifecycleValueUnlocked(sessionId));

    const readMetadataValue = (
      sessionId: SessionId,
    ): Effect.Effect<RunnerSessionMetadata, RunnerSessionDataError> =>
      readLifecycleValue(sessionId).pipe(Effect.map((projection) => projection.metadata));

    const appendLifecycleEventValue = (
      sessionId: SessionId,
      event: SessionLifecycleEvent,
    ): Effect.Effect<SessionLifecycleProjection, RunnerSessionDataError> =>
      lifecycleAccess.withPermit(Effect.gen(function* () {
        const current = yield* readLifecycleValueUnlocked(sessionId);
        const envelope: SessionLifecycleEventEnvelope = {
          version: 1,
          sequence: current.sequence + 1,
          event,
        };
        const next = yield* applyLifecycleEvent(current, envelope).pipe(
          Effect.mapError(sessionDataError),
        );
        yield* appendLifecycleEnvelope(join(sessionPath(sessionId), LIFECYCLE_FILE), envelope);
        return next;
      }));

    const inspectEntry = (entry: Deno.DirEntry): Effect.Effect<RunnerSessionManifest, never> => {
      if (!entry.isDirectory || entry.isSymlink) {
        return Effect.succeed({
          sessions: [],
          errors: [{
            sessionDirectory: entry.name,
            message: "Session storage entries must be real directories.",
          }],
        });
      }
      return Effect.gen(function* () {
        const metadataResult = yield* Effect.result(
          Schema.decodeUnknownEffect(SessionId)(entry.name).pipe(
            Effect.mapError(sessionDataError),
            Effect.flatMap(readMetadataValue),
          ),
        );
        if (metadataResult._tag === "Failure") {
          return {
            sessions: [],
            errors: [{
              sessionDirectory: entry.name,
              message: errorMessage(metadataResult.failure),
            }],
          } satisfies RunnerSessionManifest;
        }
        const metadata = metadataResult.success;
        const historyResult = yield* Effect.result(
          asyncBoundary(() => readPiSessionEvents(join(sessionPath(metadata.id), PI_SESSION_FILE))),
        );
        return historyResult._tag === "Failure"
          ? {
            sessions: [snapshotFrom(metadata, 0, "error")],
            errors: [{
              sessionDirectory: entry.name,
              message: errorMessage(historyResult.failure),
            }],
          }
          : { sessions: [snapshotFrom(metadata, historyResult.success.length)], errors: [] };
      });
    };

    const readGitSnapshotValue = (
      sessionId: SessionId,
    ): Effect.Effect<RunnerSessionGitSnapshotState, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const metadata = yield* readMetadataValue(sessionId);
        const snapshotsPath = join(sessionPath(metadata.id), "snapshots");
        yield* assertRealDirectory(snapshotsPath, "Runner session snapshots directory");
        return yield* readGitSnapshotFile(
          fs,
          join(sessionPath(metadata.id), GIT_SNAPSHOT_FILE),
        );
      });

    const store = RunnerSessionStore.of({
      ensureSession: Effect.fn("RunnerSessionStore.ensureSession")(
        function* (
          sessionId: SessionId,
          definition: RunnerSessionDefinition,
          requestedCreatedAt?: typeof RunnerSessionCreatedAt.Type,
        ) {
          const parsedDefinition = yield* Schema.decodeUnknownEffect(RunnerSessionDefinition)(
            definition,
            strictSchemaOptions,
          ).pipe(Effect.mapError(sessionDataError));
          const path = sessionPath(sessionId);
          const disposition = yield* createSessionDirectory(path).pipe(
            Effect.as("created" as const),
            Effect.catchTag(
              "RunnerSessionDirectoryAlreadyExists",
              () => Effect.succeed("existing" as const),
            ),
          );
          if (disposition === "existing") {
            const metadata = yield* readMetadataValue(sessionId);
            if (!runnerSessionDefinitionsEqual(metadata.definition, parsedDefinition)) {
              return yield* new RunnerSessionDefinitionConflict({
                sessionId,
                message: "A session with different immutable create fields already exists.",
              });
            }
            return { disposition, metadata };
          }
          return yield* Effect.gen(function* () {
            const createdAt = requestedCreatedAt ?? DateTime.formatIso(yield* DateTime.now);
            const created: SessionLifecycleEventEnvelope = {
              version: 1,
              sequence: 1,
              event: {
                type: "session.created",
                id: sessionId,
                definition: parsedDefinition,
                runnerId,
                createdAt,
              },
            };
            yield* Effect.forEach(
              ["workspace", "pi", "logs", "snapshots", CHECKPOINTS_DIRECTORY],
              (directory) => fileSystem(fs.makeDirectory(join(path, directory), { mode: 0o700 })),
              { discard: true },
            );
            yield* fileSystem(fs.makeDirectory(join(path, "pi", "agent"), { mode: 0o700 }));
            yield* writeNewPrivateFile(join(path, PI_SESSION_FILE), new Uint8Array());
            yield* writeNewLifecycleFile(join(path, LIFECYCLE_FILE), created);
            const metadata = (yield* projectSessionLifecycle([created]).pipe(
              Effect.mapError(sessionDataError),
            )).metadata;
            yield* syncDirectory(path);
            yield* syncDirectory(dirname(path));
            return { disposition, metadata };
          }).pipe(
            Effect.onError(() =>
              fileSystem(fs.remove(path, { recursive: true })).pipe(Effect.ignore)
            ),
          );
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("ensure-session", `Could not ensure runner session ${sessionId}`),
          )),
      ),

      readMetadata: Effect.fn("RunnerSessionStore.readMetadata")(
        function* (sessionId: SessionId) {
          return yield* readMetadataValue(sessionId);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("read-metadata", `Could not read runner session ${sessionId}`),
          )),
      ),

      updateSessionState: Effect.fn("RunnerSessionStore.updateSessionState")(
        function* (sessionId: SessionId, state: RunnerSessionState) {
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "session.state-changed",
            state,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("update-session-state", `Could not update runner session ${sessionId}`),
          )),
      ),

      updateProvisioning: Effect.fn("RunnerSessionStore.updateProvisioning")(
        function* (sessionId: SessionId, input: UpdateRunnerSessionProvisioningInput) {
          return (yield* appendLifecycleEventValue(
            sessionId,
            provisioningUpdated(input.state, input.checkoutState, input.baseCommit),
          )).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("update-provisioning", `Could not update runner session ${sessionId}`),
          )),
      ),

      getSessionWorkspacePath: Effect.fn("RunnerSessionStore.getSessionWorkspacePath")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const path = join(sessionPath(metadata.id), "workspace");
          yield* assertRealDirectory(path, "Runner session workspace");
          return yield* fileSystem(fs.realPath(path));
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(storeError(
            "get-workspace-path",
            `Could not access runner session ${sessionId} workspace`,
          ))),
      ),

      getSessionPiPaths: Effect.fn("RunnerSessionStore.getSessionPiPaths")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const piDirectory = join(sessionPath(metadata.id), "pi");
          const agentDirectory = join(piDirectory, "agent");
          const sessionFile = join(sessionPath(metadata.id), PI_SESSION_FILE);
          yield* assertRealDirectory(piDirectory, "Runner session Pi directory");
          yield* assertRealDirectory(agentDirectory, "Runner session Pi agent directory");
          yield* assertRegularFile(sessionFile, "Runner session Pi session file");
          return {
            agentDirectory: yield* fileSystem(fs.realPath(agentDirectory)),
            sessionFile: yield* fileSystem(fs.realPath(sessionFile)),
          };
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("get-pi-paths", `Could not access runner session ${sessionId} Pi storage`),
          )),
      ),

      startRun: Effect.fn("RunnerSessionStore.startRun")(
        function* (
          sessionId: SessionId,
          runId: RunId,
          requestedAcceptedAt?: typeof RunnerSessionCreatedAt.Type,
        ) {
          const acceptedAt = requestedAcceptedAt ?? DateTime.formatIso(yield* DateTime.now);
          const projection = yield* appendLifecycleEventValue(sessionId, {
            type: "run.started",
            runId,
            acceptedAt,
          });
          return { metadata: projection.metadata, startedBy: projection.sequence };
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "start-run",
              `Could not start a run for runner session ${sessionId}`,
            ),
          )),
      ),

      acceptFollowUp: Effect.fn("RunnerSessionStore.acceptFollowUp")(
        function* (
          sessionId: SessionId,
          runId: RunId,
          requestedAcceptedAt?: typeof RunnerSessionCreatedAt.Type,
        ) {
          const acceptedAt = requestedAcceptedAt ?? DateTime.formatIso(yield* DateTime.now);
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "follow-up.accepted",
            runId,
            acceptedAt,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "accept-follow-up",
              `Could not accept a follow-up for runner session ${sessionId}`,
            ),
          )),
      ),

      settleRun: Effect.fn("RunnerSessionStore.settleRun")(
        function* (sessionId: SessionId, runId: RunId, startedBy: number) {
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "run.settled",
            runId,
            startedBy,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("settle-run", `Could not settle a run for runner session ${sessionId}`),
          )),
      ),

      beginResume: Effect.fn("RunnerSessionStore.beginResume")(
        function* (sessionId: SessionId) {
          const projection = yield* appendLifecycleEventValue(sessionId, {
            type: "resume.started",
          });
          return { metadata: projection.metadata, startedBy: projection.sequence };
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("begin-resume", `Could not begin runner session ${sessionId} resume`),
          )),
      ),

      completeResume: Effect.fn("RunnerSessionStore.completeResume")(
        function* (sessionId: SessionId, startedBy: number) {
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "resume.completed",
            startedBy,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("complete-resume", `Could not complete runner session ${sessionId} resume`),
          )),
      ),

      failResume: Effect.fn("RunnerSessionStore.failResume")(
        function* (sessionId: SessionId, startedBy: number) {
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "resume.failed",
            startedBy,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("fail-resume", `Could not fail runner session ${sessionId} resume`),
          )),
      ),

      beginCheckpoint: Effect.fn("RunnerSessionStore.beginCheckpoint")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          if (metadata.state !== "ready" || metadata.checkpointCandidate !== undefined) {
            return yield* new RunnerSessionDataError(
              `Session ${sessionId} cannot begin a checkpoint in its current state.`,
            );
          }
          const directory = checkpointsPath(sessionId);
          yield* ensurePrivateDirectory(fs, directory);
          const file = `checkpoint-${crypto.randomUUID()}.qcow2`;
          const projection = yield* appendLifecycleEventValue(sessionId, {
            type: "checkpoint.started",
            file,
          });
          return { file, path: join(directory, file), startedBy: projection.sequence };
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "begin-checkpoint",
              `Could not begin runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      publishCheckpoint: Effect.fn("RunnerSessionStore.publishCheckpoint")(
        function* (
          sessionId: SessionId,
          candidate: RunnerSessionCheckpointCandidate,
          checkpoint: AgentEnvironmentCheckpoint,
        ) {
          const metadata = yield* readMetadataValue(sessionId);
          if (
            metadata.checkpointCandidate?.file !== candidate.file ||
            candidate.path !== join(checkpointsPath(sessionId), candidate.file) ||
            checkpoint.path !== candidate.path
          ) {
            return yield* new RunnerSessionDataError(
              `Session ${sessionId} checkpoint candidate does not match runner metadata.`,
            );
          }
          yield* assertRegularFile(candidate.path, "Runner session checkpoint candidate");
          const updated = (yield* appendLifecycleEventValue(sessionId, {
            type: "checkpoint.published",
            startedBy: candidate.startedBy,
            checkpoint: {
              file: candidate.file,
              guestAssetBuildId: checkpoint.guestAssetBuildId,
              ...(checkpoint.createdWithVmm === undefined
                ? {}
                : { createdWithVmm: checkpoint.createdWithVmm }),
              compatibleVmm: checkpoint.compatibleVmm,
            },
          })).metadata;
          yield* cleanupCheckpointDirectory(checkpointsPath(sessionId), candidate.file).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                `Obsolete checkpoints for session ${sessionId} could not be removed: ${
                  errorMessage(cause)
                }`,
              )
            ),
          );
          return updated;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "publish-checkpoint",
              `Could not publish runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      failCheckpoint: Effect.fn("RunnerSessionStore.failCheckpoint")(
        function* (
          sessionId: SessionId,
          candidate: RunnerSessionCheckpointCandidate,
          consumed: boolean,
        ) {
          const metadata = yield* readMetadataValue(sessionId);
          if (
            metadata.checkpointCandidate?.file !== candidate.file ||
            candidate.path !== join(checkpointsPath(sessionId), candidate.file)
          ) {
            return yield* new RunnerSessionDataError(
              `Session ${sessionId} checkpoint failure does not match runner metadata.`,
            );
          }
          yield* asyncBoundary(() => Deno.remove(candidate.path)).pipe(Effect.ignore);
          return (yield* appendLifecycleEventValue(sessionId, {
            type: "checkpoint.failed",
            startedBy: candidate.startedBy,
            consumed,
          })).metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "fail-checkpoint",
              `Could not clean up failed runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      readCurrentCheckpoint: Effect.fn("RunnerSessionStore.readCurrentCheckpoint")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          if (!metadata.checkpoint) {
            return yield* new RunnerSessionDataError(
              `Session ${sessionId} has no published checkpoint.`,
            );
          }
          const path = join(checkpointsPath(sessionId), metadata.checkpoint.file);
          yield* assertRegularFile(path, "Runner session current checkpoint");
          return checkpointFromMetadata(path, metadata.checkpoint);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("read-checkpoint", `Could not read runner session ${sessionId} checkpoint`),
          )),
      ),

      reconcileCheckpoints: Effect.fn("RunnerSessionStore.reconcileCheckpoints")(
        function* (sessionId: SessionId) {
          let projection = yield* readLifecycleValue(sessionId);
          let metadata = projection.metadata;
          const directory = checkpointsPath(sessionId);
          yield* ensurePrivateDirectory(fs, directory);
          if (projection.activeRun !== undefined) {
            projection = yield* appendLifecycleEventValue(sessionId, {
              type: "run.interrupted",
              runId: projection.activeRun.runId,
              startedBy: projection.activeRun.startedBy,
            });
            metadata = projection.metadata;
          }
          if (projection.resumeStartedBy !== undefined) {
            projection = yield* appendLifecycleEventValue(sessionId, {
              type: "resume.failed",
              startedBy: projection.resumeStartedBy,
            });
            metadata = projection.metadata;
          }
          if (metadata.checkpointCandidate) {
            yield* asyncBoundary(() =>
              Deno.remove(join(directory, metadata.checkpointCandidate!.file))
            ).pipe(Effect.ignore);
            if (projection.checkpointStartedBy === undefined) {
              return yield* new RunnerSessionDataError(
                `Session ${sessionId} has an uncorrelated checkpoint candidate.`,
              );
            }
            projection = yield* appendLifecycleEventValue(sessionId, {
              type: "checkpoint.interrupted",
              startedBy: projection.checkpointStartedBy,
            });
            metadata = projection.metadata;
          }
          if (metadata.checkpoint) {
            const currentPath = join(directory, metadata.checkpoint.file);
            const current = yield* Effect.result(assertRegularFile(
              currentPath,
              "Runner session current checkpoint",
            ));
            if (current._tag === "Failure") {
              metadata = (yield* appendLifecycleEventValue(sessionId, {
                type: "checkpoint.invalidated",
                file: metadata.checkpoint.file,
              })).metadata;
            }
          } else if (metadata.state === "stopped") {
            metadata = (yield* appendLifecycleEventValue(sessionId, {
              type: "session.state-changed",
              state: "error",
            })).metadata;
          }
          yield* cleanupCheckpointDirectory(directory, metadata.checkpoint?.file);
          return metadata;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "reconcile-checkpoints",
              `Could not reconcile runner session ${sessionId} checkpoints`,
            ),
          )),
      ),

      readGitSnapshot: Effect.fn("RunnerSessionStore.readGitSnapshot")(
        function* (sessionId: SessionId) {
          return (yield* readGitSnapshotValue(sessionId)).snapshot;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "read-git-snapshot",
              `Could not read runner session ${sessionId} Git Snapshot`,
            ),
          )),
      ),

      readGitSnapshotState: Effect.fn("RunnerSessionStore.readGitSnapshotState")(
        function* (sessionId: SessionId) {
          return yield* readGitSnapshotValue(sessionId);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "read-git-snapshot",
              `Could not read runner session ${sessionId} Git Snapshot`,
            ),
          )),
      ),

      writeGitSnapshotState: Effect.fn("RunnerSessionStore.writeGitSnapshotState")(
        function* (sessionId: SessionId, state: RunnerSessionGitSnapshotState) {
          const metadata = yield* readMetadataValue(sessionId);
          const snapshotsPath = join(sessionPath(metadata.id), "snapshots");
          yield* assertRealDirectory(snapshotsPath, "Runner session snapshots directory");
          const parsed = yield* Schema.decodeUnknownEffect(gitSnapshotStateSchema)(
            state,
            strictSchemaOptions,
          ).pipe(Effect.mapError(sessionDataError));
          yield* writeGitSnapshotFile(
            join(sessionPath(metadata.id), GIT_SNAPSHOT_FILE),
            parsed,
          );
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "write-git-snapshot",
              `Could not write runner session ${sessionId} Git Snapshot`,
            ),
          )),
      ),

      getSessionSnapshot: Effect.fn("RunnerSessionStore.getSessionSnapshot")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const history = yield* asyncBoundary(() =>
            readPiSessionEvents(join(sessionPath(metadata.id), PI_SESSION_FILE))
          );
          return snapshotFrom(metadata, history.length);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("get-session-snapshot", `Could not snapshot runner session ${sessionId}`),
          )),
      ),

      loadSessionManifest: Effect.fn("RunnerSessionStore.loadSessionManifest")(
        function* () {
          // FileSystem.readDirectory omits entry types; retain lstat-backed entries for symlink checks.
          const entries = yield* asyncBoundary(async () => {
            const values = [];
            for await (const entry of Deno.readDir(sessionsPath)) values.push(entry);
            return values.sort((left, right) => left.name.localeCompare(right.name));
          });
          const inspections = yield* Effect.forEach(entries, inspectEntry);
          return {
            sessions: inspections.flatMap((inspection) => inspection.sessions),
            errors: inspections.flatMap((inspection) => inspection.errors),
          };
        },
        (effect) =>
          effect.pipe(Effect.mapError(
            storeError("load-session-manifest", "Could not load the runner session manifest"),
          )),
      ),
    });
    return store;
  });
}

export function runnerSessionStoreLayer(
  config: RunnerSessionStoreConfig,
): Layer.Layer<RunnerSessionStore, RunnerSessionStoreError, FileSystem.FileSystem> {
  return Layer.effect(RunnerSessionStore, makeRunnerSessionStore(config));
}

function parseMetadata(
  input: unknown,
): Effect.Effect<RunnerSessionMetadata, RunnerSessionDataError> {
  return Schema.decodeUnknownEffect(metadataSchema)(input, strictSchemaOptions).pipe(
    Effect.mapError(sessionDataError),
  );
}

function asyncBoundary<A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, RunnerSessionDataError> {
  return Effect.tryPromise({ try: evaluate, catch: sessionDataError });
}

function createSessionDirectory(
  path: string,
): Effect.Effect<void, RunnerSessionDirectoryAlreadyExists | RunnerSessionDataError> {
  return Effect.tryPromise({
    try: () => Deno.mkdir(path, { mode: 0o700 }),
    catch: (cause) =>
      cause instanceof Deno.errors.AlreadyExists
        ? new RunnerSessionDirectoryAlreadyExists({ cause })
        : sessionDataError(cause),
  });
}

function snapshotFrom(
  metadata: RunnerSessionMetadata,
  lastEventCursor: number,
  state: RunnerSessionState = metadata.state,
): RunnerSessionSnapshot {
  return new RunnerSessionSnapshot({
    id: metadata.id,
    projectId: metadata.definition.projectId,
    createdAt: metadata.createdAt,
    initialPromptPreview: initialPromptPreview(metadata.definition.initialPrompt),
    model: metadata.definition.model,
    orbSize: metadata.definition.orbSize,
    state,
    lastEventCursor,
  });
}

function readMetadataFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<RunnerSessionMetadata, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* assertRegularFile(path, "Runner session metadata file");
    const contents = yield* fs.readFile(path).pipe(Effect.mapError(sessionDataError));
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
      catch: sessionDataError,
    });
    const decoded = yield* Schema.decodeUnknownEffect(MetadataJson)(text, strictSchemaOptions).pipe(
      Effect.mapError(sessionDataError),
    );
    return decoded.version === 2 ? yield* parseMetadata({ ...decoded, version: 3 }) : decoded;
  });
}

function pathExists(path: string): Effect.Effect<boolean, RunnerSessionDataError> {
  return asyncBoundary(() => Deno.lstat(path)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.cause instanceof Deno.errors.NotFound ? Effect.succeed(false) : Effect.fail(error)
    ),
  );
}

function readLifecycleFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<SessionLifecycleProjection, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* assertRegularFile(path, "Runner session lifecycle log");
    let contents = yield* fs.readFile(path).pipe(Effect.mapError(sessionDataError));
    if (contents.length > 0 && contents.at(-1) !== 0x0a) {
      const lastNewline = contents.lastIndexOf(0x0a);
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
      yield* truncateLifecycleFile(path, completeLength);
      contents = contents.subarray(0, completeLength);
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
      catch: sessionDataError,
    });
    const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
    const envelopes = yield* Effect.forEach(
      lines,
      (line, index) =>
        Schema.decodeUnknownEffect(LifecycleEventEnvelopeJson)(line, strictSchemaOptions).pipe(
          Effect.mapError((cause) =>
            new RunnerSessionDataError(
              `Runner session lifecycle event ${index + 1} is invalid: ${errorMessage(cause)}`,
              cause,
            )
          ),
        ),
    );
    return yield* projectSessionLifecycle(envelopes).pipe(Effect.mapError(sessionDataError));
  });
}

function writeNewLifecycleFile(
  path: string,
  envelope: SessionLifecycleEventEnvelope,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const contents = yield* encodeLifecycleEnvelope(envelope);
    yield* writeNewPrivateFile(path, contents);
  });
}

function appendLifecycleEnvelope(
  path: string,
  envelope: SessionLifecycleEventEnvelope,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* assertRegularFile(path, "Runner session lifecycle log");
    const contents = yield* encodeLifecycleEnvelope(envelope);
    yield* Effect.acquireUseRelease(
      asyncBoundary(() => Deno.open(path, { write: true, append: true })),
      (file) =>
        Effect.gen(function* () {
          yield* writeAll(file, contents);
          yield* asyncBoundary(() => file.sync());
        }),
      (file) => Effect.sync(() => file.close()),
    );
  });
}

function encodeLifecycleEnvelope(
  envelope: SessionLifecycleEventEnvelope,
): Effect.Effect<Uint8Array, RunnerSessionDataError> {
  return Schema.encodeEffect(SessionLifecycleEventEnvelopeSchema)(
    envelope,
    strictSchemaOptions,
  ).pipe(
    Effect.map((encoded) => new TextEncoder().encode(`${JSON.stringify(encoded)}\n`)),
    Effect.mapError(sessionDataError),
  );
}

function truncateLifecycleFile(
  path: string,
  length: number,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.acquireUseRelease(
    asyncBoundary(() => Deno.open(path, { write: true })),
    (file) =>
      asyncBoundary(async () => {
        await file.truncate(length);
        await file.sync();
      }),
    (file) => Effect.sync(() => file.close()),
  );
}

function checkpointFromMetadata(
  path: string,
  checkpoint: NonNullable<RunnerSessionMetadata["checkpoint"]>,
): AgentEnvironmentCheckpoint {
  return {
    path,
    guestAssetBuildId: checkpoint.guestAssetBuildId,
    ...(checkpoint.createdWithVmm === undefined
      ? {}
      : { createdWithVmm: checkpoint.createdWithVmm }),
    compatibleVmm: checkpoint.compatibleVmm,
  };
}

function cleanupCheckpointDirectory(
  directory: string,
  keepFile?: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* asyncBoundary(async () => {
      for await (const entry of Deno.readDir(directory)) {
        if (entry.name === keepFile) continue;
        await Deno.remove(join(directory, entry.name), { recursive: entry.isDirectory });
      }
    });
    yield* syncDirectory(directory);
  });
}

function readGitSnapshotFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<RunnerSessionGitSnapshotState, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* assertRegularFile(path, "Runner session Git Snapshot file");
    const contents = yield* fs.readFile(path).pipe(Effect.mapError(sessionDataError));
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
      catch: sessionDataError,
    });
    return yield* Schema.decodeUnknownEffect(GitSnapshotStateJson)(text, strictSchemaOptions).pipe(
      Effect.mapError(sessionDataError),
    );
  });
}

function writeGitSnapshotFile(
  path: string,
  value: RunnerSessionGitSnapshotState,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(gitSnapshotStateSchema)(
      value,
      strictSchemaOptions,
    ).pipe(Effect.mapError(sessionDataError));
    yield* writeAtomicMetadata(path, `${JSON.stringify(encoded, null, 2)}\n`);
  });
}

function writeAtomicMetadata(
  path: string,
  contents: string,
): Effect.Effect<void, RunnerSessionDataError> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  return Effect.gen(function* () {
    yield* writeNewPrivateFile(temporaryPath, new TextEncoder().encode(contents));
    yield* asyncBoundary(() => Deno.rename(temporaryPath, path));
    yield* syncDirectory(dirname(path));
  }).pipe(
    Effect.ensuring(
      asyncBoundary(() => Deno.remove(temporaryPath)).pipe(Effect.ignore),
    ),
  );
}

function writeNewPrivateFile(
  path: string,
  contents: Uint8Array,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.acquireUseRelease(
    asyncBoundary(() =>
      Deno.open(path, {
        write: true,
        createNew: true,
        mode: 0o600,
      })
    ),
    (file) =>
      Effect.gen(function* () {
        yield* writeAll(file, contents);
        yield* asyncBoundary(() => file.sync());
        if (Deno.build.os !== "windows") {
          yield* asyncBoundary(() => Deno.chmod(path, 0o600));
        }
      }),
    (file) =>
      Effect.sync(() => {
        file.close();
      }),
  );
}

function ensurePrivateDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(path, { mode: 0o700, recursive: true }).pipe(
      Effect.mapError(sessionDataError),
    );
    yield* assertRealDirectory(path, "Runner sessions directory");
    if (Deno.build.os !== "windows") {
      yield* fs.chmod(path, 0o700).pipe(Effect.mapError(sessionDataError));
    }
  });
}

function assertRealDirectory(
  path: string,
  label: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const info = yield* asyncBoundary(() => Deno.lstat(path));
    if (!info.isDirectory || info.isSymlink) {
      return yield* new RunnerSessionDataError(`${label} must be a real directory.`);
    }
  });
}

function assertRegularFile(
  path: string,
  label: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const info = yield* asyncBoundary(() => Deno.lstat(path));
    if (!info.isFile || info.isSymlink) {
      return yield* new RunnerSessionDataError(`${label} must be a regular file.`);
    }
  });
}

function writeAll(
  file: Deno.FsFile,
  contents: Uint8Array,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    let offset = 0;
    while (offset < contents.length) {
      offset += yield* asyncBoundary(() => file.write(contents.subarray(offset)));
    }
  });
}

function syncDirectory(path: string): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.acquireUseRelease(
    asyncBoundary(() => Deno.open(path, { read: true })),
    (directory) => asyncBoundary(() => directory.sync()),
    (directory) =>
      Effect.sync(() => {
        directory.close();
      }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RunnerSessionDataError extends Data.TaggedError("RunnerSessionDataError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super(cause === undefined ? { message } : { message, cause });
  }
}

class RunnerSessionDirectoryAlreadyExists extends Data.TaggedError(
  "RunnerSessionDirectoryAlreadyExists",
)<{
  readonly cause: unknown;
}> {}

function sessionDataError(cause: unknown): RunnerSessionDataError {
  return cause instanceof RunnerSessionDataError
    ? cause
    : new RunnerSessionDataError(errorMessage(cause), cause);
}

function storeError(
  operation: RunnerSessionStoreOperation,
  context: string,
): (cause: unknown) => RunnerSessionStoreError {
  return (cause) =>
    cause instanceof RunnerSessionDefinitionConflict ? cause : new RunnerSessionStoreFailure({
      operation,
      message: `${context}: ${errorMessage(cause)}`,
      cause,
    });
}
