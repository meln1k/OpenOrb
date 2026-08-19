import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseRunnerClientMessage } from "@openorb/protocol";
import type { Result } from "@openorb/result";

import { enrollRunner } from "@/src/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "@/src/identity.ts";
import { parseRunnerCommand } from "@/src/options.ts";
import {
  maintainRunnerConnection,
  reconnectDelayMs,
  RUNNER_HEARTBEAT_INTERVAL_MS,
} from "@/src/connection.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const ENROLLMENT_PSK = `openorb_enroll_${"a".repeat(43)}`;
const RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;

Deno.test("uses a ten-second runner heartbeat interval", () => {
  assertEquals(RUNNER_HEARTBEAT_INTERVAL_MS, 10_000);
});

Deno.test("parses first-start enrollment options without accepting a data directory", () => {
  const expected = {
    type: "start" as const,
    options: {
      controlPanel: "https://openorb.example.com",
      enrollmentToken: ENROLLMENT_PSK,
      name: "Home runner",
    },
  };
  assertEquals(
    parseRunnerCommand([
      "--control-panel",
      "https://openorb.example.com",
      "--enrollment-token",
      ENROLLMENT_PSK,
      "--name",
      "Home runner",
      "--vm-cpu-count",
      "8",
      "--vm-memory-mib",
      "16384",
      "--max-concurrent-sessions",
      "3",
    ]),
    {
      ...expected,
      options: {
        ...expected.options,
        maxConcurrentSessions: 3,
        vmCpuCount: 8,
        vmMemoryMiB: 16_384,
      },
    },
  );
  assertEquals(
    parseRunnerCommand([
      "--control-panel=https://openorb.example.com",
      `--enrollment-token=${ENROLLMENT_PSK}`,
      "--name=Home runner",
    ]),
    expected,
  );
  assertThrows(
    () => parseRunnerCommand(["--data-dir", "/tmp/openorb"]),
    Error,
    "--data-dir is not supported",
  );
  assertEquals(
    assertThrows(() => parseRunnerCommand(["--unknown", ENROLLMENT_PSK]), Error).message,
    "Unknown argument.",
  );
  assertThrows(
    () => parseRunnerCommand(["--control-panel"]),
    Error,
    "--control-panel requires a value",
  );
  assertThrows(
    () => parseRunnerCommand(["--max-concurrent-sessions", "0"]),
    Error,
    "--max-concurrent-sessions must be a positive integer",
  );
  assertThrows(
    () => parseRunnerCommand(["--vm-memory-mib", "4.5"]),
    Error,
    "--vm-memory-mib must be a positive integer",
  );
});

Deno.test("enrolls with the PSK but accepts only a validated runner-token response", async () => {
  let received: unknown;
  const enrolled = success(
    await enrollRunner({
      controlPanelUrl: "https://openorb.example.com",
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
      capabilities: ["heartbeat"],
      fetch(_input, init) {
        received = JSON.parse(String(init?.body));
        return Promise.resolve(
          Response.json({ runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN }, { status: 201 }),
        );
      },
    }),
  );
  assertEquals(received, {
    enrollmentPsk: ENROLLMENT_PSK,
    name: "Home runner",
    architecture: "arm64",
    capabilities: ["heartbeat"],
  });
  assertEquals(enrolled, { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN });

  const enrollmentError = failure(
    await enrollRunner({
      controlPanelUrl: "https://openorb.example.com",
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
      capabilities: ["heartbeat"],
      fetch: () => Promise.resolve(Response.json({ runnerId: RUNNER_ID, runnerToken: "bad" })),
    }),
  );
  assert(enrollmentError.message.includes("invalid enrollment response"));
});

Deno.test("stores the runner bearer token in a regular 0600 file", async () => {
  const directory = await Deno.makeTempDir();
  try {
    success(
      await writeRunnerIdentity(directory, {
        runnerId: RUNNER_ID,
        runnerToken: RUNNER_TOKEN,
        controlPanelUrl: "https://openorb.example.com",
      }),
    );
    assertEquals(success(await readRunnerIdentity(directory)), {
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      controlPanelUrl: "https://openorb.example.com",
    });
    const tokenInfo = await Deno.lstat(`${directory}/token`);
    assert(tokenInfo.isFile);
    assertEquals(tokenInfo.isSymlink, false);
    if (Deno.build.os !== "windows" && tokenInfo.mode !== null) {
      assertEquals(tokenInfo.mode & 0o777, 0o600);
      await Deno.chmod(`${directory}/token`, 0o644);
      const readError = failure(await readRunnerIdentity(directory));
      assert(readError.message.includes("permissions must be 0600"));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reconnect delays use bounded exponential backoff with jitter", () => {
  assertEquals(reconnectDelayMs(0, () => 0), 800);
  assertEquals(reconnectDelayMs(1, () => 1), 2_000);
  assertEquals(reconnectDelayMs(10, () => 1), 30_000);
  assertEquals(reconnectDelayMs(100, () => 0), 24_000);
});

Deno.test("reconnects with bounded timers and aborts a stalled handshake", async () => {
  let resolveAddress: (address: Deno.NetAddr) => void;
  let closeOnOpen = true;
  const sockets = new Set<WebSocket>();
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddress = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: resolveAddress!,
    },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.onopen = () => {
        sockets.add(socket);
        if (closeOnOpen) socket.close(1012, "Restarting");
      };
      socket.onclose = () => sockets.delete(socket);
      return response;
    },
  );
  const address = await listening;
  const abortController = new AbortController();
  const delays: number[] = [];

  try {
    await maintainRunnerConnection({
      controlPanelUrl: `http://${address.hostname}:${address.port}`,
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      signal: abortController.signal,
      getCapacity: () => Promise.reject(new Error("Connection never authenticates")),
      getSessionSnapshot: () => Promise.resolve([[], undefined] as const),
      random: () => 0,
      sleep(milliseconds) {
        delays.push(milliseconds);
        if (delays.length === 4) abortController.abort();
        return Promise.resolve();
      },
    });
    assertEquals(delays, [800, 1_600, 3_200, 6_400]);

    closeOnOpen = false;
    const delayAbortController = new AbortController();
    await maintainRunnerConnection({
      controlPanelUrl: `http://${address.hostname}:${address.port}`,
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      signal: delayAbortController.signal,
      getCapacity: () => Promise.reject(new Error("Connection never authenticates")),
      getSessionSnapshot: () => Promise.resolve([[], undefined] as const),
      handshakeTimeoutMs: 20,
      onReconnectScheduled() {
        delayAbortController.abort();
      },
    });
  } finally {
    abortController.abort();
    for (const socket of sockets) socket.close(1001, "Test shutting down");
    await server.shutdown();
    await server.finished;
  }
});

Deno.test("sends a complete session inventory in bounded reconciliation chunks", async () => {
  let resolveAddress: (address: Deno.NetAddr) => void;
  let resolveComplete: () => void;
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddress = resolve;
  });
  const reconciliationComplete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  const received: unknown[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: resolveAddress! },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.onmessage = (event) => {
        const input: unknown = JSON.parse(String(event.data));
        const message = parseRunnerClientMessage(input);
        if (message.type === "runner.hello") {
          socket.send(JSON.stringify({
            version: 1,
            id: crypto.randomUUID(),
            type: "runner.connected",
            payload: { runnerId: RUNNER_ID },
          }));
          return;
        }
        received.push(input);
        if (message.type === "runner.reconcile.complete") resolveComplete();
      };
      return response;
    },
  );
  const address = await listening;
  const abortController = new AbortController();
  const sessions = Array.from({ length: 26 }, (_, index) => ({
    id: crypto.randomUUID(),
    projectId: "01989d78-65ee-7f6a-a97e-0f16ad134c11",
    createdAt: "2026-08-17T12:00:00Z",
    initialPromptPreview: `Session ${index}`,
    state: "created" as const,
    lastEventCursor: index,
  }));

  try {
    const connection = maintainRunnerConnection({
      controlPanelUrl: `http://${address.hostname}:${address.port}`,
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      signal: abortController.signal,
      getCapacity: () =>
        Promise.resolve({
          activeSessions: 0,
          vmCpuCount: 4,
          vmMemoryMiB: 8192,
          diskFreeMiB: 20_480,
        }),
      getSessionSnapshot: () => Promise.resolve([sessions, undefined] as const),
      onConnected() {
        abortController.abort();
      },
    });
    await reconciliationComplete;
    await connection;

    const messages = received.map(parseRunnerClientMessage);
    assertEquals(messages.map((message) => message.type), [
      "runner.reconcile.start",
      "runner.reconcile.chunk",
      "runner.reconcile.chunk",
      "runner.reconcile.complete",
    ]);
    const [start, firstChunk, secondChunk, complete] = messages;
    assert(start?.type === "runner.reconcile.start");
    assert(firstChunk?.type === "runner.reconcile.chunk");
    assert(secondChunk?.type === "runner.reconcile.chunk");
    assert(complete?.type === "runner.reconcile.complete");
    assertEquals([firstChunk.payload.sequence, firstChunk.payload.sessions.length], [0, 25]);
    assertEquals([secondChunk.payload.sequence, secondChunk.payload.sessions.length], [1, 1]);
    assertEquals(complete.payload, {
      snapshotId: start.payload.snapshotId,
      chunkCount: 2,
      sessionCount: 26,
    });
  } finally {
    abortController.abort();
    await server.shutdown();
    await server.finished;
  }
});

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  if (error !== undefined) throw error;
  // SAFETY: The Result success variant always contains T when the error slot is undefined.
  return value as T;
}

function failure<T, E>(result: Result<T, E>): E {
  const [, error] = result;
  if (error === undefined) throw new Error("Expected operation to fail.");
  return error;
}
