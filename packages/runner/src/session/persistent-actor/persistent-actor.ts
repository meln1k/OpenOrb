import { Effect, Exit, Fiber, MutableRef, Queue, Scope } from "effect";

import { type EventCodec, Journal, type JournalError } from "./journal.ts";

export interface PersistentActorContext<Command> {
  readonly persistenceId: string;
  readonly send: (command: Command) => Effect.Effect<boolean, never, never>;
}

export type CommandDecision<State, Event> = NoEvent<State> | Persist<Event, State>;

export interface NoEvent<State> {
  readonly _tag: "NoEvent";
  readonly afterCommit: (state: State) => Effect.Effect<void, never, Scope.Scope>;
}

export interface Persist<Event, State> {
  readonly _tag: "Persist";
  readonly event: Event;
  readonly afterCommit: (state: State) => Effect.Effect<void, never, Scope.Scope>;
}

export type CommandHandler<State, Command, Event> = (
  state: State,
  command: Command,
) => Effect.Effect<CommandDecision<State, Event>, never, Scope.Scope>;

export interface PersistentActor<Command> {
  readonly persistenceId: string;
  readonly send: (command: Command) => Effect.Effect<boolean, never, never>;
  readonly awaitTermination: Effect.Effect<Exit.Exit<void, PersistentActorError>, never, never>;
  readonly shutdown: Effect.Effect<void, never, never>;
}

export interface PersistentActorBehavior<State, Event> {
  readonly codec: EventCodec<Event>;
  readonly initialState: () => State;
  /** Applies a persisted fact. Event handlers must be total and deterministic. */
  readonly eventHandler: (state: State, event: Event) => State;
  readonly validateRecovery?: (
    state: State,
    sequence: number,
  ) => Effect.Effect<void, unknown, never>;
}

export interface PersistentActorOptions<State, Command, Event>
  extends PersistentActorBehavior<State, Event> {
  readonly persistenceId: string;
  readonly setup: (
    context: PersistentActorContext<Command>,
  ) => Effect.Effect<CommandHandler<State, Command, Event>, unknown, Scope.Scope>;
}

export interface PersistentActorRecovery<State> {
  readonly state: State;
  readonly sequence: number;
}

export class PersistentActorError extends Error {
  readonly persistenceId: string;
  readonly operation:
    | "replay"
    | "validate-recovery"
    | "setup"
    | "append";
  override readonly cause: unknown;

  constructor(input: {
    readonly persistenceId: string;
    readonly operation: PersistentActorError["operation"];
    readonly message: string;
    readonly cause: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "PersistentActorError";
    this.persistenceId = input.persistenceId;
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

export function noEvent<State, Event>(
  afterCommit: NoEvent<State>["afterCommit"] = () => Effect.void,
): CommandDecision<State, Event> {
  return { _tag: "NoEvent", afterCommit };
}

export function persistEvent<State, Event>(
  event: Event,
  afterCommit: Persist<Event, State>["afterCommit"] = () => Effect.void,
): CommandDecision<State, Event> {
  return { _tag: "Persist", event, afterCommit };
}

/** Runs a recovered state machine behind a FIFO mailbox and durable event journal. */
export function makePersistentActor<State, Command, Event>(
  options: PersistentActorOptions<State, Command, Event>,
): Effect.Effect<PersistentActor<Command>, PersistentActorError, Journal | Scope.Scope> {
  return Effect.gen(function* () {
    const journal = yield* Journal;
    const recovered = yield* replayPersistentState(options.persistenceId, options, journal);
    yield* validateRecoveredState(options.persistenceId, options, recovered);

    const mailbox = yield* Queue.unbounded<Command>();
    const state = MutableRef.make(recovered.state);
    const sequence = MutableRef.make(recovered.sequence);
    const actorScope = yield* Scope.make();

    const send = (command: Command): Effect.Effect<boolean> => Queue.offer(mailbox, command);
    const commandHandler = yield* options.setup({
      persistenceId: options.persistenceId,
      send,
    }).pipe(
      Effect.provideService(Scope.Scope, actorScope),
      Effect.mapError((cause) => actorError(options.persistenceId, "setup", cause)),
      Effect.tapError(() => Scope.close(actorScope, Exit.void)),
    );

    const handleCommand = (command: Command) =>
      commandHandler(MutableRef.get(state), command).pipe(
        Effect.provideService(Scope.Scope, actorScope),
        Effect.flatMap((decision) => {
          if (decision._tag === "NoEvent") {
            return decision.afterCommit(MutableRef.get(state)).pipe(
              Effect.provideService(Scope.Scope, actorScope),
            );
          }
          return Effect.gen(function* () {
            const entry = yield* journal.append(
              options.persistenceId,
              MutableRef.get(sequence),
              decision.event,
              options.codec,
            ).pipe(
              Effect.mapError((cause) => actorError(options.persistenceId, "append", cause)),
            );
            const next = options.eventHandler(MutableRef.get(state), decision.event);
            MutableRef.set(state, next);
            MutableRef.set(sequence, entry.sequence);
            yield* decision.afterCommit(next).pipe(
              Effect.provideService(Scope.Scope, actorScope),
            );
          });
        }),
      );

    const run = Queue.take(mailbox).pipe(
      Effect.flatMap(handleCommand),
      Effect.forever,
      Effect.ensuring(
        Queue.shutdown(mailbox).pipe(
          Effect.andThen(Scope.close(actorScope, Exit.void)),
        ),
      ),
    );
    const fiber = yield* run.pipe(Effect.forkScoped);
    const shutdown = Queue.shutdown(mailbox).pipe(
      Effect.andThen(Fiber.interrupt(fiber)),
      Effect.andThen(Scope.close(actorScope, Exit.void)),
    );
    yield* Effect.addFinalizer(() => shutdown);

    return {
      persistenceId: options.persistenceId,
      send,
      awaitTermination: Fiber.await(fiber),
      shutdown,
    };
  });
}

/** Replays and validates state without starting a command-processing actor. */
export function recoverPersistentState<State, Event>(
  persistenceId: string,
  behavior: PersistentActorBehavior<State, Event>,
): Effect.Effect<PersistentActorRecovery<State>, PersistentActorError, Journal> {
  return Effect.gen(function* () {
    const journal = yield* Journal;
    const recovered = yield* replayPersistentState(persistenceId, behavior, journal);
    yield* validateRecoveredState(persistenceId, behavior, recovered);
    return recovered;
  });
}

function replayPersistentState<State, Event>(
  persistenceId: string,
  behavior: PersistentActorBehavior<State, Event>,
  journal: Journal,
): Effect.Effect<PersistentActorRecovery<State>, PersistentActorError> {
  return Effect.gen(function* () {
    const entries = yield* journal.replay(persistenceId, behavior.codec).pipe(
      Effect.catchTag("JournalNotFound", () => Effect.succeed([])),
      Effect.mapError((cause) => actorError(persistenceId, "replay", cause)),
    );
    let state = behavior.initialState();
    for (const entry of entries) {
      state = behavior.eventHandler(state, entry.event);
    }
    return { state, sequence: entries.at(-1)?.sequence ?? 0 };
  });
}

function validateRecoveredState<State, Event>(
  persistenceId: string,
  behavior: PersistentActorBehavior<State, Event>,
  recovered: PersistentActorRecovery<State>,
): Effect.Effect<void, PersistentActorError> {
  return behavior.validateRecovery === undefined
    ? Effect.void
    : behavior.validateRecovery(recovered.state, recovered.sequence).pipe(
      Effect.mapError((cause) => actorError(persistenceId, "validate-recovery", cause)),
    );
}

function actorError(
  persistenceId: string,
  operation: PersistentActorError["operation"],
  cause: JournalError | unknown,
): PersistentActorError {
  return new PersistentActorError({
    persistenceId,
    operation,
    message: `Persistent actor ${persistenceId} failed to ${operation}.`,
    cause,
  });
}
