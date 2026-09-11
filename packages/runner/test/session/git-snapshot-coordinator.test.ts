import { assertEquals } from "@std/assert";
import { GitMutationRevision, SessionGitSnapshot, SessionId } from "@openorb/protocol/runner-api";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";

import type { AgentEnvironment } from "@/src/environment/agent-environment.ts";
import {
  type GitFileUpdateAcceptance,
  type GitSnapshotCoordinator,
  makeGitSnapshotCoordinator,
} from "@/src/session/git-snapshot-coordinator.ts";
import type { GitSnapshotSynchronizer } from "@/src/session/git-snapshot-synchronizer.ts";
import { sameGitSnapshotContents } from "@/src/session/git-snapshot.ts";
import type { RunnerSessionMetadata } from "@/src/session/store.ts";

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10");
// SAFETY: Coordinator tests only pass the environment through to injected fakes.
const ENVIRONMENT = {} as AgentEnvironment;
// SAFETY: Coordinator tests only pass the metadata through to injected fakes.
const METADATA = {} as RunnerSessionMetadata;
const CONTEXT = {
  correlationId: "git-test",
  environment: ENVIRONMENT,
  metadata: METADATA,
};

Deno.test("Git Snapshot boundaries and heartbeat request coordinated refreshes", async () => {
  let inspections = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const coordinator = yield* makeCoordinator({
      refresh: () => Effect.sync(() => inspections++).pipe(Effect.as(gitSnapshot())),
    });

    yield* coordinator.boundaries.trigger;
    yield* waitForValue(() => inspections, 1);
    yield* TestClock.adjust("15 seconds");
    yield* waitForValue(() => inspections, 2);
  }));
});

Deno.test("Git mutations acknowledge before one coalesced snapshot", async () => {
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const mutationStarted = yield* Deferred.make<void>();
    const releaseMutation = yield* Deferred.make<void>();
    const snapshotStarted = yield* Deferred.make<void>();
    const releaseSnapshot = yield* Deferred.make<void>();
    let revisions = 0;
    let inspections = 0;
    const coordinator = yield* makeCoordinator({
      updateFile: () =>
        Deferred.succeed(mutationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseMutation)),
          Effect.as({ ok: true as const }),
        ),
      advanceMutationRevision: () => Effect.sync(() => GitMutationRevision.make(++revisions)),
      refresh: () => {
        inspections++;
        return Deferred.succeed(snapshotStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSnapshot)),
          Effect.as(gitSnapshot()),
        );
      },
    });

    const updates = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) =>
      Effect.forkChild(updateFile(coordinator, path), { startImmediately: true })
    );
    const fibers = yield* Effect.all(updates);
    yield* Deferred.await(mutationStarted);
    yield* Deferred.succeed(releaseMutation, undefined);
    yield* Deferred.await(snapshotStarted);
    assertEquals(yield* Effect.all(fibers.map(Fiber.join)), [
      { ok: true, mutationRevision: revision(1) },
      { ok: true, mutationRevision: revision(2) },
      { ok: true, mutationRevision: revision(3) },
    ]);
    assertEquals(inspections, 1);
    yield* Deferred.succeed(releaseSnapshot, undefined);
  }));
});

Deno.test("mutations arriving during a snapshot produce one unpublished intermediate and one trailing snapshot", async () => {
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const firstSnapshotStarted = yield* Deferred.make<void>();
    const releaseFirstSnapshot = yield* Deferred.make<void>();
    const secondSnapshotFinished = yield* Deferred.make<void>();
    let inspections = 0;
    let active = 0;
    let maximumActive = 0;
    let publications = 0;
    let revisions = 0;
    const coordinator = yield* makeCoordinator({
      advanceMutationRevision: () => Effect.sync(() => GitMutationRevision.make(++revisions)),
      refresh: () =>
        Effect.gen(function* () {
          inspections++;
          active++;
          maximumActive = Math.max(maximumActive, active);
          if (inspections === 1) {
            yield* Deferred.succeed(firstSnapshotStarted, undefined);
            yield* Deferred.await(releaseFirstSnapshot);
          }
          active--;
          if (inspections === 2) yield* Deferred.succeed(secondSnapshotFinished, undefined);
          return gitSnapshot();
        }),
      publishPending: () => Effect.sync(() => publications++).pipe(Effect.asVoid),
    });

    assertEquals(yield* updateFile(coordinator, "src/a.ts"), {
      ok: true,
      mutationRevision: revision(1),
    });
    yield* Deferred.await(firstSnapshotStarted);
    const second = yield* Effect.forkChild(updateFile(coordinator, "src/b.ts"), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseFirstSnapshot, undefined);
    assertEquals(yield* Fiber.join(second), { ok: true, mutationRevision: revision(2) });
    yield* Deferred.await(secondSnapshotFinished);
    yield* Effect.yieldNow;
    assertEquals(inspections, 2);
    assertEquals(maximumActive, 1);
    assertEquals(publications, 1);
  }));
});

Deno.test("quiesce closes refresh admission and waits for the final snapshot", async () => {
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const snapshotStarted = yield* Deferred.make<void>();
    const releaseSnapshot = yield* Deferred.make<void>();
    let inspections = 0;
    const coordinator = yield* makeCoordinator({
      refresh: () => {
        inspections++;
        return Deferred.succeed(snapshotStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSnapshot)),
          Effect.as(gitSnapshot()),
        );
      },
    });

    const stopped = yield* Effect.forkChild(coordinator.quiesce(CONTEXT), {
      startImmediately: true,
    });
    yield* Deferred.await(snapshotStarted);
    const heartbeat = yield* Deferred.make<void, unknown>();
    yield* coordinator.enqueueRefresh(CONTEXT, heartbeat);
    yield* Deferred.await(heartbeat).pipe(Effect.orDie);
    assertEquals(inspections, 1);

    yield* Deferred.succeed(releaseSnapshot, undefined);
    yield* Fiber.join(stopped).pipe(Effect.orDie);
    yield* TestClock.adjust("15 seconds");
    yield* Effect.yieldNow;
    assertEquals(inspections, 1);
  }));
});

Deno.test("Git Snapshot coordinator reports refresh failures and keeps processing", async () => {
  let inspections = 0;
  let issues = 0;
  await runWithTestClock(Effect.gen(function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const coordinator = yield* makeCoordinator({
      refresh: () => {
        inspections++;
        return inspections === 1 ? Effect.fail("unavailable") : Effect.succeed(gitSnapshot());
      },
      recordIssue: () => Effect.sync(() => issues++).pipe(Effect.asVoid),
    });
    const failed = yield* coordinator.boundaries.flush;
    const recovered = yield* coordinator.boundaries.flush;

    assertEquals(Exit.isFailure(failed), true);
    assertEquals(Exit.isSuccess(recovered), true);
    assertEquals(inspections, 2);
    assertEquals(issues, 1);
  }));
});

Deno.test("Git Snapshot semantic equality includes mutation coverage", () => {
  const first = gitSnapshot("2026-08-27T10:00:00Z", false, 1);
  const later = gitSnapshot("2026-08-27T10:00:15Z", true, 1);
  assertEquals(sameGitSnapshotContents(first, later), true);
  assertEquals(
    sameGitSnapshotContents(
      first,
      new SessionGitSnapshot({ ...later, completeness: "incomplete" }),
    ),
    false,
  );
  assertEquals(
    sameGitSnapshotContents(
      first,
      new SessionGitSnapshot({ ...later, mutationRevision: revision(2) }),
    ),
    false,
  );
});

interface CoordinatorOverrides {
  readonly updateFile?: () => Effect.Effect<{ readonly ok: true }>;
  readonly advanceMutationRevision?: () => Effect.Effect<GitMutationRevision, unknown>;
  readonly refresh?: GitSnapshotSynchronizer["refresh"];
  readonly publishPending?: GitSnapshotSynchronizer["publishPending"];
  readonly recordIssue?: (error: unknown) => Effect.Effect<void>;
}

function makeCoordinator(overrides: CoordinatorOverrides) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const coordinatorReady = yield* Deferred.make<GitSnapshotCoordinator>();
    let revision = 0;
    const requestRefresh = (wait: boolean) =>
      Effect.gen(function* () {
        const coordinator = yield* Deferred.await(coordinatorReady);
        const reply = yield* Deferred.make<void, unknown>();
        yield* coordinator.enqueueRefresh(CONTEXT, reply).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        if (wait) yield* Deferred.await(reply);
      });
    const coordinator = yield* makeGitSnapshotCoordinator({
      sessionId: SESSION_ID,
      advanceMutationRevision: overrides.advanceMutationRevision ??
        (() => Effect.sync(() => GitMutationRevision.make(++revision))),
      updateFile: overrides.updateFile ?? (() => Effect.succeed({ ok: true })),
      snapshots: {
        refresh: overrides.refresh ?? (() => Effect.succeed(gitSnapshot())),
        publishPending: overrides.publishPending ?? (() => Effect.void),
      },
      requestRefresh,
      recordIssue: overrides.recordIssue ?? (() => Effect.void),
    });
    yield* Deferred.succeed(coordinatorReady, coordinator);
    return coordinator;
  });
}

function updateFile(
  coordinator: GitSnapshotCoordinator,
  path: string,
): Effect.Effect<GitFileUpdateAcceptance, never, Scope.Scope> {
  return Effect.gen(function* (): Effect.fn.Return<
    GitFileUpdateAcceptance,
    never,
    Scope.Scope
  > {
    const reply = yield* Deferred.make<GitFileUpdateAcceptance>();
    yield* coordinator.enqueueMutation(
      { ...CONTEXT, correlationId: crypto.randomUUID() },
      { action: "stage", path },
      reply,
    );
    return yield* Deferred.await(reply);
  });
}

function runWithTestClock(effect: Effect.Effect<void, never, Scope.Scope>) {
  return Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(TestClock.layer({}))),
  );
}

function waitForValue(read: () => number, expected: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (read() !== expected) yield* Effect.yieldNow;
  });
}

function revision(value: number): GitMutationRevision {
  return GitMutationRevision.make(value);
}

function gitSnapshot(
  generatedAt = "2026-08-27T10:00:00Z",
  stale = false,
  mutationRevision = 0,
): SessionGitSnapshot {
  return new SessionGitSnapshot({
    mutationRevision: GitMutationRevision.make(mutationRevision),
    generatedAt,
    branch: "openorb/snapshot-test",
    head: "0123456789abcdef0123456789abcdef01234567",
    completeness: "complete",
    stale,
    truncated: false,
    sections: {
      staged: { files: [], patch: "", truncated: false },
      unstaged: { files: [], patch: "", truncated: false },
    },
  });
}
