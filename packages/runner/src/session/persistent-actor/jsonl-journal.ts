import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";

import {
  type EventCodec,
  type Journal,
  type JournalEntry,
  type JournalError,
  JournalFailure,
  JournalNotFound,
  JournalSequenceConflict,
} from "./journal.ts";

const journalEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  event: Schema.Unknown,
});
const JournalEnvelopeJson = Schema.fromJsonString(journalEnvelopeSchema);
const strictSchemaOptions = { onExcessProperty: "error" } as const;

interface JournalEnvelope {
  readonly version: 1;
  readonly sequence: number;
  readonly event: unknown;
}

export interface JsonlJournalOptions {
  readonly pathFor: (persistenceId: string) => string;
}

/** Durable JSONL journal implementation. The caller owns persistence ID validation and paths. */
export function makeJsonlJournal(
  options: JsonlJournalOptions,
): Effect.Effect<Journal, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const locks = new Map<string, Semaphore.Semaphore>();
    const sequences = new Map<string, number>();
    const lockFor = (persistenceId: string): Semaphore.Semaphore => {
      const existing = locks.get(persistenceId);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(1);
      locks.set(persistenceId, created);
      return created;
    };

    const pathFor = (
      persistenceId: string,
      operation: "replay" | "append",
    ): Effect.Effect<string, JournalFailure> =>
      Effect.try({
        try: () => options.pathFor(persistenceId),
        catch: (cause) =>
          failure(persistenceId, operation, "Could not resolve the journal path.", cause),
      });

    const readEntries = Effect.fn("JsonlJournal.readEntries")(function* (
      persistenceId: string,
    ) {
      const path = yield* pathFor(persistenceId, "replay");
      const exists = yield* regularFileExists(fs, path, persistenceId, "replay");
      if (!exists) {
        return yield* new JournalNotFound({
          persistenceId,
          message: `Journal ${persistenceId} does not exist.`,
        });
      }

      let contents = yield* journalFileSystem(
        fs.readFile(path),
        persistenceId,
        "replay",
        "Could not read the journal.",
      );
      if (contents.length > 0 && contents.at(-1) !== 0x0a) {
        const lastNewline = contents.lastIndexOf(0x0a);
        const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
        yield* truncate(fs, path, completeLength, persistenceId);
        contents = contents.subarray(0, completeLength);
      }

      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
        catch: (cause) =>
          failure(persistenceId, "replay", "The journal is not valid UTF-8.", cause),
      });
      const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
      const entries: JournalEntry<unknown>[] = [];
      for (let index = 0; index < lines.length; index++) {
        const envelope = yield* Schema.decodeUnknownEffect(JournalEnvelopeJson)(
          lines[index]!,
          strictSchemaOptions,
        ).pipe(
          Effect.mapError((cause) =>
            failure(
              persistenceId,
              "replay",
              `Journal entry ${index + 1} is invalid.`,
              cause,
            )
          ),
        );
        const expectedSequence = index + 1;
        if (envelope.sequence !== expectedSequence) {
          return yield* failure(
            persistenceId,
            "replay",
            `Expected journal sequence ${expectedSequence}, received ${envelope.sequence}.`,
            undefined,
          );
        }
        entries.push({ sequence: envelope.sequence, event: envelope.event });
      }
      sequences.set(persistenceId, entries.length);
      return entries;
    });

    const replay: Journal["replay"] = (persistenceId, codec) =>
      lockFor(persistenceId).withPermit(
        readEntries(persistenceId).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(entries, (entry) => decodeEvent(persistenceId, entry, codec))
          ),
        ),
      );

    const append: Journal["append"] = (persistenceId, expectedSequence, event, codec) =>
      lockFor(persistenceId).withPermit(Effect.gen(function* () {
        const path = yield* pathFor(persistenceId, "append");
        let actualSequence = sequences.get(persistenceId);
        let exists = true;
        if (actualSequence === undefined) {
          const recovered = yield* readEntries(persistenceId).pipe(
            Effect.matchEffect({
              onFailure: (error): Effect.Effect<readonly JournalEntry<unknown>[], JournalError> => {
                if (error._tag !== "JournalNotFound") return Effect.fail(error);
                exists = false;
                return Effect.succeed([]);
              },
              onSuccess: Effect.succeed,
            }),
          );
          actualSequence = recovered.length;
        } else {
          exists = yield* regularFileExists(fs, path, persistenceId, "append");
          if (!exists) {
            sequences.delete(persistenceId);
            actualSequence = 0;
          }
        }
        if (actualSequence !== expectedSequence) {
          return yield* new JournalSequenceConflict({
            persistenceId,
            expectedSequence,
            actualSequence,
            message:
              `Journal ${persistenceId} is at sequence ${actualSequence}, expected ${expectedSequence}.`,
          });
        }

        const entry = { sequence: expectedSequence + 1, event };
        const encodedEvent = yield* codec.encode(event).pipe(
          Effect.mapError((cause) =>
            failure(persistenceId, "append", "Could not encode the journal event.", cause)
          ),
        );
        const contents = yield* encodeEnvelope(persistenceId, {
          version: 1,
          sequence: entry.sequence,
          event: encodedEvent,
        });
        if (exists) {
          yield* appendFile(fs, path, contents, persistenceId);
        } else {
          yield* writeNewFile(fs, path, contents, persistenceId);
          yield* syncDirectory(fs, paths.dirname(path), persistenceId);
        }
        sequences.set(persistenceId, entry.sequence);
        return entry;
      }));

    return { replay, append };
  });
}

function encodeEnvelope(
  persistenceId: string,
  envelope: JournalEnvelope,
): Effect.Effect<Uint8Array, JournalFailure> {
  return Schema.encodeEffect(JournalEnvelopeJson)(envelope, strictSchemaOptions).pipe(
    Effect.map((encoded) => new TextEncoder().encode(`${encoded}\n`)),
    Effect.mapError((cause) =>
      failure(persistenceId, "append", "Could not encode the journal entry.", cause)
    ),
  );
}

function decodeEvent<Event>(
  persistenceId: string,
  entry: JournalEntry<unknown>,
  codec: EventCodec<Event>,
): Effect.Effect<JournalEntry<Event>, JournalFailure> {
  return codec.decode(entry.event).pipe(
    Effect.map((event) => ({ sequence: entry.sequence, event })),
    Effect.mapError((cause) =>
      failure(
        persistenceId,
        "replay",
        `Journal entry ${entry.sequence} event is invalid.`,
        cause,
      )
    ),
  );
}

function regularFileExists(
  fs: FileSystem.FileSystem,
  path: string,
  persistenceId: string,
  operation: "replay" | "append",
): Effect.Effect<boolean, JournalFailure> {
  return fs.stat(path).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(failure(
          persistenceId,
          operation,
          "Could not inspect the journal.",
          error,
        )),
      onSuccess: (info) =>
        info.type === "File" ? Effect.succeed(true) : Effect.fail(failure(
          persistenceId,
          operation,
          "The journal must be a regular file.",
          undefined,
        )),
    }),
  );
}

function appendFile(
  fs: FileSystem.FileSystem,
  path: string,
  contents: Uint8Array,
  persistenceId: string,
): Effect.Effect<void, JournalFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* journalFileSystem(
      fs.open(path, { flag: "a" }),
      persistenceId,
      "append",
      "Could not open the journal for append.",
    );
    yield* journalFileSystem(
      file.writeAll(contents),
      persistenceId,
      "append",
      "Could not write the complete journal entry.",
    );
    yield* journalFileSystem(
      file.sync,
      persistenceId,
      "append",
      "Could not synchronize the journal.",
    );
  }));
}

function writeNewFile(
  fs: FileSystem.FileSystem,
  path: string,
  contents: Uint8Array,
  persistenceId: string,
): Effect.Effect<void, JournalFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* journalFileSystem(
      fs.open(path, { flag: "ax", mode: 0o600 }),
      persistenceId,
      "append",
      "Could not create the journal.",
    );
    yield* journalFileSystem(
      file.writeAll(contents),
      persistenceId,
      "append",
      "Could not write the complete journal entry.",
    );
    yield* journalFileSystem(
      file.sync,
      persistenceId,
      "append",
      "Could not synchronize the new journal.",
    );
  }));
}

function truncate(
  fs: FileSystem.FileSystem,
  path: string,
  length: number,
  persistenceId: string,
): Effect.Effect<void, JournalFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* journalFileSystem(
      fs.open(path, { flag: "r+" }),
      persistenceId,
      "replay",
      "Could not open the journal for tail repair.",
    );
    yield* journalFileSystem(
      file.truncate(length),
      persistenceId,
      "replay",
      "Could not repair the incomplete journal tail.",
    );
    yield* journalFileSystem(
      file.sync,
      persistenceId,
      "replay",
      "Could not synchronize the repaired journal.",
    );
  }));
}

function syncDirectory(
  fs: FileSystem.FileSystem,
  path: string,
  persistenceId: string,
): Effect.Effect<void, JournalFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const directory = yield* journalFileSystem(
      fs.open(path, { flag: "r" }),
      persistenceId,
      "append",
      "Could not open the journal directory.",
    );
    yield* journalFileSystem(
      directory.sync,
      persistenceId,
      "append",
      "Could not synchronize the journal directory.",
    );
  }));
}

function journalFileSystem<A, R>(
  effect: Effect.Effect<A, unknown, R>,
  persistenceId: string,
  operation: "replay" | "append",
  message: string,
): Effect.Effect<A, JournalFailure, R> {
  return effect.pipe(
    Effect.mapError((cause) => failure(persistenceId, operation, message, cause)),
  );
}

function failure(
  persistenceId: string,
  operation: "replay" | "append",
  message: string,
  cause: unknown,
): JournalFailure {
  return new JournalFailure({ persistenceId, operation, message, cause });
}
