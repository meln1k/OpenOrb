import {
  parseRunnerServerMessage,
  RUNNER_CONNECTED_MESSAGE_TYPE,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_CHUNK_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT,
  RUNNER_SESSION_SYNC_COMPLETE_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_START_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerClientMessage,
  type RunnerSessionSnapshot,
  SESSION_EVENT_MESSAGE_TYPE,
  SESSION_EVENT_REPLAY_MESSAGE_TYPE,
  SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionEventReplayCommand,
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
  getSessionManifest: () => Promise<Result<RunnerSessionSnapshot[], Error>>;
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
  using cleanup = new DisposableStack();

  return await new Promise((resolve) => {
    const socket = new WebSocket(url);
    const handshakeDeadline = AbortSignal.timeout(
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    let connected = false;
    let heartbeatInFlight = false;
    let settled = false;

    const send = (message: RunnerClientMessage) => {
      if (!settled && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const finish = (outcome: "connected" | "disconnected" | "unauthorized") => {
      if (settled) return;
      settled = true;
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
    cleanup.defer(() => options.signal.removeEventListener("abort", shutDown));
    handshakeDeadline.addEventListener("abort", handshakeTimedOut, { once: true });
    cleanup.defer(() => handshakeDeadline.removeEventListener("abort", handshakeTimedOut));
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
        if (message.type === SESSION_PROVISION_MESSAGE_TYPE && options.onProvisionCommand) {
          void options.onProvisionCommand(message, send).then(([, commandError]) => {
            if (commandError !== undefined) {
              closeSocket(socket, 1011, "Runner provisioning command failed");
            }
          });
          return;
        }
        if (message.type === SESSION_EVENT_REPLAY_MESSAGE_TYPE && options.sessionEventRelay) {
          void sendSessionEventReplay(message, options.sessionEventRelay, send);
          return;
        }
        socket.close(4400, "Unexpected server message");
        return;
      }
      if (message.type !== RUNNER_CONNECTED_MESSAGE_TYPE) {
        socket.close(4400, "Runner handshake is incomplete");
        return;
      }
      if (message.payload.runnerId !== options.runnerId) {
        socket.close(4401, "Runner identity mismatch");
        return;
      }
      connected = true;
      handshakeDeadline.removeEventListener("abort", handshakeTimedOut);
      const sendSessionManifest = async (): Promise<Result<boolean, Error>> => {
        const [sessions, manifestError] = await options.getSessionManifest();
        if (manifestError !== undefined) return err(manifestError);
        if (settled || socket.readyState !== WebSocket.OPEN) return ok(false);

        const [, sendError] = trySync(
          () => {
            const manifestId = crypto.randomUUID();
            socket.send(JSON.stringify(sessionSyncStartMessage(manifestId)));
            let sequence = 0;
            for (
              let index = 0;
              index < sessions.length;
              index += RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT
            ) {
              const chunk = sessions.slice(index, index + RUNNER_SESSION_SYNC_CHUNK_SESSION_LIMIT);
              socket.send(JSON.stringify(sessionSyncChunkMessage(manifestId, sequence++, chunk)));
            }
            socket.send(
              JSON.stringify(sessionSyncCompleteMessage(manifestId, sequence, sessions.length)),
            );
            return manifestId;
          },
          (cause) => new RunnerConnectionError("Runner session manifest delivery failed.", cause),
        );
        if (sendError !== undefined) return err(sendError);
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
        const [detach, manifestError] = options.sessionEventRelay
          ? await options.sessionEventRelay.attach(send, sendSessionManifest)
          : await sendSessionManifest().then(([sent, error]) =>
            error === undefined
              ? ok(sent ? () => {} : undefined)
              : err(new SessionEventRelayError("Runner session manifest sync failed.", error))
          );
        if (manifestError !== undefined) {
          closeSocket(socket, 1011, "Runner session manifest sync failed");
          return;
        }
        if (!detach || settled || socket.readyState !== WebSocket.OPEN) {
          detach?.();
          return;
        }
        cleanup.defer(detach);
        void sendHeartbeat();
        const heartbeat = setInterval(() => {
          void sendHeartbeat();
        }, RUNNER_HEARTBEAT_INTERVAL_MS);
        cleanup.defer(() => clearInterval(heartbeat));
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

function sessionSyncStartMessage(manifestId: string): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_SESSION_SYNC_START_MESSAGE_TYPE,
    payload: { manifestId },
  };
}

function sessionSyncChunkMessage(
  manifestId: string,
  sequence: number,
  sessions: RunnerSessionSnapshot[],
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_SESSION_SYNC_CHUNK_MESSAGE_TYPE,
    payload: { manifestId, sequence, sessions },
  };
}

function sessionSyncCompleteMessage(
  manifestId: string,
  chunkCount: number,
  sessionCount: number,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_SESSION_SYNC_COMPLETE_MESSAGE_TYPE,
    payload: { manifestId, chunkCount, sessionCount },
  };
}

function replayedSessionEventMessage(
  command: SessionEventReplayCommand,
  payload: SessionEventPayload,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_EVENT_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload,
  };
}

async function sendSessionEventReplay(
  command: SessionEventReplayCommand,
  relay: SessionEventRelay,
  send: (message: RunnerClientMessage) => void,
): Promise<void> {
  let completed = false;
  const [, replayError] = await relay.replayEvents(
    command.sessionId,
    command.payload.afterCursor,
    (event) => {
      send(replayedSessionEventMessage(command, event));
    },
    (cursor) => {
      send(sessionEventReplayResultMessage(command, { status: "completed", cursor }));
      completed = true;
    },
  );
  if (replayError !== undefined) {
    send(sessionEventReplayResultMessage(command, { status: "failed" }));
    return;
  }
  if (!completed) {
    send(sessionEventReplayResultMessage(command, { status: "failed" }));
  }
}

function sessionEventReplayResultMessage(
  command: SessionEventReplayCommand,
  payload: { status: "completed"; cursor: number } | { status: "failed" },
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
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
