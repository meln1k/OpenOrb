import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import {
  SessionArtifact,
  SessionArtifactId,
  type SessionArtifactMediaType,
} from "@openorb/protocol/runner-bulk-api";
import {
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_TOTAL_BYTES,
  MAX_SESSION_ARTIFACTS,
  type SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";

const SESSIONS_DIRECTORY = "sessions";
const ARTIFACTS_DIRECTORY = "artifacts";
const TEMPORARY_FILE_SUFFIX = ".tmp";
const strictSchemaOptions = { onExcessProperty: "error" } as const;
const SessionArtifactJson = Schema.fromJsonString(SessionArtifact);

interface PublishedSessionArtifact {
  readonly fileName: string;
  readonly mediaType: SessionArtifactMediaType;
  readonly bytes: Uint8Array;
}

interface SessionArtifactChunkValue {
  readonly artifact: SessionArtifact;
  readonly bytes: Uint8Array;
}

export class SessionArtifactStoreError extends Data.TaggedError("SessionArtifactStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super(cause === undefined ? { message } : { message, cause });
  }
}

export interface SessionArtifactStore {
  readonly publish: (
    sessionId: SessionId,
    artifact: PublishedSessionArtifact,
  ) => Effect.Effect<SessionArtifact, SessionArtifactStoreError>;
  readonly readChunk: (
    sessionId: SessionId,
    artifactId: SessionArtifactId,
    offset: number,
    maxBytes: number,
  ) => Effect.Effect<SessionArtifactChunkValue, SessionArtifactStoreError>;
}

export const SessionArtifactStore: Context.Service<SessionArtifactStore, SessionArtifactStore> =
  Context.Service("@openorb/runner/SessionArtifactStore");

interface SessionArtifactStoreConfig {
  readonly workingDirectory: string;
}

export function makeSessionArtifactStore(
  config: SessionArtifactStoreConfig,
): Effect.Effect<SessionArtifactStore, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockFor = (sessionId: SessionId): Semaphore.Semaphore => {
      const existing = locks.get(sessionId);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(1);
      locks.set(sessionId, created);
      return created;
    };
    const sessionDirectory = (sessionId: SessionId) =>
      paths.join(config.workingDirectory, SESSIONS_DIRECTORY, sessionId);
    const artifactsDirectory = (sessionId: SessionId) =>
      paths.join(sessionDirectory(sessionId), ARTIFACTS_DIRECTORY);
    const metadataPath = (sessionId: SessionId, artifactId: SessionArtifactId) =>
      paths.join(artifactsDirectory(sessionId), `${artifactId}.json`);
    const contentPath = (sessionId: SessionId, artifactId: SessionArtifactId) =>
      paths.join(artifactsDirectory(sessionId), `${artifactId}.bin`);

    const reconcileArtifacts = Effect.fn("SessionArtifactStore.reconcileArtifacts")(function* (
      sessionId: SessionId,
    ) {
      const directory = artifactsDirectory(sessionId);
      const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(storeError));
      const committedMetadata = new Set(entries.filter((entry) => entry.endsWith(".json")));
      const incomplete = entries.filter((entry) => {
        if (entry.endsWith(TEMPORARY_FILE_SUFFIX)) return true;
        if (!entry.endsWith(".bin")) return false;
        return !committedMetadata.has(`${entry.slice(0, -".bin".length)}.json`);
      });
      if (incomplete.length === 0) return;
      yield* Effect.forEach(
        incomplete,
        (entry) => fs.remove(paths.join(directory, entry), { force: true }),
        { discard: true },
      ).pipe(Effect.mapError(storeError));
      yield* syncDirectory(fs, directory);
    });

    const readArtifact = Effect.fn("SessionArtifactStore.readArtifact")(function* (
      sessionId: SessionId,
      artifactId: SessionArtifactId,
    ) {
      const path = metadataPath(sessionId, artifactId);
      yield* assertRegularFile(fs, path, "Session artifact metadata");
      const bytes = yield* fs.readFile(path).pipe(Effect.mapError(storeError));
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: storeError,
      });
      const artifact = yield* Schema.decodeUnknownEffect(SessionArtifactJson)(
        text,
        strictSchemaOptions,
      ).pipe(Effect.mapError(storeError));
      if (artifact.id !== artifactId) {
        return yield* new SessionArtifactStoreError("Session artifact metadata is inconsistent.");
      }
      return artifact;
    });

    return SessionArtifactStore.of({
      publish: (sessionId, input) =>
        lockFor(sessionId).withPermit(
          Effect.gen(function* () {
            if (
              input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SESSION_ARTIFACT_BYTES
            ) {
              return yield* new SessionArtifactStoreError(
                `Published media must contain 1 to ${MAX_SESSION_ARTIFACT_BYTES} bytes.`,
              );
            }
            const sessionPath = sessionDirectory(sessionId);
            yield* assertDirectory(fs, sessionPath, "Runner session directory");
            const directory = artifactsDirectory(sessionId);
            const directoryCreated = yield* ensurePrivateDirectory(fs, directory);
            if (directoryCreated) yield* syncDirectory(fs, sessionPath);
            yield* reconcileArtifacts(sessionId);
            const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(storeError));
            const artifacts = yield* Effect.forEach(
              entries.filter((entry) => entry.endsWith(".json")),
              (entry) => {
                const artifactId = Schema.decodeUnknownEffect(SessionArtifactId)(
                  entry.slice(0, -".json".length),
                );
                return artifactId.pipe(
                  Effect.flatMap((id) => readArtifact(sessionId, id)),
                  Effect.mapError(storeError),
                );
              },
            );
            if (artifacts.length >= MAX_SESSION_ARTIFACTS) {
              return yield* new SessionArtifactStoreError(
                `A session can publish at most ${MAX_SESSION_ARTIFACTS} media files.`,
              );
            }
            const totalBytes = artifacts.reduce(
              (total, artifact) => total + artifact.byteLength,
              0,
            );
            if (totalBytes + input.bytes.byteLength > MAX_SESSION_ARTIFACT_TOTAL_BYTES) {
              return yield* new SessionArtifactStoreError(
                `Published session media cannot exceed ${MAX_SESSION_ARTIFACT_TOTAL_BYTES} bytes.`,
              );
            }

            const id = Schema.decodeUnknownSync(SessionArtifactId)(crypto.randomUUID());
            const artifact = new SessionArtifact({
              id,
              fileName: input.fileName,
              mediaType: input.mediaType,
              byteLength: input.bytes.byteLength,
            });
            const artifactContentPath = contentPath(sessionId, id);
            const artifactMetadataPath = metadataPath(sessionId, id);
            const artifactMetadataTemporaryPath =
              `${artifactMetadataPath}.${crypto.randomUUID()}${TEMPORARY_FILE_SUFFIX}`;
            let committed = false;
            return yield* Effect.gen(function* () {
              yield* writeNewPrivateFile(fs, artifactContentPath, input.bytes);
              yield* syncDirectory(fs, directory);
              const encoded = yield* Schema.encodeEffect(SessionArtifactJson)(
                artifact,
                strictSchemaOptions,
              ).pipe(Effect.mapError(storeError));
              yield* writeNewPrivateFile(
                fs,
                artifactMetadataTemporaryPath,
                new TextEncoder().encode(encoded),
              );
              yield* fs.rename(artifactMetadataTemporaryPath, artifactMetadataPath).pipe(
                Effect.mapError(storeError),
              );
              yield* syncDirectory(fs, directory);
              committed = true;
              return artifact;
            }).pipe(Effect.ensuring(Effect.suspend(() =>
              committed ? Effect.void : removeIncompleteArtifact(
                fs,
                directory,
                artifactContentPath,
                artifactMetadataPath,
                artifactMetadataTemporaryPath,
              )
            )));
          }).pipe(Effect.mapError(storeError)),
        ),

      readChunk: (sessionId, artifactId, offset, maxBytes) =>
        Effect.gen(function* () {
          const artifact = yield* readArtifact(sessionId, artifactId);
          if (
            !Number.isSafeInteger(offset) || offset < 0 || offset > artifact.byteLength ||
            !Number.isSafeInteger(maxBytes) || maxBytes <= 0
          ) {
            return yield* new SessionArtifactStoreError("The session artifact range is invalid.");
          }
          const path = contentPath(sessionId, artifactId);
          yield* assertRegularFile(fs, path, "Session artifact content");
          const info = yield* fs.stat(path).pipe(Effect.mapError(storeError));
          if (Number(info.size) !== artifact.byteLength) {
            return yield* new SessionArtifactStoreError(
              "Session artifact content is inconsistent.",
            );
          }
          return yield* Effect.scoped(Effect.gen(function* () {
            const file = yield* fs.open(path, { flag: "r" }).pipe(Effect.mapError(storeError));
            yield* file.seek(offset, "start").pipe(Effect.mapError(storeError));
            const requested = Math.min(maxBytes, artifact.byteLength - offset);
            const read = yield* file.readAlloc(requested).pipe(Effect.mapError(storeError));
            const bytes = Option.getOrElse(read, () => new Uint8Array());
            return { artifact, bytes };
          }));
        }).pipe(Effect.mapError(storeError)),
    });
  });
}

export function sessionArtifactStoreLayer(
  config: SessionArtifactStoreConfig,
): Layer.Layer<SessionArtifactStore> {
  return Layer.effect(SessionArtifactStore, makeSessionArtifactStore(config)).pipe(
    Layer.provide(Layer.merge(DenoFileSystem.layer, DenoPath.layer)),
  );
}

function writeNewPrivateFile(
  fs: FileSystem.FileSystem,
  path: string,
  contents: Uint8Array,
): Effect.Effect<void, SessionArtifactStoreError> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(path, { flag: "wx", mode: 0o600 }).pipe(
      Effect.mapError(storeError),
    );
    yield* file.writeAll(contents).pipe(Effect.mapError(storeError));
    yield* file.sync.pipe(Effect.mapError(storeError));
  }));
}

function ensurePrivateDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, SessionArtifactStoreError> {
  return Effect.gen(function* () {
    const existed = yield* fs.exists(path).pipe(Effect.mapError(storeError));
    yield* fs.makeDirectory(path, { mode: 0o700, recursive: true }).pipe(
      Effect.mapError(storeError),
    );
    yield* assertDirectory(fs, path, "Session artifact directory");
    yield* fs.chmod(path, 0o700).pipe(Effect.mapError(storeError));
    return !existed;
  });
}

function removeIncompleteArtifact(
  fs: FileSystem.FileSystem,
  directory: string,
  ...paths: readonly string[]
): Effect.Effect<void> {
  return Effect.all(
    paths.map((path) => fs.remove(path, { force: true }).pipe(Effect.ignore)),
    { discard: true },
  ).pipe(
    Effect.flatMap(() => syncDirectory(fs, directory).pipe(Effect.ignore)),
  );
}

function assertDirectory(
  fs: FileSystem.FileSystem,
  path: string,
  label: string,
): Effect.Effect<void, SessionArtifactStoreError> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(path).pipe(Effect.mapError(storeError));
    if (info.type !== "Directory") {
      return yield* new SessionArtifactStoreError(`${label} must be a directory.`);
    }
  });
}

function assertRegularFile(
  fs: FileSystem.FileSystem,
  path: string,
  label: string,
): Effect.Effect<void, SessionArtifactStoreError> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(path).pipe(Effect.mapError(storeError));
    if (info.type !== "File") {
      return yield* new SessionArtifactStoreError(`${label} must be a regular file.`);
    }
  });
}

function syncDirectory(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, SessionArtifactStoreError> {
  return Effect.scoped(Effect.gen(function* () {
    const directory = yield* fs.open(path, { flag: "r" }).pipe(Effect.mapError(storeError));
    yield* directory.sync.pipe(Effect.mapError(storeError));
  }));
}

function storeError(cause: unknown): SessionArtifactStoreError {
  return cause instanceof SessionArtifactStoreError ? cause : new SessionArtifactStoreError(
    cause instanceof Error ? cause.message : String(cause),
    cause,
  );
}
