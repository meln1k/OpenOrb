import {
  parseRunnerServerMessage,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE,
  RUNNER_RECONCILE_CHUNK_SESSION_LIMIT,
  RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE,
  RUNNER_RECONCILE_START_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerClientMessage,
  type RunnerServerMessage,
  type RunnerSessionSnapshot,
  SESSION_EVENT_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionProvisionCommand,
} from "@openorb/protocol";
import { parseSafe, string } from "@remix-run/data-schema";
import { delay } from "@std/async/delay";

import type { SessionEventRelay } from "@/src/session-event-relay.ts";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface MaintainRunnerConnectionOptions {
  controlPanelUrl: string;
  runnerId: string;
  runnerToken: string;
  signal: AbortSignal;
  getCapacity: () => Promise<RunnerCapacity>;
  getSessionSnapshot: () => Promise<RunnerSessionSnapshot[]>;
  sessionEventRelay?: SessionEventRelay;
  handshakeTimeoutMs?: number;
  random?: () => number;
  sleep?: typeof delay;
  onConnected?: () => void;
  onReconnectScheduled?: (milliseconds: number) => void;
  onProvisionCommand?: (
    command: SessionProvisionCommand,
    send: (message: RunnerClientMessage) => void,
  ) => Promise<void>;
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
    let detachSessionEvents: (() => void) | undefined;

    const send = (message: RunnerClientMessage) => {
      if (!settled && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const finish = (outcome: "connected" | "disconnected" | "unauthorized") => {
      if (settled) return;
      settled = true;
      detachSessionEvents?.();
      detachSessionEvents = undefined;
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
      const frame = parseSafe(string(), event.data);
      if (!frame.success) {
        socket.close(4400, "Invalid server message");
        return;
      }
      let message: RunnerServerMessage;
      try {
        message = parseRunnerServerMessage(JSON.parse(frame.value));
      } catch {
        socket.close(4400, "Invalid server message");
        return;
      }
      if (connected) {
        if (
          message.type !== SESSION_PROVISION_MESSAGE_TYPE ||
          options.onProvisionCommand === undefined
        ) {
          socket.close(4400, "Unexpected server message");
          return;
        }
        void options.onProvisionCommand(message, send).catch(() => {
          closeSocket(socket, 1011, "Runner provisioning command failed");
        });
        return;
      }
      if (message.type === SESSION_PROVISION_MESSAGE_TYPE) {
        socket.close(4400, "Runner handshake is incomplete");
        return;
      }
      if (message.payload.runnerId !== options.runnerId) {
        socket.close(4401, "Runner identity mismatch");
        return;
      }
      connected = true;
      handshakeDeadline.removeEventListener("abort", handshakeTimedOut);
      const sendSnapshot = async () => {
        const sessions = await options.getSessionSnapshot();
        if (settled || socket.readyState !== WebSocket.OPEN) return false;

        const snapshotId = crypto.randomUUID();
        socket.send(JSON.stringify(reconcileStartMessage(snapshotId)));
        let sequence = 0;
        for (
          let index = 0;
          index < sessions.length;
          index += RUNNER_RECONCILE_CHUNK_SESSION_LIMIT
        ) {
          const chunk = sessions.slice(index, index + RUNNER_RECONCILE_CHUNK_SESSION_LIMIT);
          socket.send(JSON.stringify(reconcileChunkMessage(snapshotId, sequence++, chunk)));
        }
        socket.send(
          JSON.stringify(reconcileCompleteMessage(snapshotId, sequence, sessions.length)),
        );
        if (options.sessionEventRelay) {
          for (const session of sessions) {
            const events = await options.sessionEventRelay.readEvents(session.id);
            if (settled || socket.readyState !== WebSocket.OPEN) return false;
            for (const event of events) {
              socket.send(
                JSON.stringify(replayedSessionEventMessage(session.id, snapshotId, event)),
              );
            }
          }
        }
        return true;
      };
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
      void (async () => {
        const detach = options.sessionEventRelay
          ? await options.sessionEventRelay.attach(send, sendSnapshot)
          : await sendSnapshot().then((sent) => sent ? () => {} : undefined);
        if (!detach || settled || socket.readyState !== WebSocket.OPEN) {
          detach?.();
          return;
        }
        detachSessionEvents = detach;
        void sendHeartbeat();
        heartbeat = setInterval(() => {
          void sendHeartbeat();
        }, RUNNER_HEARTBEAT_INTERVAL_MS);
        options.onConnected?.();
      })().catch(() => {
        closeSocket(socket, 1011, "Runner session inventory failed");
      });
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

function reconcileStartMessage(snapshotId: string): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_RECONCILE_START_MESSAGE_TYPE,
    payload: { snapshotId },
  };
}

function reconcileChunkMessage(
  snapshotId: string,
  sequence: number,
  sessions: RunnerSessionSnapshot[],
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE,
    payload: { snapshotId, sequence, sessions },
  };
}

function reconcileCompleteMessage(
  snapshotId: string,
  chunkCount: number,
  sessionCount: number,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE,
    payload: { snapshotId, chunkCount, sessionCount },
  };
}

function replayedSessionEventMessage(
  sessionId: string,
  snapshotId: string,
  payload: SessionEventPayload,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_EVENT_MESSAGE_TYPE,
    sessionId,
    correlationId: snapshotId,
    payload,
  };
}

function closeSocket(socket: WebSocket, code?: number, reason?: string): void {
  try {
    code === undefined ? socket.close() : socket.close(code, reason);
  } catch {
    // Closing a WebSocket that is still connecting may fail; the attempt is still settled locally.
  }
}
