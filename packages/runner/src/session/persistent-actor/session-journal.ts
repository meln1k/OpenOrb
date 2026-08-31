import { Effect, type FileSystem, Layer, Path } from "effect";

import { Journal } from "./journal.ts";
import { makeJsonlJournal } from "./jsonl-journal.ts";

const SESSIONS_DIRECTORY = "sessions";
const EVENTS_FILE = "events.jsonl";

export function sessionJournalLayer(
  workingDirectory: string,
): Layer.Layer<Journal, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      return yield* makeJsonlJournal({
        pathFor: (sessionId) =>
          paths.join(workingDirectory, SESSIONS_DIRECTORY, sessionId, EVENTS_FILE),
      });
    }),
  );
}
