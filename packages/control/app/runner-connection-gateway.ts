import {
  parseRunnerClientMessage,
  RUNNER_CONNECTED_MESSAGE_TYPE,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  type RunnerServerMessage,
} from "@openorb/protocol";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 16 * 1024;

export class RunnerConnectionGateway {
  readonly #repository: Pick<RunnerRepository, "authenticateRunner">;
  readonly #connections = new Map<string, WebSocket>();
  readonly #sockets = new Set<WebSocket>();

  constructor(repository: Pick<RunnerRepository, "authenticateRunner">) {
    this.#repository = repository;
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

          authenticatedRunner = runner;
          clearTimeout(authenticationTimeout);
          const existing = this.#connections.get(runner.id);
          if (existing && existing !== socket) {
            closeSocket(existing, 4000, "Replaced by reconnect");
          }
          this.#connections.set(runner.id, socket);
          socket.send(JSON.stringify(connectedMessage(runner.id)));
          return;
        }

        if (message.type !== RUNNER_HEARTBEAT_MESSAGE_TYPE) {
          closeSocket(socket, 4400, "Unexpected message");
        }
      } catch {
        closeSocket(socket, 1011, "Connection handler failed");
      }
    };

    socket.onclose = () => {
      clearTimeout(authenticationTimeout);
      this.#sockets.delete(socket);
      if (
        authenticatedRunner &&
        this.#connections.get(authenticatedRunner.id) === socket
      ) {
        this.#connections.delete(authenticatedRunner.id);
      }
    };

    socket.onerror = () => {
      clearTimeout(authenticationTimeout);
    };

    return response;
  }

  close(): void {
    for (const socket of this.#sockets) {
      closeSocket(socket, 1001, "Control panel shutting down");
    }
    this.#connections.clear();
    this.#sockets.clear();
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

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may have closed while an asynchronous authentication lookup was in flight.
  }
}
