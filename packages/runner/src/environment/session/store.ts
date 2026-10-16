import { OrbSize, RunnerId, SessionId, SessionRepository } from "@openorb/protocol/runner-api";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

const ENVIRONMENTS_DIRECTORY = "environments";
const ENVIRONMENT_DELETIONS_DIRECTORY = "environment-deletions";
const DEFINITION_FILE = "environment.json";
const ROOT_DISK_FILE = "root-disk.qcow2";

/**
 * What an environment is, fixed at creation. Its state is not stored: a runner restart leaves no
 * VM, so every environment it restores is stopped.
 */
export class EnvironmentDefinition extends Schema.Class<EnvironmentDefinition>(
  "EnvironmentDefinition",
)({
  sessionId: SessionId,
  runnerId: RunnerId,
  orbSize: OrbSize,
  /** Absent for a Session without a project; its guest gets no GitHub mediation. */
  repository: Schema.optionalKey(SessionRepository),
}) {}

const DefinitionJson = Schema.fromJsonString(EnvironmentDefinition);
const strict = { onExcessProperty: "error" } as const;

export class EnvironmentStoreError extends Data.TaggedError("EnvironmentStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface EnvironmentStore {
  /** Creates private storage with its definition; `existing` means it already exists. */
  readonly create: (
    definition: EnvironmentDefinition,
  ) => Effect.Effect<"created" | "existing", EnvironmentStoreError>;
  /** Queues and then removes the storage, so an interrupted deletion finishes at startup. */
  readonly remove: (sessionId: SessionId) => Effect.Effect<void, EnvironmentStoreError>;
  /** Every stored definition; storage without a readable definition is skipped. */
  readonly list: Effect.Effect<readonly EnvironmentDefinition[], EnvironmentStoreError>;
  readonly rootDiskPath: (sessionId: SessionId) => Effect.Effect<string, EnvironmentStoreError>;
  readonly syncRootDisk: (sessionId: SessionId) => Effect.Effect<void, EnvironmentStoreError>;
}

export const EnvironmentStore: Context.Service<EnvironmentStore, EnvironmentStore> =
  Context.Service("@openorb/runner/EnvironmentStore");

export const makeEnvironmentStore = Effect.fn("makeEnvironmentStore")(function* (
  workingDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = paths.join(workingDirectory, ENVIRONMENTS_DIRECTORY);
  const deletions = paths.join(workingDirectory, ENVIRONMENT_DELETIONS_DIRECTORY);
  const directory = (sessionId: SessionId) => paths.join(root, sessionId);
  const fail = (message: string) => (cause: unknown) =>
    new EnvironmentStoreError({ message, cause });
  const syncDirectory = (path: string) =>
    Effect.scoped(fs.open(path, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)));
  const syncFile = syncDirectory;
  const privateDirectory = (path: string) =>
    fs
      .makeDirectory(path, { mode: 0o700, recursive: true })
      .pipe(Effect.andThen(fs.chmod(path, 0o700)));

  yield* Effect.all([privateDirectory(root), privateDirectory(deletions)]).pipe(
    Effect.andThen(syncDirectory(workingDirectory)),
    Effect.mapError(fail("Runner environment storage could not be initialized.")),
  );
  const purgeQueued = (sessionId: SessionId) =>
    fs
      .remove(paths.join(deletions, sessionId), { recursive: true, force: true })
      .pipe(Effect.andThen(syncDirectory(deletions)));
  yield* fs.readDirectory(deletions).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) => Schema.decodeUnknownEffect(SessionId)(entry).pipe(Effect.flatMap(purgeQueued)),
        { discard: true },
      ),
    ),
    Effect.mapError(fail("Interrupted environment deletions could not be finished.")),
  );

  const remove = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const path = directory(sessionId);
      if (yield* fs.exists(path)) {
        yield* fs.rename(path, paths.join(deletions, sessionId));
        yield* syncDirectory(deletions);
        yield* syncDirectory(root);
      }
      yield* purgeQueued(sessionId);
    }).pipe(Effect.mapError(fail(`Environment ${sessionId} storage could not be removed.`)));

  // The definition is published by rename, so a directory without one is an interrupted creation.
  const writeDefinition = (definition: EnvironmentDefinition) =>
    Effect.gen(function* () {
      const target = directory(definition.sessionId);
      const candidate = paths.join(target, `${DEFINITION_FILE}.candidate`);
      const encoded = yield* Schema.encodeEffect(DefinitionJson)(definition, strict);
      yield* fs.writeFileString(candidate, encoded, { mode: 0o600 });
      yield* syncFile(candidate);
      yield* fs.rename(candidate, paths.join(target, DEFINITION_FILE));
      yield* syncDirectory(target);
    });

  const restore = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const path = paths.join(directory(sessionId), DEFINITION_FILE);
      if (!(yield* fs.exists(path))) {
        // Without a definition or a disk it is a creation the runner never acknowledged. A disk
        // without a definition is kept for an operator, never deleted.
        if (yield* fs.exists(paths.join(directory(sessionId), ROOT_DISK_FILE))) {
          return yield* Effect.fail("A root disk has no environment definition.");
        }
        yield* remove(sessionId);
        return [];
      }
      const definition = yield* fs.readFileString(path).pipe(
        Effect.flatMap((text) => Schema.decodeUnknownEffect(DefinitionJson)(text, strict)),
        Effect.filterOrFail((definition) => definition.sessionId === sessionId),
      );
      return [definition];
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("environment.restore-skipped").pipe(
          Effect.annotateLogs({ component: "openorb-runner", sessionId }),
          Effect.as([]),
        ),
      ),
    );

  const create = (definition: EnvironmentDefinition) =>
    Effect.gen(function* () {
      const made = yield* fs.makeDirectory(directory(definition.sessionId), { mode: 0o700 }).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (!made) {
        return "existing" as const;
      }
      yield* syncDirectory(root).pipe(
        Effect.andThen(writeDefinition(definition)),
        Effect.onError(() => remove(definition.sessionId).pipe(Effect.ignore)),
      );
      return "created" as const;
    }).pipe(
      Effect.mapError(fail(`Environment ${definition.sessionId} storage could not be created.`)),
    );

  return EnvironmentStore.of({
    create,
    remove,
    list: fs.readDirectory(root).pipe(
      Effect.mapError(fail("Runner environments could not be listed.")),
      Effect.flatMap((entries) =>
        Effect.forEach(entries.toSorted(), (entry) => {
          const sessionId = Schema.decodeUnknownOption(SessionId)(entry);
          return sessionId._tag === "None" ? Effect.succeed([]) : restore(sessionId.value);
        }),
      ),
      Effect.map((definitions) => definitions.flat()),
    ),
    rootDiskPath: (sessionId) =>
      fs.realPath(directory(sessionId)).pipe(
        Effect.map((real) => paths.join(real, ROOT_DISK_FILE)),
        Effect.mapError(fail(`Environment ${sessionId} root disk could not be located.`)),
      ),
    syncRootDisk: (sessionId) =>
      syncFile(paths.join(directory(sessionId), ROOT_DISK_FILE)).pipe(
        Effect.andThen(syncDirectory(directory(sessionId))),
        Effect.mapError(fail(`Environment ${sessionId} root disk could not be synced.`)),
      ),
  });
});

export function environmentStoreLayer(
  workingDirectory: string,
): Layer.Layer<EnvironmentStore, EnvironmentStoreError, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(EnvironmentStore, makeEnvironmentStore(workingDirectory));
}
