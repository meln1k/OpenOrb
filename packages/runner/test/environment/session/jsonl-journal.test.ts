import { test } from "vite-plus/test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals } from "@jsr/std__assert";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer, Schema } from "effect";
import { join } from "node:path";

import type { EventCodec } from "../../../src/environment/session/journal.ts";
import { makeJsonlJournal } from "../../../src/environment/session/jsonl-journal.ts";

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const CounterEvent = Schema.Struct({ amount: Schema.Int });
type CounterEvent = typeof CounterEvent.Type;
const counterCodec: EventCodec<CounterEvent> = {
  decode: Schema.decodeUnknownEffect(CounterEvent),
  encode: Schema.encodeEffect(CounterEvent),
};

test("JSONL journal appends, replays, and rejects stale writers", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const journal = await Effect.runPromise(
      makeJsonlJournal({
        pathFor: (id) => join(directory, `${id}.jsonl`),
      }).pipe(Effect.provide(platformLayer)),
    );
    assertEquals(
      await Effect.runPromise(journal.append("counter-1", 0, { amount: 1 }, counterCodec)),
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

    const conflict = await Effect.runPromise(
      Effect.flip(journal.append("counter-1", 1, { amount: 3 }, counterCodec)),
    );
    assertEquals(conflict._tag, "JournalSequenceConflict");
    assert(conflict._tag === "JournalSequenceConflict");
    assertEquals(conflict.actualSequence, 2);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("JSONL journal repairs an incomplete final record", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const path = join(directory, "counter-1.jsonl");
    const journal = await Effect.runPromise(
      makeJsonlJournal({ pathFor: () => path }).pipe(Effect.provide(platformLayer)),
    );
    await Effect.runPromise(journal.append("counter-1", 0, { amount: 1 }, counterCodec));
    await fs.writeFile(path, '{"version":1,"sequence":2', { flag: "a" });

    const restarted = await Effect.runPromise(
      makeJsonlJournal({ pathFor: () => path }).pipe(Effect.provide(platformLayer)),
    );
    assertEquals(await Effect.runPromise(restarted.replay("counter-1", counterCodec)), [
      { sequence: 1, event: { amount: 1 } },
    ]);
    await Effect.runPromise(restarted.append("counter-1", 1, { amount: 2 }, counterCodec));
    assertEquals((await fs.readFile(path, "utf8")).trim().split("\n").length, 2);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("JSONL journal owns event codec failures", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const journal = await Effect.runPromise(
      makeJsonlJournal({
        pathFor: (id) => join(directory, `${id}.jsonl`),
      }).pipe(Effect.provide(platformLayer)),
    );
    const encodeFailure = await Effect.runPromise(
      Effect.flip(
        journal.append(
          "encode-failure",
          0,
          { amount: 1 },
          { ...counterCodec, encode: () => Effect.fail("encode failed") },
        ),
      ),
    );
    assertEquals(encodeFailure._tag, "JournalFailure");
    assert(encodeFailure._tag === "JournalFailure");
    assertEquals(encodeFailure.operation, "append");

    await Effect.runPromise(journal.append("decode-failure", 0, { amount: 1 }, counterCodec));
    const decodeFailure = await Effect.runPromise(
      Effect.flip(
        journal.replay("decode-failure", {
          ...counterCodec,
          decode: () => Effect.fail("decode failed"),
        }),
      ),
    );
    assertEquals(decodeFailure._tag, "JournalFailure");
    assert(decodeFailure._tag === "JournalFailure");
    assertEquals(decodeFailure.operation, "replay");
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
