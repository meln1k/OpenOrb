import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ModelReference,
  ProjectId,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionGitReference,
  SessionGitSnapshot,
  SessionId,
  SessionRepositoryUrl,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";

import type { AgentEnvironment } from "@/src/environment/agent-environment.ts";
import { makeGitSnapshotSynchronizer } from "@/src/session/git-snapshot-synchronizer.ts";
import type { RunnerSessionGitSnapshotState, RunnerSessionMetadata } from "@/src/session/store.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const METADATA: RunnerSessionMetadata = {
  version: 1,
  id: SESSION_ID,
  projectId: Schema.decodeUnknownSync(ProjectId)(
    "01989d78-65ee-7f6a-a97e-0f16ad134c11",
  ),
  runnerId: Schema.decodeUnknownSync(RunnerId)(
    "01989d78-65ee-7f6a-a97e-0f16ad134c09",
  ),
  createdAt: Schema.decodeUnknownSync(RunnerSessionCreatedAt)("2026-08-27T12:00:00Z"),
  repositoryUrl: Schema.decodeUnknownSync(SessionRepositoryUrl)(
    "https://github.com/meln1k/openorb.git",
  ),
  ref: Schema.decodeUnknownSync(SessionGitReference)("main"),
  branchName: Schema.decodeUnknownSync(SessionGitReference)("openorb/snapshot-test"),
  initialPrompt: "Inspect the repository",
  model: Schema.decodeUnknownSync(ModelReference)("opencode-go/deepseek-v4-flash"),
  orbSize: "small",
  state: "running",
  checkoutState: "available",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
};

class SnapshotGeneration {
  fail = false;

  readonly generate = () =>
    this.fail
      ? Effect.fail("Git inspection failed.")
      : Effect.succeed(completeSnapshot("2026-08-27T12:00:00Z"));
}

class MemoryGitSnapshotStore {
  state: RunnerSessionGitSnapshotState | undefined;
  writes = 0;

  readonly readGitSnapshotState = () =>
    this.state ? Effect.succeed(this.state) : Effect.fail("No Git Snapshot has been stored.");

  readonly writeGitSnapshotState = (
    _sessionId: typeof SessionId.Type,
    state: RunnerSessionGitSnapshotState,
  ) =>
    Effect.sync(() => {
      this.state = state;
      this.writes++;
    });
}

const ENVIRONMENT: AgentEnvironment = {
  run: () => Effect.die("unexpected run"),
  runShell: () => Effect.die("unexpected shell"),
  readFile: () => Effect.die("unexpected read"),
  access: () => Effect.die("unexpected access"),
  writeFile: () => Effect.die("unexpected write"),
  makeDirectory: () => Effect.die("unexpected directory"),
  detectImageMimeType: () => Effect.die("unexpected image detection"),
};

Deno.test("Git Snapshot publication remains pending and retries unchanged content", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  let attempts = 0;
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: () =>
      Effect.suspend(() => {
        attempts++;
        return attempts === 1 ? Effect.fail("publication failed") : Effect.void;
      }),
  });

  await assertRejects(() =>
    Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()))
  );
  const pending = store.state;
  if (!pending) throw new Error("Expected a stored Git Snapshot.");
  assertEquals(pending.notificationPending, true);
  assertEquals(store.writes, 1);

  const synchronized = await Effect.runPromise(
    synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()),
  );
  assertEquals(synchronized.generatedAt, pending.snapshot.generatedAt);
  assertEquals(store.state?.notificationPending, false);
  assertEquals(attempts, 2);
  assertEquals(store.writes, 2);
});

Deno.test("Git Snapshot refresh failures retain useful data and recovery clears stale state", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  let publications = 0;
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: () => Effect.sync(() => publications++).pipe(Effect.asVoid),
  });

  const complete = await Effect.runPromise(
    synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()),
  );
  generation.fail = true;
  const stale = await Effect.runPromise(
    synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()),
  );
  assertEquals(stale.generatedAt, complete.generatedAt);
  assertEquals(stale.sections, complete.sections);
  assertEquals(stale.completeness, "incomplete");
  assertEquals(stale.stale, true);
  assertStringIncludes(stale.message ?? "", "last saved snapshot");

  generation.fail = false;
  const recovered = await Effect.runPromise(
    synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()),
  );
  assertEquals(recovered.completeness, "complete");
  assertEquals(recovered.stale, false);
  assertEquals(recovered.message, undefined);
  assertEquals(publications, 3);
});

Deno.test("Git Snapshot refresh failure without prior data stores an empty stale snapshot", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  generation.fail = true;
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: () => Effect.void,
  });

  const stale = await Effect.runPromise(
    synchronizer.refresh(ENVIRONMENT, METADATA, crypto.randomUUID()),
  );
  assertEquals(stale.completeness, "incomplete");
  assertEquals(stale.stale, true);
  assertEquals(stale.sections, {
    staged: { files: [], patch: "", truncated: false },
    unstaged: { files: [], patch: "", truncated: false },
  });
});

function completeSnapshot(generatedAt: string): SessionGitSnapshot {
  return new SessionGitSnapshot({
    generatedAt,
    completeness: "complete",
    stale: false,
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
