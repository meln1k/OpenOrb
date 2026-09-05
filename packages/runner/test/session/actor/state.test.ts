import { assert, assertEquals } from "@std/assert";
import { Schema } from "effect";
import {
  GitAuthor,
  ProjectId,
  RunId,
  RunnerId,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";

import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import type { SessionEvent } from "@/src/session/actor/events.ts";
import {
  applySessionEvent,
  sessionMetadata,
  type SessionState,
} from "@/src/session/actor/state.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const RUN_ID = Schema.decodeUnknownSync(RunId)("01989d78-65ee-7f6a-a97e-0f16ad134c14");
const OTHER_RUN_ID = Schema.decodeUnknownSync(RunId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c16",
);
const FOLLOW_UP_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c15";
const RESUME_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c18";
const CHECKPOINT_FILE = "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c20.qcow2";
const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c09",
);
const definition = new RunnerSessionDefinition({
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("01989d78-65ee-7f6a-a97e-0f16ad134c12"),
  projectId: Schema.decodeUnknownSync(ProjectId)("01989d78-65ee-7f6a-a97e-0f16ad134c11"),
  repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
  ref: "main",
  branchName: "openorb/session-test",
  gitAuthor: new GitAuthor({ name: "OpenOrb User", email: "user@example.com" }),
  initialPrompt: "Inspect the repository",
  model: "opencode-go/deepseek-v4-flash",
  orbSize: "small",
});
const checkpoint = {
  file: CHECKPOINT_FILE,
  guestAssetBuildId: "02e784cb-e063-5138-b1c4-334e8a3307a9",
  compatibleVmm: ["qemu" as const],
};
const modelIssue = {
  category: "model" as const,
  severity: "failure" as const,
  message: "The model operation failed.",
  recovery: "none" as const,
};
const interruptedIssue = {
  category: "operation-uncertain" as const,
  severity: "failure" as const,
  message: "The operation was interrupted.",
  recovery: "start-clean-vm" as const,
};
const followUpIssue = {
  category: "operation-uncertain" as const,
  severity: "warning" as const,
  message: "Follow-up delivery is uncertain.",
  recovery: "none" as const,
};

Deno.test("session facts drive explicit run phases", () => {
  let state = applyAll([
    provisioningStarted(),
    { type: "checkout.updated", checkoutState: "available" },
  ]);
  assertEquals(state.phase, { _tag: "Provisioning" });

  state = applySessionEvent(state, {
    type: "run.requested",
    runId: RUN_ID,
    purpose: "initial",
    issues: [],
  })!;
  assertEquals(state.phase, {
    _tag: "StartingRun",
    runId: RUN_ID,
    purpose: "initial",
  });

  state = applySessionEvent(state, {
    type: "run.started",
    runId: RUN_ID,
    acceptedAt: "2026-08-17T12:15:00Z",
  })!;
  assertEquals(state.phase, {
    _tag: "Running",
    runId: RUN_ID,
    purpose: "initial",
    followUp: { _tag: "Idle" },
    abort: { _tag: "Idle" },
  });

  state = applyAll([
    { type: "follow-up.requested", runId: RUN_ID, followUpId: FOLLOW_UP_ID },
    {
      type: "follow-up.accepted",
      runId: RUN_ID,
      followUpId: FOLLOW_UP_ID,
      acceptedAt: "2026-08-17T12:20:00Z",
    },
    { type: "run.completed", runId: RUN_ID },
  ], state);

  assertEquals(state.phase, { _tag: "Ready" });
  assertEquals(sessionMetadata(state).state, "ready");
  assertEquals(state.data.lastAcceptedUserMessageAt, "2026-08-17T12:20:00Z");
});

Deno.test("stale correlated facts are harmless no-ops", () => {
  const running = applyAll([
    ...readyEvents(),
    { type: "run.requested", runId: RUN_ID, purpose: "prompt", issues: [] },
    { type: "run.started", runId: RUN_ID, acceptedAt: "2026-08-17T12:15:00Z" },
    { type: "follow-up.requested", runId: RUN_ID, followUpId: FOLLOW_UP_ID },
  ]);

  const afterStaleFacts = applyAll([
    { type: "run.start-failed", runId: OTHER_RUN_ID, issue: modelIssue },
    {
      type: "follow-up.failed",
      runId: OTHER_RUN_ID,
      followUpId: "01989d78-65ee-7f6a-a97e-0f16ad134c17",
      issue: followUpIssue,
    },
    { type: "abort.confirmed", runId: OTHER_RUN_ID },
    { type: "run.completed", runId: OTHER_RUN_ID },
    { type: "run.interrupted", runId: OTHER_RUN_ID, issue: interruptedIssue },
  ], running);

  assertEquals(afterStaleFacts, running);
});

Deno.test("failed follow-up delivery records an issue and leaves the run active", () => {
  const state = applyAll([
    ...readyEvents(),
    { type: "run.requested", runId: RUN_ID, purpose: "prompt", issues: [] },
    { type: "run.started", runId: RUN_ID, acceptedAt: "2026-08-17T12:15:00Z" },
    { type: "follow-up.requested", runId: RUN_ID, followUpId: FOLLOW_UP_ID },
    { type: "follow-up.failed", runId: RUN_ID, followUpId: FOLLOW_UP_ID, issue: followUpIssue },
  ]);

  assertEquals(state.phase, {
    _tag: "Running",
    runId: RUN_ID,
    purpose: "prompt",
    followUp: { _tag: "Idle" },
    abort: { _tag: "Idle" },
  });
  assertEquals(state.data.issues, [followUpIssue]);
});

Deno.test("initial run failure fails provisioning but prompt failure returns to ready", () => {
  const initialFailure = applyAll([
    provisioningStarted(),
    { type: "run.requested", runId: RUN_ID, purpose: "initial", issues: [] },
    { type: "run.start-failed", runId: RUN_ID, issue: modelIssue },
  ]);
  assertEquals(initialFailure.phase, { _tag: "Failed" });

  const promptFailure = applyAll([
    ...readyEvents(),
    { type: "run.requested", runId: RUN_ID, purpose: "prompt", issues: [] },
    { type: "run.start-failed", runId: RUN_ID, issue: modelIssue },
  ]);
  assertEquals(promptFailure.phase, { _tag: "Ready" });
});

Deno.test("checkpoint and wake recovery are explicit state transitions", () => {
  const checkpointing = applyAll([
    ...readyEvents(),
    { type: "checkpoint.started", file: CHECKPOINT_FILE },
  ]);
  assertEquals(checkpointing.phase, {
    _tag: "Checkpointing",
    file: CHECKPOINT_FILE,
  });

  const stopped = applySessionEvent(checkpointing, {
    type: "checkpoint.published",
    checkpoint,
  });
  assert(stopped);
  assertEquals(stopped.phase, { _tag: "Stopped", checkpoint });
  assertEquals(sessionMetadata(stopped).state, "stopped");

  const resuming = applySessionEvent(stopped, {
    type: "restoration.started",
    restorationId: RESUME_ID,
    intent: { _tag: "ResumeCheckpoint", continuation: { _tag: "Wake" } },
  });
  assert(resuming);
  assertEquals(resuming.phase, {
    _tag: "Restoring",
    restorationId: RESUME_ID,
    intent: { _tag: "ResumeCheckpoint", continuation: { _tag: "Wake" } },
    checkpoint,
  });

  const ready = applySessionEvent(resuming, {
    type: "restoration.completed",
    restorationId: RESUME_ID,
    issues: [],
  });
  assert(ready);
  assertEquals(ready.phase, { _tag: "Ready", checkpoint });
});

Deno.test("prompt recovery resumes directly into its durable run intent", () => {
  const stopped = applyAll([
    ...readyEvents(),
    { type: "checkpoint.started", file: CHECKPOINT_FILE },
    { type: "checkpoint.published", checkpoint },
  ]);
  const starting = applyAll([
    {
      type: "restoration.started",
      restorationId: RESUME_ID,
      intent: {
        _tag: "ResumeCheckpoint",
        continuation: { _tag: "Prompt", runId: RUN_ID },
      },
    },
    { type: "restoration.completed", restorationId: RESUME_ID, issues: [] },
  ], stopped);

  assertEquals(starting.phase, {
    _tag: "StartingRun",
    runId: RUN_ID,
    purpose: "prompt",
    checkpoint,
  });
});

Deno.test("clean VM recovery drops the prior root-disk checkpoint", () => {
  const failed = applyAll([
    ...readyEvents(),
    { type: "checkpoint.started", file: CHECKPOINT_FILE },
    { type: "checkpoint.published", checkpoint },
    {
      type: "restoration.started",
      restorationId: RESUME_ID,
      intent: { _tag: "ResumeCheckpoint", continuation: { _tag: "Wake" } },
    },
    { type: "restoration.completed", restorationId: RESUME_ID, issues: [] },
    {
      type: "actor.crashed",
      issue: interruptedIssue,
    },
  ]);
  assertEquals(failed.phase, { _tag: "Failed", checkpoint });

  const recovering = applyAll([
    {
      type: "restoration.started",
      restorationId: RESUME_ID,
      intent: { _tag: "StartCleanVm" },
    },
  ], failed);
  assertEquals(sessionMetadata(recovering).state, "provisioning");

  const ready = applyAll([
    { type: "restoration.completed", restorationId: RESUME_ID, issues: [] },
  ], recovering);

  assertEquals(ready.phase, { _tag: "Ready" });
  assertEquals(sessionMetadata(ready).checkpoint, undefined);
});

function readyEvents(): readonly SessionEvent[] {
  return [
    provisioningStarted(),
    { type: "checkout.updated", checkoutState: "available" },
    { type: "run.requested", runId: OTHER_RUN_ID, purpose: "initial", issues: [] },
    {
      type: "run.started",
      runId: OTHER_RUN_ID,
      acceptedAt: "2026-08-17T12:10:00Z",
    },
    { type: "run.completed", runId: OTHER_RUN_ID },
  ];
}

function applyAll(
  events: readonly SessionEvent[],
  initial?: SessionState,
): SessionState {
  let state: SessionState | undefined = initial;
  for (const event of events) state = applySessionEvent(state, event);
  assert(state);
  return state;
}

function provisioningStarted(): SessionEvent {
  return {
    type: "session.provisioning-started",
    id: SESSION_ID,
    definition,
    runnerId: RUNNER_ID,
    createdAt: "2026-08-17T12:00:00Z",
  };
}
