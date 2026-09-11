import {
  GitMutationRevision,
  initialPromptPreview,
  RunnerId,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  SessionGitSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import type {
  SessionGitPatchSection,
  SessionGitSnapshotId,
} from "@openorb/protocol/runner-bulk-api";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { readPiSessionEvents } from "../harness/pi/history.ts";
import { Journal } from "./persistent-actor/journal.ts";
import { recoverSessionState, type RunnerSessionMetadata, sessionMetadata } from "./actor/state.ts";

export type { RunnerSessionMetadata } from "./actor/state.ts";

const SESSIONS_DIRECTORY = "sessions";
const SESSION_DELETIONS_DIRECTORY = "session-deletions";
const ROOT_DISK_FILE = "root-disk.qcow2";

const gitSnapshotStateSchema = Schema.Struct({
  snapshot: SessionGitSnapshot,
  mutationRevision: GitMutationRevision.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(GitMutationRevision.make(0))),
  ),
  notificationPending: Schema.Boolean,
});
const GitSnapshotStateJson = Schema.fromJsonString(gitSnapshotStateSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

export type RunnerSessionGitSnapshotState = typeof gitSnapshotStateSchema.Type;

export interface RunnerSessionGitSnapshotPatches {
  readonly snapshotId: SessionGitSnapshotId;
  readonly staged: string;
  readonly unstaged: string;
}

export interface RunnerSessionGitPatchChunk {
  readonly bytes: Uint8Array;
  readonly nextOffset: number;
  readonly done: boolean;
}

export type SessionStorageDisposition = "created" | "existing";

export interface RunnerSessionPiPaths {
  agentDirectory: string;
  sessionFile: string;
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
  | "ensure-session-storage"
  | "remove-session-storage"
  | "read-metadata"
  | "get-root-disk-path"
  | "sync-root-disk"
  | "get-pi-paths"
  | "read-git-snapshot"
  | "advance-git-mutation-revision"
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
  readonly getSessionRootDiskPath: (
    sessionId: SessionId,
  ) => Effect.Effect<string, RunnerSessionStoreError>;
  readonly syncSessionRootDisk: (
    sessionId: SessionId,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly getSessionPiPaths: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionPiPaths, RunnerSessionStoreError>;
  readonly readGitSnapshot: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionGitSnapshot, RunnerSessionStoreError>;
  readonly readGitSnapshotState: (
    sessionId: SessionId,
  ) => Effect.Effect<RunnerSessionGitSnapshotState, RunnerSessionStoreError>;
  readonly advanceGitMutationRevision: (
    sessionId: SessionId,
  ) => Effect.Effect<typeof GitMutationRevision.Type, RunnerSessionStoreError>;
  readonly writeGitSnapshotState: (
    sessionId: SessionId,
    state: RunnerSessionGitSnapshotState,
    patches?: RunnerSessionGitSnapshotPatches,
  ) => Effect.Effect<void, RunnerSessionStoreError>;
  readonly readGitSnapshotPatchChunk: (
    sessionId: SessionId,
    snapshotId: SessionGitSnapshotId,
    section: SessionGitPatchSection,
    offset: number,
    maxBytes: number,
  ) => Effect.Effect<RunnerSessionGitPatchChunk, RunnerSessionStoreError>;
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
    const gitSnapshotFile = "git-snapshot.json";
    const gitPatchFile = (snapshotId: string, section: SessionGitPatchSection) =>
      `git-snapshot-${snapshotId}-${section}.patch`;
    const sessionsPath = paths.join(config.workingDirectory, SESSIONS_DIRECTORY);
    const sessionDeletionsPath = paths.join(
      config.workingDirectory,
      SESSION_DELETIONS_DIRECTORY,
    );
    const sessionPath = (sessionId: SessionId) => paths.join(sessionsPath, sessionId);
    const sessionDeletionPath = (sessionId: SessionId) =>
      paths.join(sessionDeletionsPath, sessionId);
    const snapshotsPath = (sessionId: SessionId) => paths.join(sessionPath(sessionId), "snapshots");
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
        const directory = snapshotsPath(sessionId);
        yield* assertDirectory(fs, directory, "Runner session snapshots directory");
        return yield* readGitSnapshotFile(
          fs,
          paths.join(directory, gitSnapshotFile),
        );
      });

    const writeGitSnapshotValue = (
      sessionId: SessionId,
      state: RunnerSessionGitSnapshotState,
      patches?: RunnerSessionGitSnapshotPatches,
    ): Effect.Effect<void, RunnerSessionDataError> =>
      Effect.gen(function* () {
        const directory = snapshotsPath(sessionId);
        yield* assertDirectory(fs, directory, "Runner session snapshots directory");
        const parsed = yield* Schema.decodeUnknownEffect(gitSnapshotStateSchema)(
          state,
          strictSchemaOptions,
        ).pipe(Effect.mapError(sessionDataError));
        if (patches !== undefined) {
          if (parsed.snapshot.snapshotId !== patches.snapshotId) {
            return yield* sessionDataError(
              new Error("Git Snapshot patch identity does not match its manifest."),
            );
          }
          yield* Effect.all([
            writeAtomicBytes(
              fs,
              paths,
              paths.join(directory, gitPatchFile(patches.snapshotId, "staged")),
              new TextEncoder().encode(patches.staged),
            ),
            writeAtomicBytes(
              fs,
              paths,
              paths.join(directory, gitPatchFile(patches.snapshotId, "unstaged")),
              new TextEncoder().encode(patches.unstaged),
            ),
          ], { concurrency: "unbounded", discard: true });
        }
        yield* writeGitSnapshotFile(
          fs,
          paths,
          paths.join(directory, gitSnapshotFile),
          parsed,
        );
        const snapshotId = parsed.snapshot.snapshotId;
        yield* cleanupDirectory(
          fs,
          paths,
          directory,
          snapshotId === undefined ? [gitSnapshotFile] : [
            gitSnapshotFile,
            gitPatchFile(snapshotId, "staged"),
            gitPatchFile(snapshotId, "unstaged"),
          ],
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
              ["pi", "logs", "snapshots"],
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

      getSessionRootDiskPath: Effect.fn("RunnerSessionStore.getSessionRootDiskPath")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const directory = sessionPath(metadata.id);
          yield* assertDirectory(fs, directory, "Runner session directory");
          const realDirectory = yield* fileSystem(fs.realPath(directory));
          return paths.join(realDirectory, ROOT_DISK_FILE);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(storeError(
            "get-root-disk-path",
            `Could not access runner session ${sessionId} root disk`,
          ))),
      ),

      syncSessionRootDisk: Effect.fn("RunnerSessionStore.syncSessionRootDisk")(
        function* (sessionId: SessionId) {
          const metadata = yield* readMetadataValue(sessionId);
          const directory = sessionPath(metadata.id);
          const rootDiskPath = paths.join(directory, ROOT_DISK_FILE);
          yield* assertRegularFile(fs, rootDiskPath, "Runner session root disk");
          yield* syncFile(fs, rootDiskPath);
          yield* syncDirectory(fs, directory);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(storeError(
            "sync-root-disk",
            `Could not sync runner session ${sessionId} root disk`,
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

      advanceGitMutationRevision: Effect.fn("RunnerSessionStore.advanceGitMutationRevision")(
        function* (sessionId: SessionId) {
          const state = yield* readGitSnapshotValue(sessionId);
          const nextValue = state.mutationRevision + 1;
          if (!Number.isSafeInteger(nextValue)) {
            return yield* sessionDataError(new Error("The Git mutation revision is exhausted."));
          }
          const mutationRevision = GitMutationRevision.make(nextValue);
          yield* writeGitSnapshotValue(sessionId, { ...state, mutationRevision });
          return mutationRevision;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "advance-git-mutation-revision",
              `Could not advance runner session ${sessionId} Git mutation revision`,
            ),
          )),
      ),

      writeGitSnapshotState: Effect.fn("RunnerSessionStore.writeGitSnapshotState")(
        function* (
          sessionId: SessionId,
          state: RunnerSessionGitSnapshotState,
          patches?: RunnerSessionGitSnapshotPatches,
        ) {
          yield* writeGitSnapshotValue(sessionId, state, patches);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "write-git-snapshot",
              `Could not write runner session ${sessionId} Git Snapshot`,
            ),
          )),
      ),

      readGitSnapshotPatchChunk: Effect.fn("RunnerSessionStore.readGitSnapshotPatchChunk")(
        function* (sessionId, snapshotId, section, offset, maxBytes) {
          const state = yield* readGitSnapshotValue(sessionId);
          if (state.snapshot.snapshotId !== snapshotId) {
            return yield* sessionDataError(new Error("The Git Snapshot is no longer current."));
          }
          const sectionBytes = state.snapshot.sections[section].fullPatchBytes;
          if (sectionBytes === undefined || offset > sectionBytes) {
            return yield* sessionDataError(new Error("The Git Snapshot patch range is invalid."));
          }
          const path = paths.join(snapshotsPath(sessionId), gitPatchFile(snapshotId, section));
          return yield* Effect.scoped(Effect.gen(function* () {
            yield* assertRegularFile(fs, path, "Runner session Git Snapshot patch file");
            const file = yield* fs.open(path, { flag: "r" }).pipe(
              Effect.mapError(sessionDataError),
            );
            yield* file.seek(offset, "start").pipe(Effect.mapError(sessionDataError));
            const requested = Math.min(maxBytes, sectionBytes - offset);
            const read = yield* file.readAlloc(requested).pipe(Effect.mapError(sessionDataError));
            const bytes = Option.getOrElse(read, () => new Uint8Array());
            const nextOffset = offset + bytes.byteLength;
            return { bytes, nextOffset, done: nextOffset >= sectionBytes };
          }));
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError(
            storeError(
              "read-git-snapshot",
              `Could not read runner session ${sessionId} Git Snapshot patch`,
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
    issues: metadata.issues,
    lastEventCursor,
  });
}

function cleanupDirectory(
  fs: FileSystem.FileSystem,
  paths: Path.Path,
  directory: string,
  keepFiles: readonly string[],
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(sessionDataError));
    yield* Effect.forEach(
      entries,
      (entry) =>
        keepFiles.includes(entry)
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

function writeAtomicBytes(
  fs: FileSystem.FileSystem,
  paths: Path.Path,
  path: string,
  contents: Uint8Array,
): Effect.Effect<void, RunnerSessionDataError> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  return Effect.gen(function* () {
    yield* writeNewPrivateFile(fs, temporaryPath, contents);
    yield* fs.rename(temporaryPath, path).pipe(Effect.mapError(sessionDataError));
    yield* syncDirectory(fs, paths.dirname(path));
  }).pipe(
    Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
  );
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

function syncFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, RunnerSessionDataError> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(path, { flag: "r" }).pipe(Effect.mapError(sessionDataError));
    yield* file.sync.pipe(Effect.mapError(sessionDataError));
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
