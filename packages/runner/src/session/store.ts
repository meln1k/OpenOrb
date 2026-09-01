import {
  initialPromptPreview,
  RunnerId,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  SessionGitSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

import type { AgentEnvironmentCheckpoint } from "../environment/agent-environment.ts";
import { readPiSessionEvents } from "../harness/pi/history.ts";
import { CHECKPOINT_FILE_PATTERN } from "./actor/events.ts";
import { Journal } from "./persistent-actor/journal.ts";
import { recoverSessionState, type RunnerSessionMetadata, sessionMetadata } from "./actor/state.ts";

export type { RunnerSessionMetadata } from "./actor/state.ts";

const SESSIONS_DIRECTORY = "sessions";
const SESSION_DELETIONS_DIRECTORY = "session-deletions";
const CHECKPOINTS_DIRECTORY = "checkpoints";

const gitSnapshotStateSchema = Schema.Struct({
  snapshot: SessionGitSnapshot,
  notificationPending: Schema.Boolean,
});
const GitSnapshotStateJson = Schema.fromJsonString(gitSnapshotStateSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

export type RunnerSessionGitSnapshotState = typeof gitSnapshotStateSchema.Type;

export type SessionStorageDisposition = "created" | "existing";

export interface RunnerSessionPiPaths {
  agentDirectory: string;
  sessionFile: string;
}

export interface RunnerSessionCheckpointFile {
  readonly file: string;
  readonly path: string;
}

export type RunnerSessionCheckpointCandidate = RunnerSessionCheckpointFile;

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
  | "ensure-session-storage"
  | "remove-session-storage"
  | "read-metadata"
  | "clear-workspace"
  | "get-workspace-path"
  | "get-pi-paths"
  | "allocate-checkpoint"
  | "validate-checkpoint"
  | "discard-checkpoint"
  | "cleanup-checkpoints"
  | "inspect-checkpoint"
  | "read-checkpoint"
  | "read-git-snapshot"
  | "write-git-snapshot"
  | "get-session-snapshot"
  | "load-session-manifest";

export class RunnerSessionStoreFailure extends Data.TaggedError("RunnerSessionStoreFailure")<{
  readonly operation: RunnerSessionStoreOperation;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type RunnerSessionStoreError = RunnerSessionStoreFailure;

export interface RunnerSessionStore {
  readonly ensureSessionStorage: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionStorageDisposition, RunnerSessionStoreError>;
  readonly removeSessionStorage: (
    sessionId: SessionId,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly readMetadata: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
  readonly clearSessionWorkspace: (
    sessionId: SessionId,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly getSessionWorkspacePath: (
    sessionId: SessionId,
  ) => Effect.Effect<string, RunnerSessionStoreError>;
  readonly getSessionPiPaths: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionPiPaths, RunnerSessionStoreError>;
  readonly allocateCheckpoint: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionCheckpointFile, RunnerSessionStoreError>;
  readonly validateCheckpoint: (
    sessionId: SessionId,
    candidate: RunnerSessionCheckpointCandidate,
    checkpoint: AgentEnvironmentCheckpoint,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly discardCheckpoint: (
    sessionId: SessionId,
    file: string,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly cleanupCheckpoints: (
    sessionId: SessionId,
    keepFile?: string,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly checkpointExists: (
    sessionId: SessionId,
    file: string,
  ) => Effect.Effect<boolean, RunnerSessionStoreError>;
  readonly readCurrentCheckpoint: (
    sessionId: SessionId,
  ) => Effect.Effect<AgentEnvironmentCheckpoint, RunnerSessionStoreError>;
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
): Effect.Effect<
  RunnerSessionStore,
  RunnerSessionStoreError,
  FileSystem.FileSystem | Journal | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const journal = yield* Journal;
    const paths = yield* Path.Path;
    const runnerId = yield* Schema.decodeUnknownEffect(RunnerId)(config.runnerId).pipe(
      Effect.mapError(storeError("initialize", "The runner ID is invalid")),
    );
    const piSessionFile = paths.join("pi", "session.jsonl");
    const gitSnapshotFile = paths.join("snapshots", "git-snapshot.json");
    const sessionsPath = paths.join(config.workingDirectory, SESSIONS_DIRECTORY);
    const sessionDeletionsPath = paths.join(
      config.workingDirectory,
      SESSION_DELETIONS_DIRECTORY,
    );
    const sessionPath = (sessionId: SessionId) => paths.join(sessionsPath, sessionId);
    const sessionDeletionPath = (sessionId: SessionId) =>
      paths.join(sessionDeletionsPath, sessionId);
    const checkpointsPath = (sessionId: SessionId) =>
      paths.join(sessionPath(sessionId), CHECKPOINTS_DIRECTORY);
    const fileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(sessionDataError));
    yield* Effect.forEach(
      [sessionsPath, sessionDeletionsPath],
      (path) => ensurePrivateDirectory(fs, path),
      { discard: true },
    ).pipe(
      Effect.mapError(storeError("initialize", "Could not initialize runner session storage")),
    );
    yield* syncDirectory(fs, config.workingDirectory).pipe(
      Effect.mapError(storeError("initialize", "Could not sync runner session storage")),
    );

    const removeQueuedSessionStorage = Effect.fn(
      "RunnerSessionStore.removeQueuedSessionStorage",
    )(function* (sessionId: SessionId) {
      const path = sessionDeletionPath(sessionId);
      const exists = yield* fs.exists(path).pipe(Effect.mapError(sessionDataError));
      if (!exists) return;
      yield* fileSystem(fs.remove(path, { recursive: true, force: true }));
      yield* syncDirectory(fs, sessionDeletionsPath);
    });

    yield* Effect.gen(function* () {
      const entries = yield* fs.readDirectory(sessionDeletionsPath).pipe(
        Effect.mapError(sessionDataError),
      );
      yield* Effect.forEach(
        entries,
        (entry) =>
          Schema.decodeUnknownEffect(SessionId)(entry).pipe(
            Effect.mapError(sessionDataError),
            Effect.flatMap(removeQueuedSessionStorage),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.mapError(
        storeError("initialize", "Could not recover pending runner session deletions"),
      ),
    );

    const readMetadataValue = (
      sessionId: SessionId,
    ): Effect.Effect<RunnerSessionMetadata, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const path = sessionPath(sessionId);
        yield* assertDirectory(fs, path, "Runner session directory");
        const state = yield* recoverSessionState(sessionId).pipe(
          Effect.provideService(Journal, journal),
          Effect.mapError(sessionDataError),
        );
        const metadata = sessionMetadata(state);
        if (metadata.id !== sessionId) {
          return yield* new RunnerSessionDataError(
            `Session directory ${sessionId} contains events for ${metadata.id}.`,
          );
        }
        if (metadata.runnerId !== runnerId) {
          return yield* new RunnerSessionDataError(
            `Session ${sessionId} belongs to a different runner.`,
          );
        }
        return metadata;
      });

    const allocateCheckpointValue = (
      sessionId: SessionId,
    ): Effect.Effect<RunnerSessionCheckpointFile, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const directory = checkpointsPath(sessionId);
        yield* ensurePrivateDirectory(fs, directory);
        const file = `checkpoint-${crypto.randomUUID()}.qcow2`;
        return { file, path: paths.join(directory, file) };
      });

    const validateCheckpointValue = (
      sessionId: SessionId,
      candidate: RunnerSessionCheckpointCandidate,
      checkpoint: AgentEnvironmentCheckpoint,
    ): Effect.Effect<void, RunnerSessionDataError> =>
      Effect.gen(function* () {
        if (
          !CHECKPOINT_FILE_PATTERN.test(candidate.file) ||
          candidate.path !== paths.join(checkpointsPath(sessionId), candidate.file) ||
          checkpoint.path !== candidate.path
        ) {
          return yield* new RunnerSessionDataError(
            `Session ${sessionId} checkpoint candidate path is invalid.`,
          );
        }
        yield* assertRegularFile(fs, candidate.path, "Runner session checkpoint candidate");
      });

    const discardCheckpointValue = (
      sessionId: SessionId,
      file: string,
    ): Effect.Effect<void, RunnerSessionDataError> =>
      Effect.gen(function* () {
        if (!CHECKPOINT_FILE_PATTERN.test(file)) {
          return yield* new RunnerSessionDataError(
            `Session ${sessionId} checkpoint file name is invalid.`,
          );
        }
        yield* fs.remove(paths.join(checkpointsPath(sessionId), file), { force: true }).pipe(
          Effect.mapError(sessionDataError),
        );
      });

    const inspectEntry = (entry: string): Effect.Effect<RunnerSessionManifest, never> => {
      return Effect.gen(function* () {
        const metadataResult = yield* Effect.result(
          Schema.decodeUnknownEffect(SessionId)(entry).pipe(
            Effect.mapError(sessionDataError),
            Effect.flatMap(readMetadataValue),
          ),
        );
        if (metadataResult._tag === "Failure") {
          return {
            sessions: [],
            errors: [{
              sessionDirectory: entry,
              message: errorMessage(metadataResult.failure),
            }],
          } satisfies RunnerSessionManifest;
        }
        const metadata = metadataResult.success;
        const historyResult = yield* Effect.result(
          asyncBoundary(() =>
            readPiSessionEvents(paths.join(sessionPath(metadata.id), piSessionFile))
          ),
        );
        return historyResult._tag === "Failure"
          ? {
            sessions: [snapshotFrom(metadata, 0, "error")],
            errors: [{
              sessionDirectory: entry,
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
        const snapshotsPath = paths.join(sessionPath(metadata.id), "snapshots");
        yield* assertDirectory(fs, snapshotsPath, "Runner session snapshots directory");
        return yield* readGitSnapshotFile(
          fs,
          paths.join(sessionPath(metadata.id), gitSnapshotFile),
        );
      });

    const store = RunnerSessionStore.of({
      ensureSessionStorage: Effect.fn("RunnerSessionStore.ensureSessionStorage")(
        function* (sessionId: SessionId) {
          const path = sessionPath(sessionId);
          const disposition = yield* createSessionDirectory(fs, path).pipe(
            Effect.as("created" as const),
            Effect.catchTag(
              "RunnerSessionDirectoryAlreadyExists",
              () => Effect.succeed("existing" as const),
            ),
          );
          if (disposition === "existing") return disposition;
          return yield* Effect.gen(function* () {
            yield* Effect.forEach(
              ["workspace", "pi", "logs", "snapshots", CHECKPOINTS_DIRECTORY],
              (directory) =>
                fileSystem(fs.makeDirectory(paths.join(path, directory), { mode: 0o700 })),
              { discard: true },
            );
            yield* fileSystem(
              fs.makeDirectory(paths.join(path, "pi", "agent"), { mode: 0o700 }),
            );
            yield* writeNewPrivateFile(fs, paths.join(path, piSessionFile), new Uint8Array());
            yield* syncDirectory(fs, path);
            yield* syncDirectory(fs, paths.dirname(path));
            return disposition;
          }).pipe(
            Effect.onError(() =>
              fileSystem(fs.remove(path, { recursive: true })).pipe(Effect.ignore)
            ),
          );
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "ensure-session-storage",
              `Could not ensure runner session ${sessionId} storage`,
            ),
          )),
      ),

      removeSessionStorage: Effect.fn("RunnerSessionStore.removeSessionStorage")(
        function* (sessionId: SessionId) {
          const path = sessionPath(sessionId);
          const queuedPath = sessionDeletionPath(sessionId);
          const queued = yield* fs.exists(queuedPath).pipe(Effect.mapError(sessionDataError));
          if (!queued) {
            const exists = yield* fs.exists(path).pipe(Effect.mapError(sessionDataError));
            if (!exists) return;
            yield* fs.rename(path, queuedPath).pipe(Effect.mapError(sessionDataError));
            yield* syncDirectory(fs, sessionDeletionsPath);
            yield* syncDirectory(fs, sessionsPath);
          }
          yield* removeQueuedSessionStorage(sessionId);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "remove-session-storage",
              `Could not remove runner session ${sessionId} storage`,
            ),
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

      clearSessionWorkspace: Effect.fn("RunnerSessionStore.clearSessionWorkspace")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const workspacePath = paths.join(sessionPath(metadata.id), "workspace");
          yield* assertDirectory(fs, workspacePath, "Runner session workspace");
          const entries = yield* fs.readDirectory(workspacePath).pipe(
            Effect.mapError(sessionDataError),
          );
          yield* Effect.forEach(
            entries,
            (entry) =>
              fs.remove(paths.join(workspacePath, entry), { recursive: true }).pipe(
                Effect.mapError(sessionDataError),
              ),
            { discard: true },
          );
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "clear-workspace",
              `Could not clear runner session ${sessionId} workspace`,
            ),
          )),
      ),

      getSessionWorkspacePath: Effect.fn("RunnerSessionStore.getSessionWorkspacePath")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const path = paths.join(sessionPath(metadata.id), "workspace");
          yield* assertDirectory(fs, path, "Runner session workspace");
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
          const piDirectory = paths.join(sessionPath(metadata.id), "pi");
          const agentDirectory = paths.join(piDirectory, "agent");
          const sessionFile = paths.join(sessionPath(metadata.id), piSessionFile);
          yield* assertDirectory(fs, piDirectory, "Runner session Pi directory");
          yield* assertDirectory(fs, agentDirectory, "Runner session Pi agent directory");
          yield* assertRegularFile(fs, sessionFile, "Runner session Pi session file");
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

      allocateCheckpoint: Effect.fn("RunnerSessionStore.allocateCheckpoint")(
        function* (sessionId: SessionId) {
          return yield* allocateCheckpointValue(sessionId);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "allocate-checkpoint",
              `Could not allocate runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      validateCheckpoint: Effect.fn("RunnerSessionStore.validateCheckpoint")(
        function* (
          sessionId: SessionId,
          candidate: RunnerSessionCheckpointCandidate,
          checkpoint: AgentEnvironmentCheckpoint,
        ) {
          yield* validateCheckpointValue(sessionId, candidate, checkpoint);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "validate-checkpoint",
              `Could not validate runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      discardCheckpoint: Effect.fn("RunnerSessionStore.discardCheckpoint")(
        function* (sessionId: SessionId, file: string) {
          yield* discardCheckpointValue(sessionId, file);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "discard-checkpoint",
              `Could not discard runner session ${sessionId} checkpoint`,
            ),
          )),
      ),

      cleanupCheckpoints: Effect.fn("RunnerSessionStore.cleanupCheckpoints")(
        function* (sessionId: SessionId, keepFile?: string) {
          yield* cleanupDirectory(fs, paths, checkpointsPath(sessionId), keepFile);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "cleanup-checkpoints",
              `Could not clean up runner session ${sessionId} checkpoints`,
            ),
          )),
      ),

      checkpointExists: Effect.fn("RunnerSessionStore.checkpointExists")(
        function* (sessionId: SessionId, file: string) {
          if (!CHECKPOINT_FILE_PATTERN.test(file)) {
            return yield* new RunnerSessionDataError(
              `Session ${sessionId} checkpoint file name is invalid.`,
            );
          }
          return yield* regularFileExists(fs, paths.join(checkpointsPath(sessionId), file));
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "inspect-checkpoint",
              `Could not inspect runner session ${sessionId} checkpoint`,
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
          const path = paths.join(checkpointsPath(sessionId), metadata.checkpoint.file);
          yield* assertRegularFile(fs, path, "Runner session current checkpoint");
          return checkpointFromMetadata(path, metadata.checkpoint);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("read-checkpoint", `Could not read runner session ${sessionId} checkpoint`),
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
          const snapshotsPath = paths.join(sessionPath(metadata.id), "snapshots");
          yield* assertDirectory(fs, snapshotsPath, "Runner session snapshots directory");
          const parsed = yield* Schema.decodeUnknownEffect(gitSnapshotStateSchema)(
            state,
            strictSchemaOptions,
          ).pipe(Effect.mapError(sessionDataError));
          yield* writeGitSnapshotFile(
            fs,
            paths,
            paths.join(sessionPath(metadata.id), gitSnapshotFile),
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
            readPiSessionEvents(paths.join(sessionPath(metadata.id), piSessionFile))
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
          const entries = yield* fs.readDirectory(sessionsPath).pipe(
            Effect.map((entries) => entries.sort((left, right) => left.localeCompare(right))),
            Effect.mapError(sessionDataError),
          );
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
): Layer.Layer<
  RunnerSessionStore,
  RunnerSessionStoreError,
  FileSystem.FileSystem | Journal | Path.Path
> {
  return Layer.effect(RunnerSessionStore, makeRunnerSessionStore(config));
}

function asyncBoundary<A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, RunnerSessionDataError> {
  return Effect.tryPromise({ try: evaluate, catch: sessionDataError });
}

function createSessionDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, RunnerSessionDirectoryAlreadyExists | RunnerSessionDataError> {
  return fs.makeDirectory(path, { mode: 0o700 }).pipe(
    Effect.mapError((cause) =>
      cause.reason._tag === "AlreadyExists"
        ? new RunnerSessionDirectoryAlreadyExists({ cause })
        : sessionDataError(cause)
    ),
  );
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

function cleanupDirectory(
  fs: FileSystem.FileSystem,
  paths: Path.Path,
  directory: string,
  keepFile?: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(sessionDataError));
    yield* Effect.forEach(
      entries,
      (entry) =>
        entry === keepFile
          ? Effect.void
          : fs.remove(paths.join(directory, entry), { recursive: true }).pipe(
            Effect.mapError(sessionDataError),
          ),
      { discard: true },
    );
    yield* syncDirectory(fs, directory);
  });
}

function readGitSnapshotFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<RunnerSessionGitSnapshotState, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* assertRegularFile(fs, path, "Runner session Git Snapshot file");
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
  fs: FileSystem.FileSystem,
  paths: Path.Path,
  path: string,
  value: RunnerSessionGitSnapshotState,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(gitSnapshotStateSchema)(
      value,
      strictSchemaOptions,
    ).pipe(Effect.mapError(sessionDataError));
    yield* writeAtomicMetadata(fs, paths, path, `${JSON.stringify(encoded, null, 2)}\n`);
  });
}

function writeAtomicMetadata(
  fs: FileSystem.FileSystem,
  paths: Path.Path,
  path: string,
  contents: string,
): Effect.Effect<void, RunnerSessionDataError> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  return Effect.gen(function* () {
    yield* writeNewPrivateFile(fs, temporaryPath, new TextEncoder().encode(contents));
    yield* fs.rename(temporaryPath, path).pipe(Effect.mapError(sessionDataError));
    yield* syncDirectory(fs, paths.dirname(path));
  }).pipe(
    Effect.ensuring(
      fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
    ),
  );
}

function writeNewPrivateFile(
  fs: FileSystem.FileSystem,
  path: string,
  contents: Uint8Array,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(path, { flag: "wx", mode: 0o600 }).pipe(
      Effect.mapError(sessionDataError),
    );
    yield* file.writeAll(contents).pipe(Effect.mapError(sessionDataError));
    yield* file.sync.pipe(Effect.mapError(sessionDataError));
  }));
}

function ensurePrivateDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(path, { mode: 0o700, recursive: true }).pipe(
      Effect.mapError(sessionDataError),
    );
    yield* assertDirectory(fs, path, "Runner sessions directory");
    yield* fs.chmod(path, 0o700).pipe(Effect.mapError(sessionDataError));
  });
}

function assertDirectory(
  fs: FileSystem.FileSystem,
  path: string,
  label: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(path).pipe(Effect.mapError(sessionDataError));
    if (info.type !== "Directory") {
      return yield* new RunnerSessionDataError(`${label} must be a directory.`);
    }
  });
}

function assertRegularFile(
  fs: FileSystem.FileSystem,
  path: string,
  label: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(path).pipe(Effect.mapError(sessionDataError));
    if (info.type !== "File") {
      return yield* new RunnerSessionDataError(`${label} must be a regular file.`);
    }
  });
}

function regularFileExists(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, RunnerSessionDataError> {
  return fs.stat(path).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(sessionDataError(error)),
      onSuccess: (info) =>
        info.type === "File"
          ? Effect.succeed(true)
          : Effect.fail(new RunnerSessionDataError("Checkpoint must be a regular file.")),
    }),
  );
}

function syncDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.scoped(Effect.gen(function* () {
    const directory = yield* fs.open(path, { flag: "r" }).pipe(
      Effect.mapError(sessionDataError),
    );
    yield* directory.sync.pipe(Effect.mapError(sessionDataError));
  }));
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
    new RunnerSessionStoreFailure({
      operation,
      message: `${context}: ${errorMessage(cause)}`,
      cause,
    });
}
