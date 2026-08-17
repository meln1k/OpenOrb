import {
  parseRunnerClientMessage,
  RUNNER_CONNECTED_MESSAGE_TYPE,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE,
  RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE,
  RUNNER_RECONCILE_START_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerServerMessage,
  type RunnerSessionSnapshot,
} from "@openorb/protocol";
import { parseSafe, string } from "remix/data-schema";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";
import type { SessionCatalogRepository } from "@/app/data/session-catalog-repository.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
export const RUNNER_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface RunnerLiveState {
  capacity: RunnerCapacity;
  lastHeartbeatAt: number;
}

export interface RunnerConnectionRegistry {
  getRunnerLiveState(userId: string, runnerId: string): RunnerLiveState | null;
  getSessionRunner(userId: string, sessionId: string): string | null;
  disconnectRunner(userId: string, runnerId: string): boolean;
}

export interface RunnerConnectionGatewayOptions {
  heartbeatTimeoutMs?: number;
}

interface ActiveRunnerConnection {
  runner: AuthenticatedRunner;
  socket: WebSocket;
  heartbeatTimeout: ReturnType<typeof setTimeout>;
  sessionIds: Set<string>;
  reconciliationStarted: boolean;
  reconciliation?: ReconciliationState;
  capacity?: RunnerCapacity;
  lastHeartbeatAt?: number;
}

interface ReconciliationState {
  snapshotId: string;
  nextSequence: number;
  receivedSessionCount: number;
  seenSessionIds: Set<string>;
  sessions: RunnerSessionSnapshot[];
}

type GatewayRepository =
  & Pick<RunnerRepository, "authenticateRunner">
  & Pick<SessionCatalogRepository, "reconcileSessionSnapshotEntries">;

export class RunnerConnectionGateway implements RunnerConnectionRegistry {
  readonly #repository: GatewayRepository;
  readonly #connections = new Map<string, ActiveRunnerConnection>();
  readonly #sessionRoutes = new Map<string, ActiveRunnerConnection>();
  readonly #sockets = new Set<WebSocket>();
  readonly #revokedRunners = new Set<string>();
  readonly #heartbeatTimeoutMs: number;

  constructor(
    repository: GatewayRepository,
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
    let messageQueue = Promise.resolve();
    const authenticationTimeout = setTimeout(() => {
      if (!authenticatedRunner) closeSocket(socket, 4408, "Authentication timed out");
    }, AUTHENTICATION_TIMEOUT_MS);

    socket.onmessage = (event) => {
      if (!authenticatedRunner && authenticating) {
        closeSocket(socket, 4400, "Authentication already in progress");
        return;
      }
      messageQueue = messageQueue.then(async () => {
        try {
          if (socket.readyState !== WebSocket.OPEN) return;
          const frame = parseSafe(string(), event.data);
          if (!frame.success || byteLength(frame.value) > MAX_MESSAGE_BYTES) {
            closeSocket(socket, 4400, "Invalid message");
            return;
          }

          let input: unknown;
          try {
            input = JSON.parse(frame.value);
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
              this.#removeSessionRoutes(existing);
              closeSocket(existing.socket, 4000, "Replaced by reconnect");
            }
            activeConnection = {
              runner,
              socket,
              heartbeatTimeout: this.#createHeartbeatTimeout(runner.id, socket),
              sessionIds: new Set(),
              reconciliationStarted: false,
            };
            this.#connections.set(runner.id, activeConnection);
            socket.send(JSON.stringify(connectedMessage(runner.id)));
            return;
          }

          if (!activeConnection) {
            closeSocket(socket, 1011, "Connection state unavailable");
            return;
          }

          if (message.type === RUNNER_HEARTBEAT_MESSAGE_TYPE) {
            activeConnection.capacity = message.payload.capacity;
            activeConnection.lastHeartbeatAt = Date.now();
            this.#refreshHeartbeatTimeout(activeConnection);
            return;
          }

          if (message.type === RUNNER_RECONCILE_START_MESSAGE_TYPE) {
            if (activeConnection.reconciliationStarted) {
              closeSocket(socket, 4400, "Session reconciliation already started");
              return;
            }
            activeConnection.reconciliationStarted = true;
            activeConnection.reconciliation = {
              snapshotId: message.payload.snapshotId,
              nextSequence: 0,
              receivedSessionCount: 0,
              seenSessionIds: new Set(),
              sessions: [],
            };
            this.#refreshHeartbeatTimeout(activeConnection);
            return;
          }

          if (message.type === RUNNER_RECONCILE_CHUNK_MESSAGE_TYPE) {
            const reconciliation = activeConnection.reconciliation;
            if (
              !reconciliation ||
              reconciliation.snapshotId !== message.payload.snapshotId ||
              reconciliation.nextSequence !== message.payload.sequence ||
              message.payload.sessions.some((session) =>
                reconciliation.seenSessionIds.has(session.id)
              )
            ) {
              closeSocket(socket, 4400, "Invalid session reconciliation chunk");
              return;
            }

            this.#refreshHeartbeatTimeout(activeConnection);
            for (const session of message.payload.sessions) {
              reconciliation.seenSessionIds.add(session.id);
              reconciliation.sessions.push(session);
            }
            reconciliation.receivedSessionCount += message.payload.sessions.length;
            reconciliation.nextSequence++;
            return;
          }

          if (message.type === RUNNER_RECONCILE_COMPLETE_MESSAGE_TYPE) {
            const reconciliation = activeConnection.reconciliation;
            if (
              !reconciliation ||
              reconciliation.snapshotId !== message.payload.snapshotId ||
              reconciliation.nextSequence !== message.payload.chunkCount ||
              reconciliation.receivedSessionCount !== message.payload.sessionCount
            ) {
              closeSocket(socket, 4400, "Invalid session reconciliation completion");
              return;
            }
            this.#refreshHeartbeatTimeout(activeConnection);
            await this.#publishReconciliation(activeConnection, reconciliation);
            return;
          }

          closeSocket(socket, 4400, "Unexpected message");
        } catch {
          closeSocket(socket, 1011, "Connection handler failed");
        }
      });
    };

    socket.onclose = () => {
      clearTimeout(authenticationTimeout);
      this.#sockets.delete(socket);
      if (activeConnection) clearTimeout(activeConnection.heartbeatTimeout);
      if (
        authenticatedRunner && this.#connections.get(authenticatedRunner.id) === activeConnection
      ) {
        this.#connections.delete(authenticatedRunner.id);
        if (activeConnection) this.#removeSessionRoutes(activeConnection);
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

  getSessionRunner(userId: string, sessionId: string): string | null {
    const route = this.#sessionRoutes.get(sessionKey(userId, sessionId));
    if (
      !route ||
      route.runner.userId !== userId ||
      route.socket.readyState !== WebSocket.OPEN ||
      this.#connections.get(route.runner.id) !== route
    ) {
      return null;
    }
    return route.runner.id;
  }

  disconnectRunner(userId: string, runnerId: string): boolean {
    this.#revokedRunners.add(runnerKey(userId, runnerId));
    const connection = this.#connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return false;

    this.#connections.delete(runnerId);
    this.#removeSessionRoutes(connection);
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
    this.#sessionRoutes.clear();
    this.#sockets.clear();
    this.#revokedRunners.clear();
  }

  #createHeartbeatTimeout(runnerId: string, socket: WebSocket): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const connection = this.#connections.get(runnerId);
      if (!connection || connection.socket !== socket) return;
      this.#connections.delete(runnerId);
      this.#removeSessionRoutes(connection);
      closeSocket(socket, 4408, "Heartbeat timed out");
    }, this.#heartbeatTimeoutMs);
  }

  #refreshHeartbeatTimeout(connection: ActiveRunnerConnection): void {
    clearTimeout(connection.heartbeatTimeout);
    connection.heartbeatTimeout = this.#createHeartbeatTimeout(
      connection.runner.id,
      connection.socket,
    );
  }

  async #publishReconciliation(
    connection: ActiveRunnerConnection,
    reconciliation: ReconciliationState,
  ): Promise<void> {
    if (!this.#isActive(connection)) return;
    if (this.#hasConflictingSessionRoute(connection, reconciliation.sessions)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    const reconciled = await this.#repository.reconcileSessionSnapshotEntries(
      connection.runner.userId,
      reconciliation.sessions,
    );
    if (!this.#isActive(connection)) return;
    if (reconciled.rejected.length > 0) {
      closeSocket(connection.socket, 4400, "Session reconciliation was rejected");
      return;
    }
    if (this.#hasConflictingSessionRoute(connection, reconciliation.sessions)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    this.#replaceSessionRoutes(connection, new Set(reconciled.acceptedSessionIds));
    connection.reconciliation = undefined;
  }

  #hasConflictingSessionRoute(
    connection: ActiveRunnerConnection,
    sessions: RunnerSessionSnapshot[],
  ): boolean {
    for (const session of sessions) {
      const key = sessionKey(connection.runner.userId, session.id);
      const route = this.#sessionRoutes.get(key);
      if (!route || route === connection) continue;
      if (this.#isActive(route)) return true;
      this.#sessionRoutes.delete(key);
      route.sessionIds.delete(session.id);
    }
    return false;
  }

  #isActive(connection: ActiveRunnerConnection): boolean {
    return connection.socket.readyState === WebSocket.OPEN &&
      this.#connections.get(connection.runner.id) === connection;
  }

  #replaceSessionRoutes(
    connection: ActiveRunnerConnection,
    sessionIds: ReadonlySet<string>,
  ): void {
    this.#removeSessionRoutes(connection);
    for (const sessionId of sessionIds) {
      this.#sessionRoutes.set(
        sessionKey(connection.runner.userId, sessionId),
        connection,
      );
      connection.sessionIds.add(sessionId);
    }
  }

  #removeSessionRoutes(connection: ActiveRunnerConnection): void {
    for (const sessionId of connection.sessionIds) {
      const key = sessionKey(connection.runner.userId, sessionId);
      if (this.#sessionRoutes.get(key) === connection) this.#sessionRoutes.delete(key);
    }
    connection.sessionIds.clear();
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

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may have closed while an asynchronous authentication lookup was in flight.
  }
}
