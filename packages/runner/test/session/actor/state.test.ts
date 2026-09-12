import { assert, assertEquals } from "@std/assert";
import { Effect, Logger, Schema } from "effect";
import {
  GitAuthor,
  ProjectId,
  RunId,
  RunnerId,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";

import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { makeSessionDecisions } from "../../../src/session/actor/decision.ts";
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
const OPERATION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c18";
const STOP_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c20";
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
const modelIssue = {
  category: "model" as const,
  severity: "warning" as const,
  message: "The model operation failed.",
  recovery: "none" as const,
};
const interruptedIssue = {
  category: "operation-uncertain" as const,
  severity: "failure" as const,
  message: "The operation was interrupted.",
  recovery: "restart-environment" as const,
};
const followUpIssue = {
  category: "operation-uncertain" as const,
  severity: "warning" as const,
  message: "Follow-up delivery is uncertain.",
  recovery: "none" as const,
};
const retryStopIssue = {
  category: "vm-stop" as const,
  severity: "warning" as const,
  message: "The session could not be stopped. Retry Stop.",
  recovery: "none" as const,
};
const restartEnvironmentIssue = {
  category: "vm-stop" as const,
  severity: "failure" as const,
  message: "Root-disk durability could not be confirmed.",
  recovery: "restart-environment" as const,
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
    issues: [],
  })!;
  assertEquals(state.phase, {
    _tag: "StartingRun",
    runId: RUN_ID,
  });

  state = applySessionEvent(state, {
    type: "run.started",
    runId: RUN_ID,
    acceptedAt: "2026-08-17T12:15:00Z",
  })!;
  assertEquals(state.phase, {
    _tag: "Running",
    runId: RUN_ID,
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
    { type: "run.requested", runId: RUN_ID, issues: [] },
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
    { type: "run.requested", runId: RUN_ID, issues: [] },
    { type: "run.started", runId: RUN_ID, acceptedAt: "2026-08-17T12:15:00Z" },
    { type: "follow-up.requested", runId: RUN_ID, followUpId: FOLLOW_UP_ID },
    { type: "follow-up.failed", runId: RUN_ID, followUpId: FOLLOW_UP_ID, issue: followUpIssue },
  ]);

  assertEquals(state.phase, {
    _tag: "Running",
    runId: RUN_ID,
    followUp: { _tag: "Idle" },
    abort: { _tag: "Idle" },
  });
  assertEquals(state.data.issues, [followUpIssue]);
});

for (const origin of ["provisioning", "ready"] as const) {
  for (const outcome of ["start-failed", "failed", "aborted"] as const) {
    Deno.test(`${origin} run ${outcome} returns to ready and accepts another prompt`, () => {
      const starting = applyAll([
        ...(origin === "provisioning" ? [provisioningStarted()] : readyEvents()),
        { type: "run.requested", runId: RUN_ID, issues: [] },
      ]);
      assertEquals(sessionMetadata(starting).state, "ready");
      const state = applyAll(
        outcome === "start-failed"
          ? [
            { type: "run.start-failed", runId: RUN_ID, issue: modelIssue },
          ]
          : [
            { type: "run.started", runId: RUN_ID, acceptedAt: "2026-08-17T12:15:00Z" },
            ...(outcome === "aborted"
              ? [
                { type: "abort.requested", runId: RUN_ID },
                { type: "abort.confirmed", runId: RUN_ID },
                { type: "run.completed", runId: RUN_ID },
              ] satisfies SessionEvent[]
              : [
                { type: "run.failed", runId: RUN_ID, issue: modelIssue },
              ] satisfies SessionEvent[]),
          ],
        starting,
      );
      assertEquals(state.phase, { _tag: "Ready" });
      assertEquals(state.data.issues, outcome === "aborted" ? [] : [modelIssue]);
      assertEquals(
        applySessionEvent(state, {
          type: "run.requested",
          runId: OTHER_RUN_ID,
          issues: [],
        })?.phase,
        { _tag: "StartingRun", runId: OTHER_RUN_ID },
      );
    });
  }
}

Deno.test("stop lifecycle transitions a running session to stopped", () => {
  const running = applyAll([
    ...readyEvents(),
    { type: "run.requested", runId: RUN_ID, issues: [] },
    { type: "run.started", runId: RUN_ID, acceptedAt: "2026-08-17T12:15:00Z" },
    { type: "issue.recorded", issue: retryStopIssue },
  ]);
  const stopping = applySessionEvent(running, { type: "stop.started", stopId: STOP_ID });
  assert(stopping);
  assertEquals(stopping.phase, { _tag: "Stopping", stopId: STOP_ID });
  assertEquals(stopping.data.issues, []);
  assertEquals(sessionMetadata(stopping).state, "ready");

  const stopped = applySessionEvent(stopping, { type: "stop.completed", stopId: STOP_ID });
  assert(stopped);
  assertEquals(stopped.phase, { _tag: "Stopped" });
  assertEquals(sessionMetadata(stopped).state, "stopped");
});

Deno.test("stop failure returns to ready while the environment remains available", () => {
  const stopping = applyAll([
    ...readyEvents(),
    { type: "stop.started", stopId: STOP_ID },
  ]);
  const ready = applySessionEvent(stopping, {
    type: "stop.failed",
    stopId: STOP_ID,
    environmentUsable: true,
    issue: retryStopIssue,
  });

  assert(ready);
  assertEquals(ready.phase, { _tag: "Ready" });
  assertEquals(ready.data.issues, [retryStopIssue]);
  assertEquals(sessionMetadata(ready).state, "ready");
});

Deno.test("stop failure enters failed after environment shutdown begins", () => {
  const stopping = applyAll([
    ...readyEvents(),
    { type: "stop.started", stopId: STOP_ID },
  ]);
  const failed = applySessionEvent(stopping, {
    type: "stop.failed",
    stopId: STOP_ID,
    environmentUsable: false,
    issue: restartEnvironmentIssue,
  });

  assert(failed);
  assertEquals(failed.phase, { _tag: "Failed" });
  assertEquals(failed.data.issues, [restartEnvironmentIssue]);
  assertEquals(sessionMetadata(failed).state, "error");
});

Deno.test("durable lifecycle logs wait for commit and omit issue diagnostics and session content", async () => {
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  const decisions = makeSessionDecisions();
  const secretIssue = {
    ...modelIssue,
    message: "secret-message",
    diagnostics: "secret-diagnostics",
  };
  const cases: readonly [SessionEvent, string][] = [
    [provisioningStarted(), "provision.accepted"],
    [{ type: "provisioning.failed", issue: secretIssue }, "provision.failed"],
    [{ type: "wake.started", wakeId: OPERATION_ID }, "wake.started"],
    [{ type: "wake.completed", wakeId: OPERATION_ID }, "wake.ready"],
    [{ type: "wake.failed", wakeId: OPERATION_ID, issue: secretIssue }, "wake.failed"],
    [
      {
        type: "restoration.started",
        restorationId: OPERATION_ID,
        continuation: { _tag: "Wake" },
      },
      "wake.started",
    ],
    [{ type: "restoration.completed", restorationId: OPERATION_ID, issues: [] }, "wake.ready"],
    [
      { type: "restoration.failed", restorationId: OPERATION_ID, issue: secretIssue },
      "wake.failed",
    ],
    [{ type: "restore.failed", issue: secretIssue }, "actor.restoration-failed"],
  ];
  const state = applyAll(readyEvents());
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      for (const [event, name] of cases) {
        const before = logs.length;
        const decision = decisions.persist(event);
        assertEquals(logs.length, before, "constructing a decision must not log acceptance");
        yield* decision.afterCommit(state);
        assertEquals(logs.at(-1)?.message, name);
        assertEquals(logs.at(-1)?.annotations, {
          component: "openorb-runner",
          sessionId: SESSION_ID,
          runnerId: RUNNER_ID,
          transition: event.type,
        });
      }
      yield* decisions.none().afterCommit(state);
      assertEquals(logs.length, cases.length);
    })).pipe(Effect.provide(Logger.layer([logger]))),
  );
  const encoded = JSON.stringify(logs);
  for (
    const forbidden of [
      "secret-message",
      "secret-diagnostics",
      definition.initialPrompt,
      definition.repositoryUrl,
    ]
  ) {
    assert(!encoded.includes(forbidden));
  }
  assert(logs.every((log) => log.cause === undefined));
});

function readyEvents(): readonly SessionEvent[] {
  return [
    provisioningStarted(),
    { type: "checkout.updated", checkoutState: "available" },
    { type: "run.requested", runId: OTHER_RUN_ID, issues: [] },
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
