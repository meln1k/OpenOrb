import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import { enrollRunner } from "@/src/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "@/src/identity.ts";
import { parseRunnerCommand } from "@/src/options.ts";
import { maintainRunnerConnection, reconnectDelayMs } from "@/src/connection.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const ENROLLMENT_PSK = `openorb_enroll_${"a".repeat(43)}`;
const RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;

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
    ]),
    expected,
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
});

Deno.test("enrolls with the PSK but accepts only a validated runner-token response", async () => {
  let received: unknown;
  const enrolled = await enrollRunner({
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
  });
  assertEquals(received, {
    enrollmentPsk: ENROLLMENT_PSK,
    name: "Home runner",
    architecture: "arm64",
    capabilities: ["heartbeat"],
  });
  assertEquals(enrolled, { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN });

  await assertRejects(
    () =>
      enrollRunner({
        controlPanelUrl: "https://openorb.example.com",
        enrollmentPsk: ENROLLMENT_PSK,
        name: "Home runner",
        architecture: "arm64",
        capabilities: ["heartbeat"],
        fetch: () => Promise.resolve(Response.json({ runnerId: RUNNER_ID, runnerToken: "bad" })),
      }),
    Error,
    "invalid enrollment response",
  );
});

Deno.test("stores the runner bearer token in a regular 0600 file", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await writeRunnerIdentity(directory, {
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      controlPanelUrl: "https://openorb.example.com",
    });
    assertEquals(await readRunnerIdentity(directory), {
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
      await assertRejects(
        () => readRunnerIdentity(directory),
        Error,
        "permissions must be 0600",
      );
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
