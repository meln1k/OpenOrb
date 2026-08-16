import {
  parseRunnerClientMessage,
  RUNNER_CONNECTED_MESSAGE_TYPE,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerServerMessage,
} from "@openorb/protocol";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
export const RUNNER_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface RunnerLiveState {
  capacity: RunnerCapacity;
  lastHeartbeatAt: number;
}

export interface RunnerConnectionRegistry {
  getRunnerLiveState(userId: string, runnerId: string): RunnerLiveState | null;
  disconnectRunner(userId: string, runnerId: string): boolean;
}

export interface RunnerConnectionGatewayOptions {
  heartbeatTimeoutMs?: number;
}

interface ActiveRunnerConnection {
  runner: AuthenticatedRunner;
  socket: WebSocket;
  heartbeatTimeout: ReturnType<typeof setTimeout>;
  capacity?: RunnerCapacity;
  lastHeartbeatAt?: number;
}

export class RunnerConnectionGateway implements RunnerConnectionRegistry {
  readonly #repository: Pick<RunnerRepository, "authenticateRunner">;
  readonly #connections = new Map<string, ActiveRunnerConnection>();
  readonly #sockets = new Set<WebSocket>();
  readonly #revokedRunners = new Set<string>();
  readonly #heartbeatTimeoutMs: number;

  constructor(
    repository: Pick<RunnerRepository, "authenticateRunner">,
    options: RunnerConnectionGatewayOptions = {},
  ) {
    this.#repository = repository;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? RUNNER_HEARTBEAT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#heartbeatTimeoutMs) || this.#heartbeatTimeoutMs <= 0) {
      throw new Error("Runner heartbeat timeout must be a positive integer.");
    }
  }

  handleUpgrade(request: Request): Response {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    const { socket, response } = Deno.upgradeWebSocket(request, { idleTimeout: 60 });
    this.#sockets.add(socket);
    let authenticatedRunner: AuthenticatedRunner | null = null;
    let activeConnection: ActiveRunnerConnection | null = null;
    let authenticating = false;
    const authenticationTimeout = setTimeout(() => {
      if (!authenticatedRunner) closeSocket(socket, 4408, "Authentication timed out");
    }, AUTHENTICATION_TIMEOUT_MS);

    socket.onmessage = async (event) => {
      try {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!authenticatedRunner && authenticating) {
          closeSocket(socket, 4400, "Authentication already in progress");
          return;
        }
        if (typeof event.data !== "string" || byteLength(event.data) > MAX_MESSAGE_BYTES) {
          closeSocket(socket, 4400, "Invalid message");
          return;
        }

        let input: unknown;
        try {
          input = JSON.parse(event.data);
        } catch {
          closeSocket(socket, 4400, "Invalid message");
          return;
        }

        let message;
        try {
          message = parseRunnerClientMessage(input);
        } catch {
          closeSocket(socket, 4400, "Invalid message");
          return;
        }

        if (!authenticatedRunner) {
          if (message.type !== RUNNER_HELLO_MESSAGE_TYPE) {
            closeSocket(socket, 4401, "Authentication required");
            return;
          }
          authenticating = true;
          const runner = await this.#repository.authenticateRunner(message.payload.token);
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!runner) {
            closeSocket(socket, 4401, "Authentication failed");
            return;
          }
          if (this.#revokedRunners.has(runnerKey(runner.userId, runner.id))) {
            closeSocket(socket, 4401, "Authentication failed");
            return;
          }

          authenticatedRunner = runner;
          clearTimeout(authenticationTimeout);
          const existing = this.#connections.get(runner.id);
          if (existing && existing.socket !== socket) {
            closeSocket(existing.socket, 4000, "Replaced by reconnect");
          }
          activeConnection = {
            runner,
            socket,
            heartbeatTimeout: this.#createHeartbeatTimeout(runner.id, socket),
          };
          this.#connections.set(runner.id, activeConnection);
          socket.send(JSON.stringify(connectedMessage(runner.id)));
          return;
        }

        if (message.type !== RUNNER_HEARTBEAT_MESSAGE_TYPE) {
          closeSocket(socket, 4400, "Unexpected message");
          return;
        }
        if (!activeConnection) {
          closeSocket(socket, 1011, "Connection state unavailable");
          return;
        }
        activeConnection.capacity = message.payload.capacity;
        activeConnection.lastHeartbeatAt = Date.now();
        clearTimeout(activeConnection.heartbeatTimeout);
        activeConnection.heartbeatTimeout = this.#createHeartbeatTimeout(
          activeConnection.runner.id,
          socket,
        );
      } catch {
        closeSocket(socket, 1011, "Connection handler failed");
      }
    };

    socket.onclose = () => {
      clearTimeout(authenticationTimeout);
      this.#sockets.delete(socket);
      if (activeConnection) clearTimeout(activeConnection.heartbeatTimeout);
      if (
        authenticatedRunner && this.#connections.get(authenticatedRunner.id) === activeConnection
      ) {
        this.#connections.delete(authenticatedRunner.id);
      }
    };

    socket.onerror = () => {
      clearTimeout(authenticationTimeout);
    };

    return response;
  }

  getRunnerLiveState(userId: string, runnerId: string): RunnerLiveState | null {
    const connection = this.#connections.get(runnerId);
    if (
      !connection ||
      connection.runner.userId !== userId ||
      connection.socket.readyState !== WebSocket.OPEN ||
      connection.capacity === undefined ||
      connection.lastHeartbeatAt === undefined ||
      Date.now() - connection.lastHeartbeatAt >= this.#heartbeatTimeoutMs
    ) {
      return null;
    }
    return {
      capacity: { ...connection.capacity },
      lastHeartbeatAt: connection.lastHeartbeatAt,
    };
  }

  disconnectRunner(userId: string, runnerId: string): boolean {
    this.#revokedRunners.add(runnerKey(userId, runnerId));
    const connection = this.#connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return false;

    this.#connections.delete(runnerId);
    clearTimeout(connection.heartbeatTimeout);
    closeSocket(connection.socket, 4401, "Runner revoked");
    return true;
  }

  close(): void {
    for (const connection of this.#connections.values()) {
      clearTimeout(connection.heartbeatTimeout);
    }
    for (const socket of this.#sockets) {
      closeSocket(socket, 1001, "Control panel shutting down");
    }
    this.#connections.clear();
    this.#sockets.clear();
    this.#revokedRunners.clear();
  }

  #createHeartbeatTimeout(runnerId: string, socket: WebSocket): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const connection = this.#connections.get(runnerId);
      if (!connection || connection.socket !== socket) return;
      this.#connections.delete(runnerId);
      closeSocket(socket, 4408, "Heartbeat timed out");
    }, this.#heartbeatTimeoutMs);
  }
}

function connectedMessage(runnerId: string): RunnerServerMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: RUNNER_CONNECTED_MESSAGE_TYPE,
    payload: { runnerId },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function runnerKey(userId: string, runnerId: string): string {
  return `${userId}:${runnerId}`;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may have closed while an asynchronous authentication lookup was in flight.
  }
}
