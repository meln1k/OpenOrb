import { initialPromptPreview } from "@openorb/protocol";
import {
  ModelReference,
  type OrbSize,
  OrbSize as OrbSizeSchema,
  ProjectId,
  type RunnerCheckoutState,
  RunnerCheckoutState as RunnerCheckoutStateSchema,
  RunnerId,
  RunnerSessionCreatedAt,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  RunnerSessionState as RunnerSessionStateSchema,
  SessionGitReference,
  SessionId,
  SessionRepositoryUrl,
} from "@openorb/protocol/runner-api";
import { Context, Data, DateTime, Effect, FileSystem, Layer, Schema } from "effect";
import { dirname, join } from "node:path";

import { readPiSessionEvents } from "../harness/pi/history.ts";

const SESSIONS_DIRECTORY = "sessions";
const METADATA_FILE = "metadata.json";
const PI_SESSION_FILE = join("pi", "session.jsonl");

const StoredInitialPrompt = Schema.String.check(
  Schema.makeFilter((value) =>
    initialPromptPreview(value).length > 0
      ? undefined
      : "The initial prompt must contain non-whitespace text."
  ),
);
const BaseCommit = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40,64}$/, {
    message: "Base commits must be hexadecimal object identifiers.",
  }),
);
const metadataSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: SessionId,
  projectId: ProjectId,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
  repositoryUrl: SessionRepositoryUrl,
  ref: SessionGitReference,
  branchName: SessionGitReference,
  initialPrompt: StoredInitialPrompt,
  model: ModelReference,
  orbSize: OrbSizeSchema,
  state: RunnerSessionStateSchema,
  checkoutState: RunnerCheckoutStateSchema,
  baseCommit: Schema.optionalKey(BaseCommit),
});
const MetadataJson = Schema.fromJsonString(metadataSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

export type RunnerSessionMetadata = typeof metadataSchema.Type;

export interface CreateRunnerSessionInput {
  id: SessionId;
  projectId: ProjectId;
  repositoryUrl: string;
  ref: string;
  branchName: string;
  initialPrompt: string;
  model: string;
  orbSize: OrbSize;
  createdAt?: typeof RunnerSessionCreatedAt.Type;
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
  | "create-session"
  | "read-metadata"
  | "update-session-state"
  | "update-provisioning"
  | "get-workspace-path"
  | "get-pi-paths"
  | "get-session-snapshot"
  | "load-session-manifest";

export class RunnerSessionAlreadyExists extends Data.TaggedError("RunnerSessionAlreadyExists")<{
  readonly sessionId: SessionId;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RunnerSessionStoreFailure extends Data.TaggedError("RunnerSessionStoreFailure")<{
  readonly operation: RunnerSessionStoreOperation;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type RunnerSessionStoreError = RunnerSessionAlreadyExists | RunnerSessionStoreFailure;

export interface RunnerSessionStore {
  readonly createSession: (
    input: CreateRunnerSessionInput,
  ) => Effect.Effect<RunnerSessionMetadata, RunnerSessionStoreError>;
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

    const store = RunnerSessionStore.of({
      createSession: Effect.fn("RunnerSessionStore.createSession")(
        function* (input: CreateRunnerSessionInput) {
          const createdAt = input.createdAt ?? DateTime.formatIso(yield* DateTime.now);
          const metadata = yield* parseMetadata({
            version: 1,
            id: input.id,
            projectId: input.projectId,
            runnerId,
            createdAt,
            repositoryUrl: input.repositoryUrl,
            ref: input.ref,
            branchName: input.branchName,
            initialPrompt: input.initialPrompt,
            model: input.model,
            orbSize: input.orbSize,
            state: "created",
            checkoutState: "pending",
          });
          const path = sessionPath(metadata.id);
          yield* createSessionDirectory(path, metadata.id);
          return yield* Effect.gen(function* () {
            yield* Effect.forEach(
              ["workspace", "pi", "logs", "reports"],
              (directory) => fileSystem(fs.makeDirectory(join(path, directory), { mode: 0o700 })),
              { discard: true },
            );
            yield* fileSystem(fs.makeDirectory(join(path, "pi", "agent"), { mode: 0o700 }));
            yield* writeNewPrivateFile(join(path, PI_SESSION_FILE), new Uint8Array());
            yield* writeMetadataFile(join(path, METADATA_FILE), metadata);
            yield* syncDirectory(dirname(path));
            return metadata;
          }).pipe(
            Effect.onError(() =>
              fileSystem(fs.remove(path, { recursive: true })).pipe(Effect.ignore)
            ),
          );
        },
        (effect, input) =>
          effect.pipe(Effect.mapError(
            storeError("create-session", `Could not create runner session ${input.id}`),
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
  sessionId: SessionId,
): Effect.Effect<void, RunnerSessionAlreadyExists | RunnerSessionDataError> {
  return Effect.tryPromise({
    try: () => Deno.mkdir(path, { mode: 0o700 }),
    catch: (cause) =>
      cause instanceof Deno.errors.AlreadyExists
        ? new RunnerSessionAlreadyExists({
          sessionId,
          message: "This session already exists on the runner.",
          cause,
        })
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
    projectId: metadata.projectId,
    createdAt: metadata.createdAt,
    initialPromptPreview: initialPromptPreview(metadata.initialPrompt),
    model: metadata.model,
    orbSize: metadata.orbSize,
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
    cause instanceof RunnerSessionAlreadyExists ? cause : new RunnerSessionStoreFailure({
      operation,
      message: `${context}: ${errorMessage(cause)}`,
      cause,
    });
}
