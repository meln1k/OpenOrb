import { assert, assertEquals, assertThrows } from "@std/assert";

import {
  MAX_SESSION_EVENT_TEXT_BYTES,
  modelReference,
  ORB_SIZE_RESOURCES,
  ORB_SIZES,
  parseModelReference,
  parseRunnerClientMessage,
  parseRunnerServerMessage,
  type SessionEventMessage,
  type SessionEventReplayCommand,
  type SessionEventReplayResultMessage,
  type SessionPromptAcceptedMessage,
  type SessionPromptCommand,
  type SessionPromptRejectedMessage,
  type SessionProvisionAcceptedMessage,
  type SessionProvisionCommand,
} from "@/src/index.ts";

const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "model-provider-key" },
};

Deno.test("defines the fixed orb provisioning sizes", () => {
  assertEquals(ORB_SIZES, ["tiny", "small", "medium", "large", "xxlarge"]);
  assertEquals(ORB_SIZE_RESOURCES, {
    tiny: { cpuCount: 1, memoryMiB: 2048 },
    small: { cpuCount: 2, memoryMiB: 4096 },
    medium: { cpuCount: 4, memoryMiB: 8192 },
    large: { cpuCount: 8, memoryMiB: 16_384 },
    xxlarge: { cpuCount: 16, memoryMiB: 32_768 },
  });
});

Deno.test("treats provider and model as one reference split only at the first slash", () => {
  const reference = modelReference("openai", "organization/model/version");

  assertEquals(reference, "openai/organization/model/version");
  assertEquals(parseModelReference(reference), {
    providerId: "openai",
    modelId: "organization/model/version",
  });
});

Deno.test("validates provisioning commands, acknowledgements, and events", () => {
  const command = {
    version: 1,
    id: "provision-1",
    type: "session.provision",
    sessionId: SESSION_ID,
    payload: {
      mode: "create",
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/session-1234",
      orbSize: "medium",
      initialPrompt: "Inspect the repository",
      modelRuntime: MODEL_RUNTIME,
      githubToken: "github-token",
    },
  } satisfies SessionProvisionCommand;
  const parsedCommand = parseRunnerServerMessage(command);
  assert(parsedCommand.type === "session.provision");
  assertEquals(parsedCommand.payload, command.payload);

  const accepted = {
    version: 1,
    id: "accepted-1",
    type: "session.provision.accepted",
    sessionId: SESSION_ID,
    correlationId: command.id,
    payload: {
      session: {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        createdAt: "2026-08-17T12:00:00Z",
        initialPromptPreview: "Inspect the repository",
        model: "opencode-go/deepseek-v4-flash",
        orbSize: "medium",
        state: "created",
        lastEventCursor: 0,
      },
      ref: "main",
      branchName: "openorb/session-1234",
      checkoutState: "pending",
    },
  } satisfies SessionProvisionAcceptedMessage;
  const parsedAccepted = parseRunnerClientMessage(accepted);
  assert(parsedAccepted.type === "session.provision.accepted");
  assertEquals(parsedAccepted.payload, accepted.payload);

  const event = {
    version: 1,
    id: "event-1",
    type: "session.event",
    sessionId: SESSION_ID,
    correlationId: command.id,
    payload: {
      event: {
        type: "session.state",
        stage: "cloning",
        checkoutState: "pending",
      },
    },
  } satisfies SessionEventMessage;
  const parsedEvent = parseRunnerClientMessage(event);
  assert(parsedEvent.type === "session.event");
  assertEquals(parsedEvent.payload, event.payload);

  const compactedEvent = {
    version: 1,
    id: "event-2",
    type: "session.event",
    sessionId: SESSION_ID,
    correlationId: command.id,
    payload: {
      cursor: 1,
      event: {
        type: "context.compacted",
        compactionId: "compaction-1",
        summary: "Inspected the repository.",
        tokensBefore: 42_000,
        usage: {
          inputTokens: 2_000,
          outputTokens: 200,
          cacheReadTokens: 100,
          cacheWriteTokens: 0,
          totalTokens: 2_300,
          totalCost: 0.01,
        },
      },
    },
  } satisfies SessionEventMessage;
  const parsedCompactedEvent = parseRunnerClientMessage(compactedEvent);
  assert(parsedCompactedEvent.type === "session.event");
  assertEquals(parsedCompactedEvent.payload, compactedEvent.payload);

  const replay = {
    version: 1,
    id: "replay-1",
    type: "session.event.replay",
    sessionId: SESSION_ID,
    payload: { afterCursor: 7 },
  } satisfies SessionEventReplayCommand;
  const parsedReplay = parseRunnerServerMessage(replay);
  assert(parsedReplay.type === "session.event.replay");
  assertEquals(parsedReplay.payload, replay.payload);

  const replayResult = {
    version: 1,
    id: "replay-result-1",
    type: "session.event.replay.result",
    sessionId: SESSION_ID,
    correlationId: replay.id,
    payload: { status: "completed", cursor: 9 },
  } satisfies SessionEventReplayResultMessage;
  const parsedReplayResult = parseRunnerClientMessage(replayResult);
  assert(parsedReplayResult.type === "session.event.replay.result");
  assertEquals(parsedReplayResult.payload, replayResult.payload);

  const retry = parseRunnerServerMessage({
    ...command,
    id: "retry-1",
    payload: { mode: "retry", modelRuntime: MODEL_RUNTIME },
  });
  assert(retry.type === "session.provision");
  assertEquals(retry.payload, { mode: "retry", modelRuntime: MODEL_RUNTIME });
});

Deno.test("rejects malformed or oversized provisioning traffic", () => {
  const command = {
    version: 1,
    id: "provision-1",
    type: "session.provision",
    sessionId: SESSION_ID,
    payload: {
      mode: "create",
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/session-1234",
      orbSize: "medium",
      initialPrompt: "Inspect the repository",
      modelRuntime: MODEL_RUNTIME,
    },
  };

  assertThrows(() =>
    parseRunnerServerMessage({
      ...command,
      payload: { ...command.payload, repositoryUrl: "https://example.com/repository.git" },
    })
  );
  assertThrows(() =>
    parseRunnerServerMessage({
      ...command,
      payload: { ...command.payload, branchName: "--upload-pack=host-command" },
    })
  );
  assertThrows(() =>
    parseRunnerServerMessage({
      ...command,
      payload: { ...command.payload, initialPrompt: "x".repeat(32 * 1024 + 1) },
    })
  );
  assertThrows(() =>
    parseRunnerServerMessage({
      ...command,
      payload: { ...command.payload, orbSize: "enormous" },
    })
  );
  const { orbSize: _orbSize, ...missingOrbSize } = command.payload;
  assertThrows(() => parseRunnerServerMessage({ ...command, payload: missingOrbSize }));
  for (
    const modelRuntime of [
      { ...MODEL_RUNTIME, model: "invalid" },
      { ...MODEL_RUNTIME, thinkingLevel: "invalid" },
      { ...MODEL_RUNTIME, credential: { type: "api_key", value: "" } },
    ]
  ) {
    assertThrows(() =>
      parseRunnerServerMessage({
        ...command,
        payload: { ...command.payload, modelRuntime },
      })
    );
  }
  assertThrows(() =>
    parseRunnerClientMessage({
      version: 1,
      id: "accepted-1",
      type: "session.provision.accepted",
      sessionId: SESSION_ID,
      correlationId: "provision-1",
      payload: {
        session: {
          id: crypto.randomUUID(),
          projectId: PROJECT_ID,
          createdAt: "2026-08-17T12:00:00Z",
          initialPromptPreview: "Inspect the repository",
          model: "opencode-go/deepseek-v4-flash",
          orbSize: "medium",
          state: "created",
          lastEventCursor: 0,
        },
        ref: "main",
        branchName: "openorb/session-1234",
        checkoutState: "pending",
      },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      version: 1,
      id: "event-1",
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: "provision-1",
      payload: {
        event: {
          type: "provisioning.log",
          stream: "stdout",
          text: "x".repeat(MAX_SESSION_EVENT_TEXT_BYTES + 1),
        },
      },
    })
  );
  for (
    const payload of [
      {
        event: {
          type: "model.retry.started",
          attempt: Number.POSITIVE_INFINITY,
          maxAttempts: 3,
          delayMs: 100,
          errorMessage: "Provider unavailable",
        },
      },
      {
        cursor: 1,
        event: { type: "agent.started" },
      },
      {
        event: { type: "agent.started", unexpected: true },
      },
    ]
  ) {
    assertThrows(() =>
      parseRunnerClientMessage({
        version: 1,
        id: "live-event-1",
        type: "session.event",
        sessionId: SESSION_ID,
        correlationId: "provision-1",
        payload,
      })
    );
  }
});

Deno.test("validates continuation prompt commands and acknowledgements", () => {
  const command = {
    version: 1,
    id: "prompt-1",
    type: "session.prompt",
    sessionId: SESSION_ID,
    payload: {
      prompt: "Continue with the implementation",
      modelRuntime: MODEL_RUNTIME,
    },
  } satisfies SessionPromptCommand;
  const parsedCommand = parseRunnerServerMessage(command);
  assert(parsedCommand.type === "session.prompt");
  assertEquals(parsedCommand.payload, command.payload);

  const accepted = {
    version: 1,
    id: "prompt-accepted-1",
    type: "session.prompt.accepted",
    sessionId: SESSION_ID,
    correlationId: command.id,
    payload: {},
  } satisfies SessionPromptAcceptedMessage;
  const parsedAccepted = parseRunnerClientMessage(accepted);
  assert(parsedAccepted.type === "session.prompt.accepted");
  assertEquals(parsedAccepted.payload, {});

  const rejected = {
    version: 1,
    id: "prompt-rejected-1",
    type: "session.prompt.rejected",
    sessionId: SESSION_ID,
    correlationId: command.id,
    payload: { message: "The session is busy." },
  } satisfies SessionPromptRejectedMessage;
  const parsedRejected = parseRunnerClientMessage(rejected);
  assert(parsedRejected.type === "session.prompt.rejected");
  assertEquals(parsedRejected.payload, rejected.payload);
});

Deno.test("rejects malformed or oversized continuation prompt traffic", () => {
  const command = {
    version: 1,
    id: "prompt-1",
    type: "session.prompt",
    sessionId: SESSION_ID,
    payload: {
      prompt: "Continue",
      modelRuntime: MODEL_RUNTIME,
    },
  };

  for (const prompt of ["   ", "x".repeat(32 * 1024 + 1)]) {
    assertThrows(() =>
      parseRunnerServerMessage({
        ...command,
        payload: { ...command.payload, prompt },
      })
    );
  }
  assertThrows(() =>
    parseRunnerServerMessage({
      ...command,
      payload: { ...command.payload, unexpected: true },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      version: 1,
      id: "prompt-accepted-1",
      type: "session.prompt.accepted",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: { unexpected: true },
    })
  );
  for (const message of ["", "x".repeat(1001)]) {
    assertThrows(() =>
      parseRunnerClientMessage({
        version: 1,
        id: "prompt-rejected-1",
        type: "session.prompt.rejected",
        sessionId: SESSION_ID,
        correlationId: command.id,
        payload: { message },
      })
    );
  }
});
