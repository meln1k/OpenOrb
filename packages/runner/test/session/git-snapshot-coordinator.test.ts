import { assertEquals } from "@std/assert";
import { SessionGitSnapshot } from "@openorb/protocol/runner-api";
import { Deferred, Effect, Exit, type Scope } from "effect";
import { TestClock } from "effect/testing";

import { makeGitSnapshotCoordinator } from "@/src/session/git-snapshot-coordinator.ts";
import { sameGitSnapshotContents } from "@/src/session/git-snapshot.ts";

Deno.test("Git Snapshot boundaries schedule inspection immediately", async () => {
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const inspected = yield* Deferred.make<void>();
    const coordinator = yield* makeGitSnapshotCoordinator(
      Effect.sync(() => inspections++).pipe(
        Effect.andThen(Deferred.succeed(inspected, undefined)),
      ),
    );
    yield* coordinator.trigger;
    yield* Deferred.await(inspected);
    assertEquals(inspections, 1);
  }));
});

Deno.test("Git Snapshot heartbeat schedules inspection every 15 seconds", async () => {
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    yield* makeGitSnapshotCoordinator(
      Effect.sync(() => inspections++).pipe(Effect.asVoid),
    );
    yield* TestClock.adjust("14999 millis");
    assertEquals(inspections, 0);
    yield* TestClock.adjust("1 millis");
    yield* Effect.yieldNow;
    assertEquals(inspections, 1);
  }));
});

Deno.test("Git Snapshot inspections never overlap and coalesce pending work", async () => {
  let active = 0;
  let maximumActive = 0;
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const coordinator = yield* makeGitSnapshotCoordinator(
      Effect.gen(function* () {
        inspections++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        yield* Effect.sleep("20 seconds");
        active--;
      }),
    );
    yield* coordinator.trigger;
    yield* Effect.yieldNow;
    yield* coordinator.trigger;
    yield* coordinator.trigger;
    yield* TestClock.adjust("20 seconds");
    yield* Effect.yieldNow;
    assertEquals(inspections, 2);
    assertEquals(maximumActive, 1);
  }));
});

Deno.test("Git Snapshot run-end flush is awaited without stopping the heartbeat", async () => {
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const coordinator = yield* makeGitSnapshotCoordinator(
      Effect.sync(() => inspections++).pipe(Effect.asVoid),
    );
    const outcome = yield* coordinator.flush;
    assertEquals(Exit.isSuccess(outcome), true);
    assertEquals(inspections, 1);
    yield* TestClock.adjust("15 seconds");
    yield* Effect.yieldNow;
    assertEquals(inspections, 2);
  }));
});

Deno.test("Git Snapshot coordinator reports inspection failures and keeps processing", async () => {
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const coordinator = yield* makeGitSnapshotCoordinator(
      Effect.suspend(() => {
        inspections++;
        return inspections === 1 ? Effect.fail("unavailable") : Effect.void;
      }),
    );
    const failed = yield* coordinator.flush;
    const recovered = yield* coordinator.flush;

    assertEquals(Exit.isFailure(failed), true);
    assertEquals(Exit.isSuccess(recovered), true);
    assertEquals(inspections, 2);
  }));
});

Deno.test("Git Snapshot semantic equality ignores timestamp and stale metadata", () => {
  const first = gitSnapshot("2026-08-27T10:00:00Z", false);
  const later = gitSnapshot("2026-08-27T10:00:15Z", true);
  assertEquals(sameGitSnapshotContents(first, later), true);
  assertEquals(
    sameGitSnapshotContents(
      first,
      new SessionGitSnapshot({ ...later, completeness: "incomplete" }),
    ),
    false,
  );
});

function runWithTestClock(effect: Effect.Effect<void, never, Scope.Scope>) {
  return Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(TestClock.layer({}))),
  );
}

function gitSnapshot(generatedAt: string, stale: boolean): SessionGitSnapshot {
  return new SessionGitSnapshot({
    generatedAt,
    completeness: "complete",
    stale,
    truncated: false,
    sections: {
      staged: { files: [], patch: "", truncated: false },
      unstaged: {
        files: [{
          kind: "tracked",
          path: "src/main.ts",
          displayPath: "src/main.ts",
          status: "modified",
          diffState: "available",
        }],
        patch: "+changed\n",
        truncated: false,
      },
    },
  });
}
