import {
  initialPromptPreview,
  type RunnerCheckoutState,
  RunnerCheckoutState as RunnerCheckoutStateSchema,
  RunnerId,
  RunnerSessionCreatedAt,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  RunnerSessionState as RunnerSessionStateSchema,
  SessionGitHead,
  SessionGitSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Data, DateTime, Effect, FileSystem, Layer, Schema } from "effect";
import { dirname, join } from "node:path";

import { readPiSessionEvents } from "../harness/pi/history.ts";
import { RunnerSessionDefinition, runnerSessionDefinitionsEqual } from "./definition.ts";

const SESSIONS_DIRECTORY = "sessions";
const METADATA_FILE = "metadata.json";
const PI_SESSION_FILE = join("pi", "session.jsonl");
const GIT_SNAPSHOT_FILE = join("snapshots", "git-snapshot.json");

const metadataSchema = Schema.Struct({
  version: Schema.Literal(2),
  id: SessionId,
  definition: RunnerSessionDefinition,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
  state: RunnerSessionStateSchema,
  checkoutState: RunnerCheckoutStateSchema,
  baseCommit: Schema.optionalKey(SessionGitHead),
});
const gitSnapshotStateSchema = Schema.Struct({
  snapshot: SessionGitSnapshot,
  notificationPending: Schema.Boolean,
});
const MetadataJson = Schema.fromJsonString(metadataSchema);
const GitSnapshotStateJson = Schema.fromJsonString(gitSnapshotStateSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

export type RunnerSessionMetadata = typeof metadataSchema.Type;
export type RunnerSessionGitSnapshotState = typeof gitSnapshotStateSchema.Type;

export interface EnsureRunnerSessionResult {
  readonly disposition: "created" | "existing";
  readonly metadata: RunnerSessionMetadata;
}

export interface RunnerSessionPiPaths {
  agentDirectory: string;
  sessionFile: string;
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
    const fileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(sessionDataError));
    yield* ensurePrivateDirectory(fs, sessionsPath).pipe(
      Effect.mapError(storeError("initialize", "Could not initialize runner session storage")),
    );

    const readMetadataValue = (
      sessionId: SessionId,
    ): Effect.Effect<RunnerSessionMetadata, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const path = sessionPath(sessionId);
        yield* assertRealDirectory(path, "Runner session directory");
        const metadata = yield* readMetadataFile(fs, join(path, METADATA_FILE));
        if (metadata.id !== sessionId) {
          return yield* new RunnerSessionDataError(
            `Session directory ${sessionId} contains metadata for ${metadata.id}.`,
          );
        }
        if (metadata.runnerId !== runnerId) {
          return yield* new RunnerSessionDataError(
            `Session ${sessionId} belongs to a different runner.`,
          );
        }
        return metadata;
      });

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
            const metadata = yield* parseMetadata({
              version: 2,
              id: sessionId,
              definition: parsedDefinition,
              runnerId,
              createdAt,
              state: "created",
              checkoutState: "pending",
            });
            yield* Effect.forEach(
              ["workspace", "pi", "logs", "snapshots"],
              (directory) => fileSystem(fs.makeDirectory(join(path, directory), { mode: 0o700 })),
              { discard: true },
            );
            yield* fileSystem(fs.makeDirectory(join(path, "pi", "agent"), { mode: 0o700 }));
            yield* writeNewPrivateFile(join(path, PI_SESSION_FILE), new Uint8Array());
            yield* writeMetadataFile(join(path, METADATA_FILE), metadata);
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
          const metadata = yield* readMetadataValue(sessionId);
          const updated = yield* parseMetadata({ ...metadata, state });
          yield* writeMetadataFile(join(sessionPath(metadata.id), METADATA_FILE), updated);
          return updated;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError("update-session-state", `Could not update runner session ${sessionId}`),
          )),
      ),

      updateProvisioning: Effect.fn("RunnerSessionStore.updateProvisioning")(
        function* (sessionId: SessionId, input: UpdateRunnerSessionProvisioningInput) {
          const metadata = yield* readMetadataValue(sessionId);
          const updated = yield* parseMetadata({
            ...metadata,
            state: input.state,
            checkoutState: input.checkoutState,
            ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
          });
          yield* writeMetadataFile(join(sessionPath(metadata.id), METADATA_FILE), updated);
          return updated;
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
    return yield* Schema.decodeUnknownEffect(MetadataJson)(text, strictSchemaOptions).pipe(
      Effect.mapError(sessionDataError),
    );
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

function writeMetadataFile(
  path: string,
  metadata: RunnerSessionMetadata,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(metadataSchema)(metadata, strictSchemaOptions).pipe(
      Effect.mapError(sessionDataError),
    );
    const contents = `${JSON.stringify(encoded, null, 2)}\n`;
    yield* writeAtomicMetadata(path, contents);
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
