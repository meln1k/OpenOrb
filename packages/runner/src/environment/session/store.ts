import {
  EnvironmentState,
  OrbSize,
  RunnerEnvironmentSnapshot,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionId,
  SessionRepository,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

import type { EventCodec, Journal } from "./journal.ts";
import { makeJsonlJournal } from "./jsonl-journal.ts";

const ENVIRONMENTS_DIRECTORY = "environments";
const ENVIRONMENT_DELETIONS_DIRECTORY = "environment-deletions";
const EVENTS_FILE = "events.jsonl";
const ROOT_DISK_FILE = "root-disk.qcow2";

export class EnvironmentDefinition extends Schema.Class<EnvironmentDefinition>(
  "EnvironmentDefinition",
)({
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
  orbSize: OrbSize,
  /** Absent for a Session without a project; its guest gets no GitHub mediation. */
  repository: Schema.optionalKey(SessionRepository),
}) {}

/** Infrastructure facts only: an environment journal never records agent or project work. */
export const EnvironmentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("environment.created"), definition: EnvironmentDefinition }),
  Schema.Struct({ type: Schema.Literal("disk.initialized") }),
  Schema.Struct({ type: Schema.Literal("environment.changed"), state: EnvironmentState }),
  Schema.Struct({ type: Schema.Literal("stop.completed") }),
]);
export type EnvironmentEvent = typeof EnvironmentEvent.Type;

const strict = { onExcessProperty: "error" } as const;
export const environmentEventCodec: EventCodec<EnvironmentEvent> = {
  decode: (encoded) => Schema.decodeUnknownEffect(EnvironmentEvent)(encoded, strict),
  encode: (event) => Schema.encodeUnknownEffect(EnvironmentEvent)(event, strict),
};

export interface EnvironmentRecord {
  readonly definition: EnvironmentDefinition;
  readonly diskInitialized: boolean;
  readonly state: EnvironmentState;
}

export function applyEnvironmentEvent(
  record: EnvironmentRecord | undefined,
  event: EnvironmentEvent,
): EnvironmentRecord {
  if (event.type === "environment.created") {
    if (record !== undefined) throw new EnvironmentStoreError({ message: "Duplicate creation." });
    return { definition: event.definition, diskInitialized: false, state: "stopped" };
  }
  if (record === undefined) {
    throw new EnvironmentStoreError({ message: "The environment journal has no creation event." });
  }
  switch (event.type) {
    case "disk.initialized":
      return { ...record, diskInitialized: true };
    case "environment.changed":
      return { ...record, state: event.state };
    case "stop.completed":
      return { ...record, state: "stopped" };
  }
}

export function environmentSnapshot(record: EnvironmentRecord): RunnerEnvironmentSnapshot {
  return new RunnerEnvironmentSnapshot({
    sessionId: record.definition.sessionId,
    workspaceId: record.definition.workspaceId,
    createdAt: record.definition.createdAt,
    orbSize: record.definition.orbSize,
    state: record.state,
    ...(record.state === "error" ? { recovery: "restart-environment" as const } : {}),
  });
}

export class EnvironmentStoreError extends Data.TaggedError("EnvironmentStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ReplayedEnvironment {
  readonly record: EnvironmentRecord;
  readonly sequence: number;
}

export interface EnvironmentStore {
  /** Creates private storage; `existing` means a previous attempt already created it. */
  readonly ensure: (
    sessionId: SessionId,
  ) => Effect.Effect<"created" | "existing", EnvironmentStoreError>;
  /** Queues and then removes the storage, so an interrupted deletion finishes at startup. */
  readonly remove: (sessionId: SessionId) => Effect.Effect<void, EnvironmentStoreError>;
  readonly list: Effect.Effect<readonly SessionId[], EnvironmentStoreError>;
  readonly replay: (
    sessionId: SessionId,
  ) => Effect.Effect<ReplayedEnvironment | undefined, EnvironmentStoreError>;
  readonly append: (
    sessionId: SessionId,
    expectedSequence: number,
    event: EnvironmentEvent,
  ) => Effect.Effect<number, EnvironmentStoreError>;
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
  const journal: Journal = yield* makeJsonlJournal({
    pathFor: (id) => paths.join(directory(Schema.decodeUnknownSync(SessionId)(id)), EVENTS_FILE),
  });
  const fail = (message: string) => (cause: unknown) =>
    new EnvironmentStoreError({ message, cause });
  const syncDirectory = (path: string) =>
    Effect.scoped(fs.open(path, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)));
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

  return EnvironmentStore.of({
    ensure: (sessionId) =>
      fs.makeDirectory(directory(sessionId), { mode: 0o700 }).pipe(
        Effect.andThen(syncDirectory(root)),
        Effect.as("created" as const),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "AlreadyExists"
            ? Effect.succeed("existing" as const)
            : Effect.fail(error),
        ),
        Effect.mapError(fail(`Environment ${sessionId} storage could not be created.`)),
      ),
    remove: (sessionId) =>
      Effect.gen(function* () {
        const path = directory(sessionId);
        if (yield* fs.exists(path)) {
          yield* fs.rename(path, paths.join(deletions, sessionId));
          yield* syncDirectory(deletions);
          yield* syncDirectory(root);
        }
        yield* purgeQueued(sessionId);
      }).pipe(Effect.mapError(fail(`Environment ${sessionId} storage could not be removed.`))),
    list: fs.readDirectory(root).pipe(
      Effect.map((entries) =>
        entries
          .flatMap((entry) => {
            const decoded = Schema.decodeUnknownOption(SessionId)(entry);
            return decoded._tag === "Some" ? [decoded.value] : [];
          })
          .sort(),
      ),
      Effect.mapError(fail("Runner environments could not be listed.")),
    ),
    replay: (sessionId) =>
      journal.replay(sessionId, environmentEventCodec).pipe(
        Effect.catchTag("JournalNotFound", () => Effect.succeed([])),
        Effect.mapError(fail(`Environment ${sessionId} journal could not be read.`)),
        Effect.flatMap((entries) =>
          Effect.try({
            try: () => {
              let record: EnvironmentRecord | undefined;
              for (const entry of entries) record = applyEnvironmentEvent(record, entry.event);
              return record === undefined
                ? undefined
                : { record, sequence: entries.at(-1)?.sequence ?? 0 };
            },
            catch: fail(`Environment ${sessionId} journal is inconsistent.`),
          }),
        ),
      ),
    append: (sessionId, expectedSequence, event) =>
      journal.append(sessionId, expectedSequence, event, environmentEventCodec).pipe(
        Effect.map((entry) => entry.sequence),
        Effect.mapError(fail(`Environment ${sessionId} journal could not be written.`)),
      ),
    rootDiskPath: (sessionId) =>
      fs.realPath(directory(sessionId)).pipe(
        Effect.map((real) => paths.join(real, ROOT_DISK_FILE)),
        Effect.mapError(fail(`Environment ${sessionId} root disk could not be located.`)),
      ),
    syncRootDisk: (sessionId) =>
      Effect.scoped(
        fs
          .open(paths.join(directory(sessionId), ROOT_DISK_FILE), { flag: "r" })
          .pipe(Effect.flatMap((file) => file.sync)),
      ).pipe(
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
