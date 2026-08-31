import { assertEquals } from "@std/assert";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { Data, Deferred, Effect, Layer, MutableRef, Schema } from "effect";

import {
  type EventCodec,
  type Journal,
  Journal as JournalService,
  JournalFailure,
} from "@/src/session/persistent-actor/journal.ts";
import { makeJsonlJournal } from "@/src/session/persistent-actor/jsonl-journal.ts";
import {
  makePersistentActor,
  noEvent,
  persistEvent,
  recoverPersistentState,
} from "@/src/session/persistent-actor/persistent-actor.ts";

const platformLayer = Layer.merge(DenoFileSystem.layer, DenoPath.layer);

const CounterEvent = Schema.Struct({ amount: Schema.Int });
type CounterEvent = typeof CounterEvent.Type;
const counterCodec: EventCodec<CounterEvent> = {
  decode: Schema.decodeUnknownEffect(CounterEvent),
  encode: Schema.encodeEffect(CounterEvent),
};

class CounterFailure extends Data.TaggedError("CounterFailure")<{
  readonly message: string;
}> {}

type CounterCommand =
  | { readonly _tag: "Add"; readonly amount: number; readonly reply: Deferred.Deferred<number> }
  | { readonly _tag: "Get"; readonly reply: Deferred.Deferred<number> };

Deno.test("persistent actor recovers state and serializes append before reply", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await makeJournal(directory);
    const spawn = () =>
      makePersistentActor<number, CounterCommand, CounterEvent>({
        persistenceId: "counter-1",
        codec: counterCodec,
        initialState: () => 0,
        eventHandler: (state, event) => state + event.amount,
        setup: () => Effect.succeed(counterCommandHandler),
      }).pipe(Effect.provideService(JournalService, journal));

    await Effect.runPromise(Effect.scoped(
      spawn().pipe(
        Effect.flatMap((actor) =>
          Effect.gen(function* () {
            assertEquals(yield* request(actor.send, { _tag: "Add", amount: 1 }), 1);
            assertEquals(yield* request(actor.send, { _tag: "Add", amount: 2 }), 3);
          })
        ),
      ),
    ));

    await Effect.runPromise(Effect.scoped(
      spawn().pipe(
        Effect.flatMap((actor) =>
          Effect.gen(function* () {
            assertEquals(yield* request(actor.send, { _tag: "Get" }), 3);
            assertEquals(yield* request(actor.send, { _tag: "Add", amount: 4 }), 7);
          })
        ),
      ),
    ));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent actor completes setup before handling commands", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await makeJournal(directory);
    await Effect.runPromise(journal.append("counter-1", 0, { amount: 2 }, counterCodec));
    const setupCompleted = MutableRef.make(false);
    const actor = makePersistentActor<
      number,
      Deferred.Deferred<readonly [number, boolean]>,
      CounterEvent
    >({
      persistenceId: "counter-1",
      codec: counterCodec,
      initialState: () => 0,
      eventHandler: (state, event) => state + event.amount,
      setup: () =>
        Effect.sleep(10).pipe(
          Effect.andThen(Effect.sync(() => MutableRef.set(setupCompleted, true))),
          Effect.as((
            state: number,
            reply: Deferred.Deferred<readonly [number, boolean]>,
          ) =>
            Effect.succeed(noEvent<number, CounterEvent>(() =>
              Deferred.succeed(reply, [state, MutableRef.get(setupCompleted)]).pipe(Effect.asVoid)
            ))
          ),
        ),
    }).pipe(Effect.provideService(JournalService, journal));
    await Effect.runPromise(Effect.scoped(actor.pipe(
      Effect.flatMap((running) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<readonly [number, boolean]>();
          yield* running.send(reply);
          assertEquals(yield* Deferred.await(reply), [2, true]);
        })
      ),
    )));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent actor shutdown closes its private resource scope", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await makeJournal(directory);
    const finalized = await Effect.runPromise(Deferred.make<void>());
    let acceptedAfterShutdown = true;
    await Effect.runPromise(Effect.scoped(
      makePersistentActor<number, "ping", CounterEvent>({
        persistenceId: "counter-1",
        codec: counterCodec,
        initialState: () => 0,
        eventHandler: (state, event) => state + event.amount,
        setup: () =>
          Effect.addFinalizer(() => Deferred.succeed(finalized, undefined)).pipe(
            Effect.as(() => Effect.succeed(noEvent<number, CounterEvent>())),
          ),
      }).pipe(
        Effect.provideService(JournalService, journal),
        Effect.flatMap((actor) =>
          actor.shutdown.pipe(
            Effect.andThen(actor.send("ping")),
            Effect.tap((accepted) => Effect.sync(() => acceptedAfterShutdown = accepted)),
          )
        ),
      ),
    ));
    assertEquals(await Effect.runPromise(Deferred.isDone(finalized)), true);
    assertEquals(acceptedAfterShutdown, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent actor stops without committing after a journal append failure", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await makeJournal(directory);
    const failingJournal: Journal = {
      replay: journal.replay,
      append: (persistenceId) =>
        new JournalFailure({
          persistenceId,
          operation: "append",
          message: "The journal is unavailable.",
          cause: undefined,
        }),
    };
    const committed = MutableRef.make(false);
    const actor = makePersistentActor<number, number, CounterEvent>({
      persistenceId: "counter-1",
      codec: counterCodec,
      initialState: () => 0,
      eventHandler: (state, event) => state + event.amount,
      setup: () =>
        Effect.succeed((_state: number, amount: number) =>
          Effect.succeed(
            persistEvent<number, CounterEvent>(
              { amount },
              () => Effect.sync(() => MutableRef.set(committed, true)),
            ),
          )
        ),
    }).pipe(Effect.provideService(JournalService, failingJournal));
    await Effect.runPromise(Effect.scoped(actor.pipe(
      Effect.flatMap((running) =>
        Effect.gen(function* () {
          yield* running.send(1);
          yield* running.awaitTermination;
          assertEquals(MutableRef.get(committed), false);
          assertEquals(yield* running.send(1), false);
          assertEquals(
            (yield* Effect.flip(journal.replay("counter-1", counterCodec)))._tag,
            "JournalNotFound",
          );
        })
      ),
    )));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent actor validates recovered state before setup", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await makeJournal(directory);
    const failure = await Effect.runPromise(Effect.flip(Effect.scoped(
      makePersistentActor<number, never, CounterEvent>({
        persistenceId: "counter-1",
        codec: counterCodec,
        initialState: () => 0,
        eventHandler: (state, event) => state + event.amount,
        validateRecovery: (_state, sequence) =>
          sequence === 0
            ? Effect.fail(new CounterFailure({ message: "an existing counter is required" }))
            : Effect.void,
        setup: () => Effect.succeed(() => Effect.succeed(noEvent<number, CounterEvent>())),
      }).pipe(Effect.provideService(JournalService, journal)),
    )));
    assertEquals(failure.operation, "validate-recovery");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent actor continues from the journal's recovered sequence", async () => {
  let appendSequence: number | undefined;
  const journal: Journal = {
    replay: (_persistenceId, codec) =>
      codec.decode({ amount: 2 }).pipe(
        Effect.orDie,
        Effect.map((event) => [{ sequence: 7, event }]),
      ),
    append: (_persistenceId, expectedSequence, event) => {
      appendSequence = expectedSequence;
      return Effect.succeed({ sequence: expectedSequence + 1, event });
    },
  };

  const recovered = await Effect.runPromise(
    recoverPersistentState("counter-1", {
      codec: counterCodec,
      initialState: () => 0,
      eventHandler: (state, event) => state + event.amount,
    }).pipe(Effect.provideService(JournalService, journal)),
  );
  assertEquals(recovered, { state: 2, sequence: 7 });

  await Effect.runPromise(Effect.scoped(
    makePersistentActor<number, Deferred.Deferred<void>, CounterEvent>({
      persistenceId: "counter-1",
      codec: counterCodec,
      initialState: () => 0,
      eventHandler: (state, event) => state + event.amount,
      setup: () =>
        Effect.succeed((_state, reply) =>
          Effect.succeed(persistEvent<number, CounterEvent>(
            { amount: 1 },
            () => Deferred.succeed(reply, undefined).pipe(Effect.asVoid),
          ))
        ),
    }).pipe(
      Effect.provideService(JournalService, journal),
      Effect.flatMap((actor) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<void>();
          yield* actor.send(reply);
          yield* Deferred.await(reply);
        })
      ),
    ),
  ));
  assertEquals(appendSequence, 7);
});

function counterCommandHandler(state: number, command: CounterCommand) {
  return Effect.succeed(
    command._tag === "Add"
      ? persistEvent<number, CounterEvent>(
        { amount: command.amount },
        (next) => Deferred.succeed(command.reply, next).pipe(Effect.asVoid),
      )
      : noEvent<number, CounterEvent>(() =>
        Deferred.succeed(command.reply, state).pipe(Effect.asVoid)
      ),
  );
}

function request(
  send: (command: CounterCommand) => Effect.Effect<boolean>,
  command:
    | Omit<Extract<CounterCommand, { readonly _tag: "Add" }>, "reply">
    | Omit<Extract<CounterCommand, { readonly _tag: "Get" }>, "reply">,
) {
  return Effect.gen(function* () {
    const reply = yield* Deferred.make<number>();
    const message: CounterCommand = command._tag === "Add"
      ? { _tag: "Add", amount: command.amount, reply }
      : { _tag: "Get", reply };
    yield* send(message);
    return yield* Deferred.await(reply);
  });
}

function makeJournal(directory: string) {
  return Effect.runPromise(
    makeJsonlJournal({
      pathFor: (id) => `${directory}/${id}.jsonl`,
    }).pipe(Effect.provide(platformLayer)),
  );
}
