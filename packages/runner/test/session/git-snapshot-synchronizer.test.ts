import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  GitAuthor,
  GitMutationRevision,
  ModelReference,
  ProjectId,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionGitReference,
  SessionGitSnapshot,
  SessionId,
  SessionRepositoryUrl,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";

import type { AgentEnvironment } from "@/src/environment/agent-environment.ts";
import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { makeGitSnapshotSynchronizer } from "@/src/session/git-snapshot-synchronizer.ts";
import type { RunnerSessionGitSnapshotState, RunnerSessionMetadata } from "@/src/session/store.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const METADATA: RunnerSessionMetadata = {
  id: SESSION_ID,
  definition: new RunnerSessionDefinition({
    workspaceId: Schema.decodeUnknownSync(WorkspaceId)(
      "01989d78-65ee-7f6a-a97e-0f16ad134c12",
    ),
    projectId: Schema.decodeUnknownSync(ProjectId)(
      "01989d78-65ee-7f6a-a97e-0f16ad134c11",
    ),
    repositoryUrl: Schema.decodeUnknownSync(SessionRepositoryUrl)(
      "https://github.com/meln1k/openorb-test-repo.git",
    ),
    ref: Schema.decodeUnknownSync(SessionGitReference)("main"),
    branchName: Schema.decodeUnknownSync(SessionGitReference)("openorb/snapshot-test"),
    gitAuthor: new GitAuthor({ name: "OpenOrb User", email: "user@example.com" }),
    initialPrompt: "Inspect the repository",
    model: Schema.decodeUnknownSync(ModelReference)("opencode-go/deepseek-v4-flash"),
    orbSize: "small",
  }),
  runnerId: Schema.decodeUnknownSync(RunnerId)(
    "01989d78-65ee-7f6a-a97e-0f16ad134c09",
  ),
  createdAt: Schema.decodeUnknownSync(RunnerSessionCreatedAt)("2026-08-27T12:00:00Z"),
  state: "running",
  checkoutState: "available",
  issues: [],
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
  stop: Effect.die("unexpected stop"),
};

Deno.test("Git Snapshot publication remains pending and retries separately", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  let attempts = 0;
  const correlations: string[] = [];
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: (correlationId) =>
      Effect.suspend(() => {
        attempts++;
        correlations.push(correlationId);
        return attempts === 1 ? Effect.fail("publication failed") : Effect.void;
      }),
  });

  await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  const pending = store.state;
  if (!pending) throw new Error("Expected a stored Git Snapshot.");
  assertEquals(pending.notificationPending, true);
  assertEquals(store.writes, 1);
  assertEquals(attempts, 0);

  await assertRejects(() => Effect.runPromise(synchronizer.publishPending("first-publication")));
  assertEquals(store.state?.notificationPending, true);
  assertEquals(store.writes, 1);

  await Effect.runPromise(synchronizer.publishPending("retry-publication"));
  assertEquals(store.state?.notificationPending, false);
  assertEquals(attempts, 2);
  assertEquals(store.writes, 2);
  assertEquals(correlations, ["first-publication", "retry-publication"]);

  await Effect.runPromise(synchronizer.publishPending("already-published"));
  assertEquals(attempts, 2);
  assertEquals(store.writes, 2);
});

Deno.test("unchanged Git contents advance staged mutation coverage", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: () => Effect.void,
  });

  const initial = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  const current = store.state;
  if (!current) throw new Error("Expected a stored Git Snapshot.");
  store.state = {
    ...current,
    mutationRevision: GitMutationRevision.make(1),
    notificationPending: false,
  };

  const covered = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  assertEquals(covered.generatedAt, initial.generatedAt);
  assertEquals(covered.sections, initial.sections);
  assertEquals(covered.mutationRevision, GitMutationRevision.make(1));
  assertEquals(store.state?.snapshot.mutationRevision, GitMutationRevision.make(1));
  assertEquals(store.state?.mutationRevision, GitMutationRevision.make(1));
  assertEquals(store.state?.notificationPending, true);
  assertEquals(store.writes, 2);
});

Deno.test("failed Git inspection retains useful data without advancing mutation coverage", async () => {
  const store = new MemoryGitSnapshotStore();
  const generation = new SnapshotGeneration();
  const synchronizer = makeGitSnapshotSynchronizer({
    sessionId: SESSION_ID,
    store,
    generate: generation.generate,
    publishUpdated: () => Effect.void,
  });

  const complete = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  const current = store.state;
  if (!current) throw new Error("Expected a stored Git Snapshot.");
  store.state = {
    ...current,
    mutationRevision: GitMutationRevision.make(2),
    notificationPending: false,
  };
  generation.fail = true;
  const stale = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  assertEquals(stale.generatedAt, complete.generatedAt);
  assertEquals(stale.branch, complete.branch);
  assertEquals(stale.head, complete.head);
  assertEquals(stale.sections, complete.sections);
  assertEquals(stale.completeness, "incomplete");
  assertEquals(stale.stale, true);
  assertStringIncludes(stale.message ?? "", "last saved snapshot");
  assertEquals(stale.mutationRevision, GitMutationRevision.make(0));
  assertEquals(store.state?.snapshot.mutationRevision, GitMutationRevision.make(0));
  assertEquals(store.state?.mutationRevision, GitMutationRevision.make(2));

  generation.fail = false;
  const recovered = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  assertEquals(recovered.completeness, "complete");
  assertEquals(recovered.stale, false);
  assertEquals(recovered.message, undefined);
  assertEquals(recovered.mutationRevision, GitMutationRevision.make(2));
  assertEquals(store.state?.mutationRevision, GitMutationRevision.make(2));
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

  const stale = await Effect.runPromise(synchronizer.refresh(ENVIRONMENT, METADATA));
  assertEquals(stale.completeness, "incomplete");
  assertEquals(stale.stale, true);
  assertEquals(stale.mutationRevision, GitMutationRevision.make(0));
  assertEquals(store.state?.mutationRevision, GitMutationRevision.make(0));
  assertEquals(stale.sections, {
    staged: { files: [], patch: "", truncated: false },
    unstaged: { files: [], patch: "", truncated: false },
  });
});

function completeSnapshot(generatedAt: string): SessionGitSnapshot {
  return new SessionGitSnapshot({
    generatedAt,
    branch: "openorb/snapshot-test",
    head: "0123456789abcdef0123456789abcdef01234567",
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
