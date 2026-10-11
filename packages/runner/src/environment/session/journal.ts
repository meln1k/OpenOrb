import { Context, Data, type Effect } from "effect";

export interface EventCodec<Event> {
  readonly decode: (encoded: unknown) => Effect.Effect<Event, unknown, never>;
  readonly encode: (event: Event) => Effect.Effect<unknown, unknown, never>;
}

/**
 * Append-only storage contract used by persistent actors.
 * Implementations encode events on append and decode them during replay.
 */
export interface JournalEntry<Event> {
  readonly sequence: number;
  readonly event: Event;
}

export interface Journal {
  readonly replay: <Event>(
    persistenceId: string,
    codec: EventCodec<Event>,
  ) => Effect.Effect<readonly JournalEntry<Event>[], JournalError, never>;
  readonly append: <Event>(
    persistenceId: string,
    expectedSequence: number,
    event: Event,
    codec: EventCodec<Event>,
  ) => Effect.Effect<JournalEntry<Event>, JournalError, never>;
}

export const Journal: Context.Service<Journal, Journal> = Context.Service(
  "@openorb/runner/Journal",
);

export class JournalNotFound extends Data.TaggedError("JournalNotFound")<{
  readonly persistenceId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JournalSequenceConflict extends Data.TaggedError("JournalSequenceConflict")<{
  readonly persistenceId: string;
  readonly expectedSequence: number;
  readonly actualSequence: number;
  readonly message: string;
}> {}

export class JournalFailure extends Data.TaggedError("JournalFailure")<{
  readonly persistenceId: string;
  readonly operation: "replay" | "append";
  readonly message: string;
  readonly cause: unknown;
}> {}

export type JournalError = JournalNotFound | JournalSequenceConflict | JournalFailure;
