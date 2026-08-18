import { assert, assertEquals, assertThrows } from "@std/assert";

import {
  parseRunnerClientMessage,
  parseRunnerServerMessage,
  type SessionEventMessage,
  type SessionProvisionAcceptedMessage,
  type SessionProvisionCommand,
} from "@/src/index.ts";

const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";

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
      initialPrompt: "Inspect the repository",
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
      cursor: 1,
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

  const retry = parseRunnerServerMessage({
    ...command,
    id: "retry-1",
    payload: { mode: "retry" },
  });
  assert(retry.type === "session.provision");
  assertEquals(retry.payload, { mode: "retry" });
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
      initialPrompt: "Inspect the repository",
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
        cursor: 1,
        event: {
          type: "provisioning.log",
          stream: "stdout",
          text: "x".repeat(16 * 1024 + 1),
        },
      },
    })
  );
});
