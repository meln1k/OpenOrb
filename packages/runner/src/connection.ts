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
  type RunnerSessionSnapshot,
  SESSION_EVENT_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionProvisionCommand,
} from "@openorb/protocol";
import { parseSafe, string } from "@remix-run/data-schema";
import { delay } from "@std/async/delay";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import { type SessionEventRelay, SessionEventRelayError } from "@/src/session-event-relay.ts";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface MaintainRunnerConnectionOptions {
  gatewayUrl: string;
  runnerId: string;
  runnerToken: string;
  signal: AbortSignal;
  getCapacity: () => Promise<RunnerCapacity>;
  getSessionSnapshot: () => Promise<Result<RunnerSessionSnapshot[], Error>>;
  sessionEventRelay?: SessionEventRelay;
  handshakeTimeoutMs?: number;
  random?: () => number;
  sleep?: typeof delay;
  onConnected?: () => void;
  onReconnectScheduled?: (milliseconds: number) => void;
  onProvisionCommand?: (
    command: SessionProvisionCommand,
    send: (message: RunnerClientMessage) => void,
  ) => Promise<Result<void, Error>>;
}

export async function maintainRunnerConnection(
  options: MaintainRunnerConnectionOptions,
): Promise<Result<void, RunnerConnectionError>> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? delay;
  let attempt = 0;

  while (!options.signal.aborted) {
    const [outcome, connectionError] = await tryAsync(
      connectOnce(options),
      (cause) => new RunnerConnectionError("Runner connection attempt failed.", cause),
    );
    if (connectionError !== undefined) return err(connectionError);
    if (options.signal.aborted) return ok(undefined);
    if (outcome === "unauthorized") {
      return err(
        new RunnerConnectionError(
          "Runner authentication was rejected. Enroll the runner again.",
          undefined,
        ),
      );
    }
    if (outcome === "connected") attempt = 0;

    const reconnectDelay = reconnectDelayMs(attempt++, random);
    options.onReconnectScheduled?.(reconnectDelay);
    const [, sleepError] = await tryAsync(
      Promise.resolve().then(() => sleep(reconnectDelay, { signal: options.signal })),
      (cause) => new RunnerConnectionError("Runner reconnect delay failed.", cause),
    );
    if (sleepError !== undefined) {
      if (!options.signal.aborted) return err(sleepError);
      return ok(undefined);
    }
  }
  return ok(undefined);
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
  const url = new URL("/api/runners/connect", options.gatewayUrl);
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
      const [message, messageError] = trySync(
        () => parseRunnerServerMessage(JSON.parse(frame.value)),
        () => new Error("Invalid server message"),
      );
      if (messageError !== undefined) {
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
        void options.onProvisionCommand(message, send).then(([, commandError]) => {
          if (commandError !== undefined) {
            closeSocket(socket, 1011, "Runner provisioning command failed");
          }
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
      const sendSnapshot = async (): Promise<Result<boolean, Error>> => {
        const [sessions, snapshotError] = await options.getSessionSnapshot();
        if (snapshotError !== undefined) return err(snapshotError);
        if (settled || socket.readyState !== WebSocket.OPEN) return ok(false);

        const [sent, sendError] = trySync(
          () => {
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
            return snapshotId;
          },
          (cause) => new RunnerConnectionError("Runner session inventory delivery failed.", cause),
        );
        if (sendError !== undefined) return err(sendError);
        if (options.sessionEventRelay) {
          for (const session of sessions) {
            const [, replayError] = await options.sessionEventRelay.replayEvents(
              session.id,
              (event) => {
                if (settled || socket.readyState !== WebSocket.OPEN) return;
                socket.send(
                  JSON.stringify(replayedSessionEventMessage(session.id, sent, event)),
                );
              },
            );
            if (replayError !== undefined) {
              return err(
                new RunnerConnectionError("Runner session event replay failed.", replayError),
              );
            }
            if (settled || socket.readyState !== WebSocket.OPEN) return ok(false);
          }
        }
        return ok(true);
      };
      const sendHeartbeat = async () => {
        if (settled || heartbeatInFlight || socket.readyState !== WebSocket.OPEN) return;
        heartbeatInFlight = true;
        const [capacity, capacityError] = await tryAsync(
          Promise.resolve().then(() => options.getCapacity()),
          (cause) => new RunnerConnectionError("Runner capacity report failed.", cause),
        );
        if (capacityError !== undefined) {
          closeSocket(socket, 1011, capacityError.message);
          heartbeatInFlight = false;
          return;
        }
        if (!settled && socket.readyState === WebSocket.OPEN) {
          const [, sendError] = trySync(
            () => socket.send(JSON.stringify(heartbeatMessage(capacity))),
            (cause) => new RunnerConnectionError("Runner heartbeat delivery failed.", cause),
          );
          if (sendError !== undefined) {
            closeSocket(socket, 1011, sendError.message);
            heartbeatInFlight = false;
            return;
          }
        }
        heartbeatInFlight = false;
      };
      void (async () => {
        const [detach, inventoryError] = options.sessionEventRelay
          ? await options.sessionEventRelay.attach(send, sendSnapshot)
          : await sendSnapshot().then(([sent, error]) =>
            error === undefined
              ? ok(sent ? () => {} : undefined)
              : err(new SessionEventRelayError("Runner session inventory failed.", error))
          );
        if (inventoryError !== undefined) {
          closeSocket(socket, 1011, "Runner session inventory failed");
          return;
        }
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
      })();
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
  trySync(() => {
    code === undefined ? socket.close() : socket.close(code, reason);
  }, () => undefined);
}

export class RunnerConnectionError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerConnectionError";
  }
}
