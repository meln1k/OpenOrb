import { assertEquals } from "@std/assert";
import {
  GitAuthor,
  ProjectId,
  RunId,
  RunnerId,
  SessionId,
  UserId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";

import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import {
  projectSessionLifecycle,
  type SessionLifecycleEventEnvelope,
} from "@/src/session/lifecycle.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c09",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const USER_ID = Schema.decodeUnknownSync(UserId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const CREATED_AT = "2026-08-17T12:00:00Z";
const RUN_ID = Schema.decodeUnknownSync(RunId)("01989d78-65ee-7f6a-a97e-0f16ad134c13");

const definition = new RunnerSessionDefinition({
  userId: USER_ID,
  projectId: PROJECT_ID,
  repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
  ref: "main",
  branchName: "openorb/session-test",
  gitAuthor: new GitAuthor({ name: "OpenOrb User", email: "user@example.com" }),
  initialPrompt: "Inspect the repository",
  model: "opencode-go/deepseek-v4-flash",
  orbSize: "small",
});

Deno.test("session lifecycle events preserve independent state transitions in sequence", async () => {
  const events: SessionLifecycleEventEnvelope[] = [
    envelope(1, {
      type: "session.created",
      id: SESSION_ID,
      definition,
      runnerId: RUNNER_ID,
      createdAt: CREATED_AT,
    }),
    envelope(2, {
      type: "provisioning.updated",
      state: "ready",
      checkoutState: "available",
      baseCommit: "0123456789012345678901234567890123456789",
    }),
    envelope(3, {
      type: "run.started",
      runId: RUN_ID,
      acceptedAt: "2026-08-17T12:15:00Z",
    }),
    envelope(4, {
      type: "follow-up.accepted",
      runId: RUN_ID,
      acceptedAt: "2026-08-17T12:20:00Z",
    }),
    envelope(5, {
      type: "run.settled",
      runId: RUN_ID,
      startedBy: 3,
    }),
  ];

  const projection = await Effect.runPromise(projectSessionLifecycle(events));
  assertEquals(projection.sequence, 5);
  assertEquals(projection.metadata.state, "ready");
  assertEquals(projection.metadata.checkoutState, "available");
  assertEquals(projection.metadata.lastAcceptedUserMessageAt, "2026-08-17T12:20:00Z");
  assertEquals(projection.activeRun, undefined);
});

Deno.test("session lifecycle replay rejects gaps and mismatched checkpoint completions", async () => {
  const created = envelope(1, {
    type: "session.created",
    id: SESSION_ID,
    definition,
    runnerId: RUNNER_ID,
    createdAt: CREATED_AT,
  });
  const gap = await Effect.runPromise(Effect.flip(projectSessionLifecycle([
    created,
    envelope(3, { type: "session.state-changed", state: "ready" }),
  ])));
  assertEquals(gap._tag, "SessionLifecycleProjectionError");

  const mismatch = await Effect.runPromise(Effect.flip(projectSessionLifecycle([
    created,
    envelope(2, { type: "session.state-changed", state: "ready" }),
    envelope(3, {
      type: "checkpoint.started",
      file: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c20.qcow2",
    }),
    envelope(4, { type: "checkpoint.failed", startedBy: 2, consumed: false }),
  ])));
  assertEquals(mismatch._tag, "SessionLifecycleProjectionError");
});

function envelope(
  sequence: number,
  event: SessionLifecycleEventEnvelope["event"],
): SessionLifecycleEventEnvelope {
  return { version: 1, sequence, event };
}
