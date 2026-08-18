import {
  initialPromptPreview,
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
  runnerSessionStateForProvisioningStage,
  SESSION_EVENT_MESSAGE_TYPE,
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionProvisionAcceptedMessage,
  type SessionProvisionAcceptedPayload,
  type SessionProvisionCommandPayload,
} from "@openorb/protocol";
import { parseSafe, string } from "remix/data-schema";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";
import type { SessionCatalogRepository } from "@/app/data/session-catalog-repository.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CACHED_SESSION_EVENTS = 1_024;
const PROVISION_ACCEPTANCE_TIMEOUT_MS = 15_000;
export const RUNNER_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface RunnerLiveState {
  capacity: RunnerCapacity;
  lastHeartbeatAt: number;
}

export interface RunnerConnectionRegistry {
  getRunnerLiveState(userId: string, runnerId: string): RunnerLiveState | null;
  getSessionRunner(userId: string, sessionId: string): string | null;
  getSessionSnapshot(userId: string, sessionId: string): RunnerSessionSnapshot | null;
  provisionSession(input: ProvisionSessionInput): Promise<ProvisionSessionResult>;
  subscribeToSessionEvents(
    userId: string,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ): SessionEventSubscription;
  disconnectRunner(userId: string, runnerId: string): boolean;
}

export interface RunnerConnectionGatewayOptions {
  heartbeatTimeoutMs?: number;
  provisionAcceptanceTimeoutMs?: number;
}

export interface ProvisionSessionInput {
  userId: string;
  runnerId: string;
  sessionId: string;
  payload: SessionProvisionCommandPayload;
}

export type ProvisionSessionResult =
  | { status: "accepted"; acknowledgement: SessionProvisionAcceptedPayload }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string };

export interface SessionEventSubscription {
  events: SessionEventPayload[];
  unsubscribe(): void;
}

interface ActiveRunnerConnection {
  runner: AuthenticatedRunner;
  socket: WebSocket;
  heartbeatTimeout: ReturnType<typeof setTimeout>;
  sessionIds: Set<string>;
  reservedCreateSessions: number;
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

interface PendingProvisionCommandBase {
  connection: ActiveRunnerConnection;
  sessionId: string;
  resolve: (result: ProvisionSessionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type PendingProvisionCommand =
  & PendingProvisionCommandBase
  & (
    | {
      mode: "create";
      expectedProjectId: string;
      expectedRef: string;
      expectedBranchName: string;
      expectedInitialPromptPreview: string;
    }
    | { mode: "retry" }
  );

interface SessionEventChannel {
  events: SessionEventPayload[];
  listeners: Set<(event: SessionEventPayload) => void>;
  snapshot?: RunnerSessionSnapshot;
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
  readonly #pendingProvisionCommands = new Map<string, PendingProvisionCommand>();
  readonly #pendingProvisionSessions = new Set<string>();
  readonly #eventChannels = new Map<string, SessionEventChannel>();
  readonly #heartbeatTimeoutMs: number;
  readonly #provisionAcceptanceTimeoutMs: number;

  constructor(
    repository: GatewayRepository,
    options: RunnerConnectionGatewayOptions = {},
  ) {
    this.#repository = repository;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? RUNNER_HEARTBEAT_TIMEOUT_MS;
    this.#provisionAcceptanceTimeoutMs = options.provisionAcceptanceTimeoutMs ??
      PROVISION_ACCEPTANCE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#heartbeatTimeoutMs) || this.#heartbeatTimeoutMs <= 0) {
      throw new Error("Runner heartbeat timeout must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(this.#provisionAcceptanceTimeoutMs) ||
      this.#provisionAcceptanceTimeoutMs <= 0
    ) {
      throw new Error("Runner provisioning timeout must be a positive integer.");
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
              this.#rejectPendingCommands(existing, "Runner reconnected before acknowledging.");
              this.#removeSessionRoutes(existing);
              closeSocket(existing.socket, 4000, "Replaced by reconnect");
            }
            activeConnection = {
              runner,
              socket,
              heartbeatTimeout: this.#createHeartbeatTimeout(runner.id, socket),
              sessionIds: new Set(),
              reservedCreateSessions: 0,
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

          if (message.type === SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE) {
            await this.#acceptProvisionedSession(activeConnection, message);
            return;
          }

          if (message.type === SESSION_PROVISION_REJECTED_MESSAGE_TYPE) {
            const pending = this.#pendingProvisionCommands.get(message.correlationId);
            if (
              !pending ||
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected provisioning rejection");
              return;
            }
            this.#settleProvisionCommand(message.correlationId, {
              status: "rejected",
              message: message.payload.message,
            });
            return;
          }

          if (message.type === SESSION_EVENT_MESSAGE_TYPE) {
            const key = sessionKey(activeConnection.runner.userId, message.sessionId);
            if (this.#sessionRoutes.get(key) !== activeConnection) {
              closeSocket(socket, 4400, "Session event is not routed through this runner");
              return;
            }
            this.#publishSessionEvent(key, message.payload);
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
        if (activeConnection) {
          this.#rejectPendingCommands(
            activeConnection,
            "Runner disconnected before acknowledging.",
          );
          this.#removeSessionRoutes(activeConnection);
        }
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
      capacity: {
        ...connection.capacity,
        activeSessions: connection.capacity.activeSessions + connection.reservedCreateSessions,
      },
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

  getSessionSnapshot(userId: string, sessionId: string): RunnerSessionSnapshot | null {
    const key = sessionKey(userId, sessionId);
    const route = this.#sessionRoutes.get(key);
    if (!route || route.runner.userId !== userId || !this.#isActive(route)) return null;
    const snapshot = this.#eventChannels.get(key)?.snapshot;
    return snapshot ? { ...snapshot } : null;
  }

  provisionSession(input: ProvisionSessionInput): Promise<ProvisionSessionResult> {
    const connection = this.#connections.get(input.runnerId);
    const liveState = this.getRunnerLiveState(input.userId, input.runnerId);
    if (
      !connection ||
      connection.runner.userId !== input.userId ||
      !this.#isActive(connection) ||
      liveState === null
    ) {
      return Promise.resolve({
        status: "unavailable",
        message: "Runner is unavailable.",
      });
    }
    if (
      input.payload.mode === "create" &&
      liveState.capacity.maxConcurrentSessions !== undefined &&
      liveState.capacity.activeSessions >= liveState.capacity.maxConcurrentSessions
    ) {
      return Promise.resolve({
        status: "unavailable",
        message: "Runner has reached its concurrent session limit.",
      });
    }

    const key = sessionKey(input.userId, input.sessionId);
    if (this.#pendingProvisionSessions.has(key)) {
      return Promise.resolve({
        status: "unavailable",
        message: "This session already has a provisioning request in flight.",
      });
    }
    const existingRoute = this.#sessionRoutes.get(key);
    if (existingRoute && existingRoute !== connection && this.#isActive(existingRoute)) {
      return Promise.resolve({
        status: "unavailable",
        message: "This session is pinned to another runner.",
      });
    }

    const commandId = crypto.randomUUID();
    return new Promise((resolve) => {
      if (input.payload.mode === "create") connection.reservedCreateSessions++;
      const timeout = setTimeout(() => {
        this.#settleProvisionCommand(commandId, {
          status: "unavailable",
          message: "Runner did not acknowledge provisioning in time.",
        });
      }, this.#provisionAcceptanceTimeoutMs);
      this.#pendingProvisionCommands.set(commandId, {
        connection,
        sessionId: input.sessionId,
        ...(input.payload.mode === "create"
          ? {
            mode: input.payload.mode,
            expectedProjectId: input.payload.projectId,
            expectedRef: input.payload.ref,
            expectedBranchName: input.payload.branchName,
            expectedInitialPromptPreview: initialPromptPreview(input.payload.initialPrompt),
          }
          : { mode: input.payload.mode }),
        resolve,
        timeout,
      });
      this.#pendingProvisionSessions.add(key);

      const command: RunnerServerMessage = {
        version: 1,
        id: commandId,
        type: SESSION_PROVISION_MESSAGE_TYPE,
        sessionId: input.sessionId,
        payload: input.payload,
      };
      try {
        connection.socket.send(JSON.stringify(command));
      } catch {
        this.#settleProvisionCommand(commandId, {
          status: "unavailable",
          message: "Runner disconnected before provisioning could be sent.",
        });
      }
    });
  }

  subscribeToSessionEvents(
    userId: string,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ): SessionEventSubscription {
    const channel = this.#getEventChannel(sessionKey(userId, sessionId));
    channel.listeners.add(listener);
    let subscribed = true;
    return {
      events: channel.events.filter((entry) => entry.cursor > afterCursor),
      unsubscribe() {
        if (!subscribed) return;
        subscribed = false;
        channel.listeners.delete(listener);
      },
    };
  }

  disconnectRunner(userId: string, runnerId: string): boolean {
    this.#revokedRunners.add(runnerKey(userId, runnerId));
    const connection = this.#connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return false;

    this.#connections.delete(runnerId);
    this.#rejectPendingCommands(connection, "Runner was revoked before acknowledging.");
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
    for (const commandId of [...this.#pendingProvisionCommands.keys()]) {
      this.#settleProvisionCommand(commandId, {
        status: "unavailable",
        message: "Control panel is shutting down.",
      });
    }
    this.#connections.clear();
    this.#sessionRoutes.clear();
    this.#sockets.clear();
    this.#revokedRunners.clear();
    this.#eventChannels.clear();
  }

  #createHeartbeatTimeout(runnerId: string, socket: WebSocket): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const connection = this.#connections.get(runnerId);
      if (!connection || connection.socket !== socket) return;
      this.#connections.delete(runnerId);
      this.#rejectPendingCommands(connection, "Runner heartbeat timed out before acknowledging.");
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
    for (const session of reconciliation.sessions) {
      if (reconciled.acceptedSessionIds.includes(session.id)) {
        this.#getEventChannel(sessionKey(connection.runner.userId, session.id)).snapshot = session;
      }
    }
    connection.reconciliation = undefined;
  }

  async #acceptProvisionedSession(
    connection: ActiveRunnerConnection,
    message: SessionProvisionAcceptedMessage,
  ): Promise<void> {
    const pending = this.#pendingProvisionCommands.get(message.correlationId);
    if (
      !pending ||
      pending.connection !== connection ||
      pending.sessionId !== message.sessionId
    ) {
      closeSocket(connection.socket, 4400, "Unexpected provisioning acceptance");
      return;
    }
    if (
      pending.mode === "create" &&
      (pending.expectedProjectId !== message.payload.session.projectId ||
        pending.expectedRef !== message.payload.ref ||
        pending.expectedBranchName !== message.payload.branchName ||
        pending.expectedInitialPromptPreview !== message.payload.session.initialPromptPreview)
    ) {
      closeSocket(connection.socket, 4400, "Provisioning acceptance does not match the command");
      return;
    }

    const key = sessionKey(connection.runner.userId, message.sessionId);
    const route = this.#sessionRoutes.get(key);
    if (route && route !== connection && this.#isActive(route)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    if (pending.mode === "create") {
      let accepted = false;
      try {
        const reconciled = await this.#repository.reconcileSessionSnapshotEntries(
          connection.runner.userId,
          [message.payload.session],
        );
        accepted = reconciled.rejected.length === 0 &&
          reconciled.acceptedSessionIds.includes(message.sessionId);
      } catch {
        this.#settleProvisionCommand(message.correlationId, {
          status: "unavailable",
          message: "The runner accepted the session, but its catalog entry could not be created.",
        });
        closeSocket(connection.socket, 1011, "Session catalog persistence failed");
        return;
      }
      if (
        this.#pendingProvisionCommands.get(message.correlationId) !== pending ||
        !this.#isActive(connection)
      ) {
        return;
      }
      if (!accepted) {
        this.#settleProvisionCommand(message.correlationId, {
          status: "unavailable",
          message: "The accepted session could not be reconciled with its catalog entry.",
        });
        closeSocket(connection.socket, 4400, "Session catalog reconciliation was rejected");
        return;
      }
    }

    this.#sessionRoutes.set(key, connection);
    connection.sessionIds.add(message.sessionId);
    this.#getEventChannel(key).snapshot = message.payload.session;
    this.#settleProvisionCommand(message.correlationId, {
      status: "accepted",
      acknowledgement: message.payload,
    });
  }

  #settleProvisionCommand(commandId: string, result: ProvisionSessionResult): void {
    const pending = this.#pendingProvisionCommands.get(commandId);
    if (!pending) return;
    this.#pendingProvisionCommands.delete(commandId);
    this.#pendingProvisionSessions.delete(
      sessionKey(pending.connection.runner.userId, pending.sessionId),
    );
    if (pending.mode === "create") {
      pending.connection.reservedCreateSessions = Math.max(
        0,
        pending.connection.reservedCreateSessions - 1,
      );
      if (result.status === "accepted" && pending.connection.capacity) {
        pending.connection.capacity = {
          ...pending.connection.capacity,
          activeSessions: pending.connection.capacity.activeSessions + 1,
        };
      }
    }
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  #rejectPendingCommands(connection: ActiveRunnerConnection, message: string): void {
    for (const [commandId, pending] of this.#pendingProvisionCommands) {
      if (pending.connection !== connection) continue;
      this.#settleProvisionCommand(commandId, { status: "unavailable", message });
    }
  }

  #getEventChannel(key: string): SessionEventChannel {
    let channel = this.#eventChannels.get(key);
    if (!channel) {
      channel = { events: [], listeners: new Set() };
      this.#eventChannels.set(key, channel);
    }
    return channel;
  }

  #publishSessionEvent(key: string, event: SessionEventPayload): void {
    const channel = this.#getEventChannel(key);
    const lastCursor = channel.events.at(-1)?.cursor ?? 0;
    if (event.cursor <= lastCursor) return;

    channel.events.push(event);
    if (channel.events.length > MAX_CACHED_SESSION_EVENTS) channel.events.shift();
    if (channel.snapshot && event.event.type === "session.state") {
      channel.snapshot = {
        ...channel.snapshot,
        state: runnerSessionStateForProvisioningStage(event.event.stage),
        lastEventCursor: event.cursor,
      };
    }
    for (const listener of channel.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser stream must not disrupt the runner connection.
      }
    }
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
