import {
  parseRunnerServerMessage,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerClientMessage,
  type RunnerServerMessage,
} from "@openorb/protocol";
import { delay } from "@std/async/delay";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface MaintainRunnerConnectionOptions {
  controlPanelUrl: string;
  runnerId: string;
  runnerToken: string;
  signal: AbortSignal;
  getCapacity: () => Promise<RunnerCapacity>;
  handshakeTimeoutMs?: number;
  random?: () => number;
  sleep?: typeof delay;
  onConnected?: () => void;
  onReconnectScheduled?: (milliseconds: number) => void;
}

export async function maintainRunnerConnection(
  options: MaintainRunnerConnectionOptions,
): Promise<void> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? delay;
  let attempt = 0;

  while (!options.signal.aborted) {
    const outcome = await connectOnce(options);
    if (options.signal.aborted) return;
    if (outcome === "unauthorized") {
      throw new Error("Runner authentication was rejected. Enroll the runner again.");
    }
    if (outcome === "connected") attempt = 0;

    const reconnectDelay = reconnectDelayMs(attempt++, random);
    options.onReconnectScheduled?.(reconnectDelay);
    try {
      await sleep(reconnectDelay, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt, 30));
  const ceiling = Math.min(1_000 * 2 ** exponent, MAX_RECONNECT_DELAY_MS);
  const jitter = 0.8 + Math.max(0, Math.min(random(), 1)) * 0.2;
  return Math.floor(ceiling * jitter);
}

async function connectOnce(
  options: MaintainRunnerConnectionOptions,
): Promise<"connected" | "disconnected" | "unauthorized"> {
  const url = new URL("/api/runners/connect", options.controlPanelUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return await new Promise((resolve) => {
    const socket = new WebSocket(url);
    const handshakeDeadline = AbortSignal.timeout(
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    let connected = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let settled = false;

    const finish = (outcome: "connected" | "disconnected" | "unauthorized") => {
      if (settled) return;
      settled = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      handshakeDeadline.removeEventListener("abort", handshakeTimedOut);
      options.signal.removeEventListener("abort", shutDown);
      resolve(outcome);
    };
    const shutDown = () => {
      closeSocket(socket, 1000, "Runner shutting down");
      finish(connected ? "connected" : "disconnected");
    };
    const handshakeTimedOut = () => {
      closeSocket(socket, 4008, "Runner handshake timed out");
      finish("disconnected");
    };
    options.signal.addEventListener("abort", shutDown, { once: true });
    handshakeDeadline.addEventListener("abort", handshakeTimedOut, { once: true });
    if (options.signal.aborted) shutDown();

    socket.addEventListener("open", () => {
      if (settled) {
        closeSocket(socket, 1000, "Connection attempt expired");
        return;
      }
      socket.send(JSON.stringify(helloMessage(options.runnerToken)));
    });
    socket.addEventListener("message", (event) => {
      if (settled) return;
      if (typeof event.data !== "string") {
        socket.close(4400, "Invalid server message");
        return;
      }
      let message: RunnerServerMessage;
      try {
        message = parseRunnerServerMessage(JSON.parse(event.data));
      } catch {
        socket.close(4400, "Invalid server message");
        return;
      }
      if (connected) {
        socket.close(4400, "Unexpected server message");
        return;
      }
      if (message.payload.runnerId !== options.runnerId) {
        socket.close(4401, "Runner identity mismatch");
        return;
      }
      connected = true;
      handshakeDeadline.removeEventListener("abort", handshakeTimedOut);
      const sendHeartbeat = async () => {
        if (settled || heartbeatInFlight || socket.readyState !== WebSocket.OPEN) return;
        heartbeatInFlight = true;
        try {
          const capacity = await options.getCapacity();
          if (!settled && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(heartbeatMessage(capacity)));
          }
        } catch {
          closeSocket(socket, 1011, "Runner capacity report failed");
        } finally {
          heartbeatInFlight = false;
        }
      };
      void sendHeartbeat();
      heartbeat = setInterval(() => {
        void sendHeartbeat();
      }, RUNNER_HEARTBEAT_INTERVAL_MS);
      options.onConnected?.();
    });
    socket.addEventListener("close", (event) => {
      finish(event.code === 4401 ? "unauthorized" : connected ? "connected" : "disconnected");
    });
    socket.addEventListener("error", () => {
      closeSocket(socket);
      finish(connected ? "connected" : "disconnected");
    });
  });
}

function helloMessage(token: string): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_HELLO_MESSAGE_TYPE,
    payload: { token },
  };
}

function heartbeatMessage(capacity: RunnerCapacity): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_HEARTBEAT_MESSAGE_TYPE,
    payload: { observedAt: Date.now(), capacity },
  };
}

function closeSocket(socket: WebSocket, code?: number, reason?: string): void {
  try {
    code === undefined ? socket.close() : socket.close(code, reason);
  } catch {
    // Closing a WebSocket that is still connecting may fail; the attempt is still settled locally.
  }
}
