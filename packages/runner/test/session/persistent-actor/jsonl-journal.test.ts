import { assert, assertEquals } from "@std/assert";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { Effect, Layer, Schema } from "effect";
import { join } from "node:path";

import type { EventCodec } from "@/src/session/persistent-actor/journal.ts";
import { makeJsonlJournal } from "@/src/session/persistent-actor/jsonl-journal.ts";

const platformLayer = Layer.merge(DenoFileSystem.layer, DenoPath.layer);
const CounterEvent = Schema.Struct({ amount: Schema.Int });
type CounterEvent = typeof CounterEvent.Type;
const counterCodec: EventCodec<CounterEvent> = {
  decode: Schema.decodeUnknownEffect(CounterEvent),
  encode: Schema.encodeEffect(CounterEvent),
};

Deno.test("JSONL journal appends, replays, and rejects stale writers", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await Effect.runPromise(
      makeJsonlJournal({
        pathFor: (id) => join(directory, `${id}.jsonl`),
      }).pipe(Effect.provide(platformLayer)),
    );
    assertEquals(
      await Effect.runPromise(
        journal.append("counter-1", 0, { amount: 1 }, counterCodec),
      ),
      {
        sequence: 1,
        event: { amount: 1 },
      },
    );
    await Effect.runPromise(journal.append("counter-1", 1, { amount: 2 }, counterCodec));
    assertEquals(await Effect.runPromise(journal.replay("counter-1", counterCodec)), [
      { sequence: 1, event: { amount: 1 } },
      { sequence: 2, event: { amount: 2 } },
    ]);

    const conflict = await Effect.runPromise(Effect.flip(
      journal.append("counter-1", 1, { amount: 3 }, counterCodec),
    ));
    assertEquals(conflict._tag, "JournalSequenceConflict");
    assert(conflict._tag === "JournalSequenceConflict");
    assertEquals(conflict.actualSequence, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("JSONL journal repairs an incomplete final record", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "counter-1.jsonl");
    const journal = await Effect.runPromise(
      makeJsonlJournal({ pathFor: () => path }).pipe(Effect.provide(platformLayer)),
    );
    await Effect.runPromise(journal.append("counter-1", 0, { amount: 1 }, counterCodec));
    await Deno.writeTextFile(path, '{"version":1,"sequence":2', { append: true });

    const restarted = await Effect.runPromise(
      makeJsonlJournal({ pathFor: () => path }).pipe(Effect.provide(platformLayer)),
    );
    assertEquals(await Effect.runPromise(restarted.replay("counter-1", counterCodec)), [
      { sequence: 1, event: { amount: 1 } },
    ]);
    await Effect.runPromise(restarted.append("counter-1", 1, { amount: 2 }, counterCodec));
    assertEquals((await Deno.readTextFile(path)).trim().split("\n").length, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("JSONL journal owns event codec failures", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const journal = await Effect.runPromise(
      makeJsonlJournal({
        pathFor: (id) => join(directory, `${id}.jsonl`),
      }).pipe(Effect.provide(platformLayer)),
    );
    const encodeFailure = await Effect.runPromise(Effect.flip(
      journal.append(
        "encode-failure",
        0,
        { amount: 1 },
        { ...counterCodec, encode: () => Effect.fail("encode failed") },
      ),
    ));
    assertEquals(encodeFailure._tag, "JournalFailure");
    assert(encodeFailure._tag === "JournalFailure");
    assertEquals(encodeFailure.operation, "append");

    await Effect.runPromise(
      journal.append("decode-failure", 0, { amount: 1 }, counterCodec),
    );
    const decodeFailure = await Effect.runPromise(Effect.flip(
      journal.replay(
        "decode-failure",
        { ...counterCodec, decode: () => Effect.fail("decode failed") },
      ),
    ));
    assertEquals(decodeFailure._tag, "JournalFailure");
    assert(decodeFailure._tag === "JournalFailure");
    assertEquals(decodeFailure.operation, "replay");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
