import { assert, assertEquals } from "@std/assert";

import { parseRunnerServerMessage } from "@openorb/protocol";
import { err, ok } from "@openorb/result";
import { SessionCatalogPersistenceError } from "@/app/data/session-catalog-repository.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const USER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c01";
const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c02";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c03";
const SECOND_SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c05";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c04";
const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;
const INITIAL_PROMPT = "Inspect the repository";
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "model-provider-key" },
};

Deno.test("requests Pi replay for each subscriber and relays only subsequent live events", async () => {
  let reconciliationCalls = 0;
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries(_userId, entries) {
      reconciliationCalls++;
      return Promise.resolve(ok({
        acceptedSessionIds: entries.map((entry) => entry.id),
        tombstonedSessionIds: [],
        rejected: [],
      }));
    },
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway);

    const commandFrame = nextMessage(socket);
    const provisioning = gateway.provisionSession({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_ID,
      payload: {
        mode: "create",
        projectId: PROJECT_ID,
        repositoryUrl: "https://github.com/meln1k/openorb.git",
        ref: "main",
        branchName: "openorb/session-test",
        orbSize: "medium",
        initialPrompt: INITIAL_PROMPT,
        modelRuntime: MODEL_RUNTIME,
        githubToken: "memory-only-token",
      },
    });
    const command = parseRunnerServerMessage(JSON.parse(await commandFrame));
    assert(command.type === "session.provision");
    assertEquals(command.payload.mode, "create");
    assertEquals(gateway.getSessionRunner(USER_ID, SESSION_ID), null);
    assertEquals(reconciliationCalls, 1);

    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.provision.accepted",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        session: sessionSnapshot(),
        ref: "main",
        branchName: "openorb/session-test",
        checkoutState: "pending",
      },
    }));
    assertEquals((await provisioning).status, "accepted");
    assertEquals(gateway.getSessionRunner(USER_ID, SESSION_ID), RUNNER_ID);
    assertEquals(reconciliationCalls, 2);

    const receivedEvents: number[] = [];
    const receivedLiveEvents: string[] = [];
    const replayCommandFrame = nextMessage(socket);
    const subscription = gateway.subscribeToSessionEvents(
      USER_ID,
      SESSION_ID,
      0,
      (event) => {
        if ("cursor" in event) receivedEvents.push(event.cursor);
        else receivedLiveEvents.push(event.event.type);
      },
    );
    const replayCommand = parseRunnerServerMessage(JSON.parse(await replayCommandFrame));
    assert(replayCommand.type === "session.event.replay");
    assertEquals(replayCommand.payload, { afterCursor: 0 });

    // Live traffic that predates the Pi snapshot is discarded rather than merged with replay.
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        event: {
          type: "assistant.text.delta",
          delta: "stale",
        },
      },
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: replayCommand.id,
      payload: { event: { type: "conversation.reset" } },
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: replayCommand.id,
      payload: {
        cursor: 1,
        event: {
          type: "user.message",
          messageId: "pi:user:1",
          text: INITIAL_PROMPT,
        },
      },
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event.replay.result",
      sessionId: SESSION_ID,
      correlationId: replayCommand.id,
      payload: { status: "completed", cursor: 1 },
    }));
    await subscription.replay;
    assertEquals(receivedEvents, [1]);
    assertEquals(receivedLiveEvents, ["conversation.reset"]);

    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        event: { type: "session.state", stage: "cloning", checkoutState: "pending" },
      },
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        event: {
          type: "assistant.text.delta",
          delta: "Hello",
        },
      },
    }));
    await waitFor(() => receivedLiveEvents.length === 3);
    assertEquals(receivedEvents, [1]);
    assertEquals(receivedLiveEvents, [
      "conversation.reset",
      "session.state",
      "assistant.text.delta",
    ]);
    subscription.unsubscribe();

    const secondReplayCommandFrame = nextMessage(socket);
    const secondReplayEvents: number[] = [];
    const replay = gateway.subscribeToSessionEvents(USER_ID, SESSION_ID, 1, (event) => {
      if ("cursor" in event) secondReplayEvents.push(event.cursor);
    });
    const secondReplayCommand = parseRunnerServerMessage(
      JSON.parse(await secondReplayCommandFrame),
    );
    assert(secondReplayCommand.type === "session.event.replay");
    assertEquals(secondReplayCommand.payload, { afterCursor: 1 });
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event",
      sessionId: SESSION_ID,
      correlationId: secondReplayCommand.id,
      payload: {
        cursor: 2,
        event: { type: "user.message", messageId: "pi:user:2", text: "Continue" },
      },
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.event.replay.result",
      sessionId: SESSION_ID,
      correlationId: secondReplayCommand.id,
      payload: { status: "completed", cursor: 2 },
    }));
    await replay.replay;
    assertEquals(secondReplayEvents, [2]);
    assertEquals(gateway.getSessionSnapshot(USER_ID, SESSION_ID)?.state, "provisioning");

    socket.close();
    await waitFor(() => gateway.getSessionRunner(USER_ID, SESSION_ID) === null);
    assertEquals(replay.signal.aborted, true);
    assertEquals(gateway.getSessionSnapshot(USER_ID, SESSION_ID), null);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("catalog failure rejects acceptance before installing the session route", async () => {
  let reconciliationCalls = 0;
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries(_userId, entries) {
      reconciliationCalls++;
      if (entries.length > 0) {
        return Promise.resolve(err(new SessionCatalogPersistenceError("database unavailable")));
      }
      return Promise.resolve(ok({
        acceptedSessionIds: [],
        tombstonedSessionIds: [],
        rejected: [],
      }));
    },
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway);
    const commandFrame = nextMessage(socket);
    const provisioning = gateway.provisionSession(provisionInput(SESSION_ID));
    const command = parseRunnerServerMessage(JSON.parse(await commandFrame));
    assert(command.type === "session.provision");

    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.provision.accepted",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        session: sessionSnapshot(),
        ref: "main",
        branchName: "openorb/session-test",
        checkoutState: "pending",
      },
    }));

    assertEquals(await provisioning, {
      status: "unavailable",
      message: "The runner accepted the session, but its catalog entry could not be created.",
    });
    assertEquals(reconciliationCalls, 2);
    assertEquals(gateway.getSessionRunner(USER_ID, SESSION_ID), null);
    assertEquals(gateway.getSessionSnapshot(USER_ID, SESSION_ID), null);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("rejects an orb size that exceeds the runner's advertised capacity", async () => {
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries: (_userId, entries) =>
      Promise.resolve(ok({
        acceptedSessionIds: entries.map((entry) => entry.id),
        tombstonedSessionIds: [],
        rejected: [],
      })),
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway);
    const input = provisionInput(SESSION_ID);
    const result = await gateway.provisionSession({
      ...input,
      payload: { ...input.payload, orbSize: "large" },
    });

    assertEquals(result, {
      status: "unavailable",
      message: "Runner cannot provision the large orb size.",
    });
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 0);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("times out unacknowledged provisioning and releases reserved capacity", async () => {
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries: (_userId, entries) =>
      Promise.resolve(ok({
        acceptedSessionIds: entries.map((entry) => entry.id),
        tombstonedSessionIds: [],
        rejected: [],
      })),
  }, { provisionAcceptanceTimeoutMs: 20 });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway);
    const commandFrame = nextMessage(socket);
    const result = gateway.provisionSession({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_ID,
      payload: {
        mode: "create",
        projectId: PROJECT_ID,
        repositoryUrl: "https://github.com/meln1k/openorb.git",
        ref: "main",
        branchName: "openorb/session-test",
        orbSize: "medium",
        initialPrompt: INITIAL_PROMPT,
        modelRuntime: MODEL_RUNTIME,
      },
    });
    await commandFrame;
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 1);
    assertEquals((await result).status, "unavailable");
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 0);
    assertEquals(gateway.getSessionRunner(USER_ID, SESSION_ID), null);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("times out while accepted provisioning waits for catalog persistence", async () => {
  const catalogWriteStarted = Promise.withResolvers<void>();
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries(_userId, entries) {
      if (entries.length === 0) {
        return Promise.resolve(ok({
          acceptedSessionIds: [],
          tombstonedSessionIds: [],
          rejected: [],
        }));
      }
      catalogWriteStarted.resolve();
      return new Promise(() => {});
    },
  }, { provisionAcceptanceTimeoutMs: 20 });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway);
    const commandFrame = nextMessage(socket);
    const result = gateway.provisionSession(provisionInput(SESSION_ID));
    const command = parseRunnerServerMessage(JSON.parse(await commandFrame));
    assert(command.type === "session.provision");

    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "session.provision.accepted",
      sessionId: SESSION_ID,
      correlationId: command.id,
      payload: {
        session: sessionSnapshot(),
        ref: "main",
        branchName: "openorb/session-test",
        checkoutState: "pending",
      },
    }));

    await catalogWriteStarted.promise;
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 1);
    assertEquals(await result, {
      status: "unavailable",
      message: "Runner did not acknowledge provisioning in time.",
    });
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 0);
    assertEquals(gateway.getSessionRunner(USER_ID, SESSION_ID), null);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("an in-flight create reserves capacity across runner heartbeats", async () => {
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    reconcileSessionManifestEntries: (_userId, entries) =>
      Promise.resolve(ok({
        acceptedSessionIds: entries.map((entry) => entry.id),
        tombstonedSessionIds: [],
        rejected: [],
      })),
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await connectRunner(server.baseUrl);
    await publishEmptySessionManifest(socket, gateway, 1);
    const commandFrame = nextMessage(socket);
    const first = gateway.provisionSession(provisionInput(SESSION_ID));
    await commandFrame;
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 1);

    const heartbeatBefore = gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.lastHeartbeatAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 2));
    socket.send(JSON.stringify(heartbeatMessage(1, 0)));
    await waitFor(() =>
      (gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.lastHeartbeatAt ?? 0) > heartbeatBefore
    );
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity.activeSessions, 1);
    const second = await gateway.provisionSession(provisionInput(SECOND_SESSION_ID));
    assertEquals(second, {
      status: "unavailable",
      message: "Runner has reached its concurrent session limit.",
    });

    socket.close();
    assertEquals((await first).status, "unavailable");
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

async function connectRunner(baseUrl: URL): Promise<WebSocket> {
  const url = new URL(baseUrl);
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true,
    });
  });
  const connected = nextMessage(socket);
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.hello",
    payload: { token: RUNNER_TOKEN },
  }));
  await connected;
  return socket;
}

async function publishEmptySessionManifest(
  socket: WebSocket,
  gateway: RunnerConnectionGateway,
  maxConcurrentSessions = 2,
): Promise<void> {
  const manifestId = crypto.randomUUID();
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.session-sync.start",
    payload: { manifestId },
  }));
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.session-sync.complete",
    payload: { manifestId, chunkCount: 0, sessionCount: 0 },
  }));
  socket.send(JSON.stringify(heartbeatMessage(maxConcurrentSessions, 0)));
  await waitFor(() => gateway.getRunnerLiveState(USER_ID, RUNNER_ID) !== null);
}

function provisionInput(sessionId: string) {
  return {
    userId: USER_ID,
    runnerId: RUNNER_ID,
    sessionId,
    payload: {
      mode: "create" as const,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/session-test",
      orbSize: "medium" as const,
      initialPrompt: INITIAL_PROMPT,
      modelRuntime: MODEL_RUNTIME,
    },
  };
}

function heartbeatMessage(maxConcurrentSessions: number, activeSessions: number) {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.heartbeat",
    payload: {
      observedAt: Date.now(),
      capacity: {
        maxConcurrentSessions,
        activeSessions,
        vmCpuCount: 4,
        vmMemoryMiB: 8192,
        diskFreeMiB: 20_480,
      },
    },
  };
}

function sessionSnapshot() {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    createdAt: "2026-08-17T12:00:00Z",
    initialPromptPreview: INITIAL_PROMPT,
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "medium" as const,
    state: "created" as const,
    lastEventCursor: 0,
  };
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket message failed.")), {
      once: true,
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for gateway state.");
}
