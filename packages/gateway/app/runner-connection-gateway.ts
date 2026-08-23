import {
  MAX_RUNNER_CLIENT_MESSAGE_BYTES,
  type OrbSize,
  orbSizeResources,
  parseRunnerClientMessage,
  RUNNER_CONNECTED_MESSAGE_TYPE,
  RUNNER_HEARTBEAT_MESSAGE_TYPE,
  RUNNER_HELLO_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_CHUNK_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_COMPLETE_MESSAGE_TYPE,
  RUNNER_SESSION_SYNC_START_MESSAGE_TYPE,
  type RunnerCapacity,
  type RunnerServerMessage,
  type RunnerSessionSnapshot,
  SESSION_ABORT_ACCEPTED_MESSAGE_TYPE,
  SESSION_ABORT_MESSAGE_TYPE,
  SESSION_ABORT_REJECTED_MESSAGE_TYPE,
  SESSION_EVENT_MESSAGE_TYPE,
  SESSION_EVENT_REPLAY_MESSAGE_TYPE,
  SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE,
  SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROMPT_MESSAGE_TYPE,
  SESSION_PROMPT_REJECTED_MESSAGE_TYPE,
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionEventReplayResultMessage,
  type SessionEventReplayResultPayload,
  type SessionPromptCommandPayload,
  type SessionProvisionAcceptedMessage,
  type SessionProvisionAcceptedPayload,
  type SessionProvisionCommandPayload,
} from "@openorb/protocol";
import { tryAsync, trySync } from "@openorb/result";
import { parseSafe, string } from "remix/data-schema";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";
import type { SessionCatalogRepository } from "@/app/data/session-catalog-repository.ts";
import { AbortCommandOwner } from "@/app/abort-command-owner.ts";
import { PromptCommandOwner } from "@/app/prompt-command-owner.ts";
import { ProvisionCommandOwner } from "@/app/provision-command-owner.ts";
import { SessionRouteOwner } from "@/app/session-route-owner.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
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
  promptSession(input: PromptSessionInput): Promise<PromptSessionResult>;
  abortSession(input: AbortSessionInput): Promise<AbortSessionResult>;
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
  promptAcceptanceTimeoutMs?: number;
  abortAcceptanceTimeoutMs?: number;
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

export interface PromptSessionInput {
  userId: string;
  sessionId: string;
  payload: SessionPromptCommandPayload;
}

export type PromptSessionResult =
  | { status: "accepted" }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string };

export interface AbortSessionInput {
  userId: string;
  sessionId: string;
}

export type AbortSessionResult =
  | { status: "accepted" }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string };

export interface SessionEventSubscription {
  replay: Promise<void>;
  signal: AbortSignal;
  unsubscribe(): void;
}

interface ActiveRunnerConnection {
  runner: AuthenticatedRunner;
  socket: WebSocket;
  heartbeatTimeout: ReturnType<typeof setTimeout>;
  sessionIds: Set<string>;
  reservedCreateSessions: number;
  sessionSyncStarted: boolean;
  sessionSync?: SessionSyncState;
  capacity?: RunnerCapacity;
  lastHeartbeatAt?: number;
}

interface SessionSyncState {
  manifestId: string;
  nextSequence: number;
  receivedSessionCount: number;
  seenSessionIds: Set<string>;
  sessions: RunnerSessionSnapshot[];
}

type GatewayRepository =
  & Pick<RunnerRepository, "authenticateRunner">
  & Pick<SessionCatalogRepository, "reconcileSessionManifestEntries">;

export class RunnerConnectionGateway implements RunnerConnectionRegistry {
  readonly #repository: GatewayRepository;
  readonly #connections = new Map<string, ActiveRunnerConnection>();
  readonly #sockets = new Set<WebSocket>();
  readonly #revokedRunners = new Set<string>();
  readonly #sessionRoutes = new SessionRouteOwner<ActiveRunnerConnection>((connection) =>
    this.#isActive(connection)
  );
  readonly #sessionEventReplays = new Map<string, PendingSessionEventReplay>();
  readonly #provisionCommands: ProvisionCommandOwner<ActiveRunnerConnection>;
  readonly #promptCommands: PromptCommandOwner<ActiveRunnerConnection>;
  readonly #abortCommands: AbortCommandOwner<ActiveRunnerConnection>;
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
      throw new RunnerGatewayConfigurationError(
        "Runner heartbeat timeout must be a positive integer.",
      );
    }
    if (
      !Number.isSafeInteger(this.#provisionAcceptanceTimeoutMs) ||
      this.#provisionAcceptanceTimeoutMs <= 0
    ) {
      throw new RunnerGatewayConfigurationError(
        "Runner provisioning timeout must be a positive integer.",
      );
    }
    this.#provisionCommands = new ProvisionCommandOwner(this.#provisionAcceptanceTimeoutMs);
    const promptAcceptanceTimeoutMs = options.promptAcceptanceTimeoutMs ??
      PROVISION_ACCEPTANCE_TIMEOUT_MS;
    if (!Number.isSafeInteger(promptAcceptanceTimeoutMs) || promptAcceptanceTimeoutMs <= 0) {
      throw new RunnerGatewayConfigurationError(
        "Runner prompt timeout must be a positive integer.",
      );
    }
    this.#promptCommands = new PromptCommandOwner(promptAcceptanceTimeoutMs);
    const abortAcceptanceTimeoutMs = options.abortAcceptanceTimeoutMs ??
      PROVISION_ACCEPTANCE_TIMEOUT_MS;
    if (!Number.isSafeInteger(abortAcceptanceTimeoutMs) || abortAcceptanceTimeoutMs <= 0) {
      throw new RunnerGatewayConfigurationError(
        "Runner abort timeout must be a positive integer.",
      );
    }
    this.#abortCommands = new AbortCommandOwner(abortAcceptanceTimeoutMs);
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
      messageQueue = tryAsync(
        messageQueue.then(async () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const frame = parseSafe(string(), event.data);
          if (!frame.success || byteLength(frame.value) > MAX_RUNNER_CLIENT_MESSAGE_BYTES) {
            closeSocket(socket, 4400, "Invalid message");
            return;
          }

          const [message, messageError] = trySync(
            () => parseRunnerClientMessage(JSON.parse(frame.value)),
            (cause) => new InvalidRunnerMessageError(cause),
          );
          if (messageError !== undefined) {
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
              this.#provisionCommands.rejectForConnection(
                existing,
                "Runner reconnected before acknowledging.",
              );
              this.#promptCommands.rejectForConnection(
                existing,
                "Runner reconnected before acknowledging the prompt. Delivery may be uncertain; it will not be retried automatically.",
              );
              this.#abortCommands.rejectForConnection(
                existing,
                "Runner reconnected before acknowledging the abort. The run may still be stopping.",
              );
              this.#failSessionEventReplaysForConnection(
                existing,
                "Runner reconnected before session history was replayed.",
              );
              this.#sessionRoutes.remove(existing);
              closeSocket(existing.socket, 4000, "Replaced by reconnect");
            }
            activeConnection = {
              runner,
              socket,
              heartbeatTimeout: this.#createHeartbeatTimeout(runner.id, socket),
              sessionIds: new Set(),
              reservedCreateSessions: 0,
              sessionSyncStarted: false,
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

          if (message.type === RUNNER_SESSION_SYNC_START_MESSAGE_TYPE) {
            if (activeConnection.sessionSyncStarted) {
              closeSocket(socket, 4400, "Session sync already started");
              return;
            }
            activeConnection.sessionSyncStarted = true;
            activeConnection.sessionSync = {
              manifestId: message.payload.manifestId,
              nextSequence: 0,
              receivedSessionCount: 0,
              seenSessionIds: new Set(),
              sessions: [],
            };
            this.#refreshHeartbeatTimeout(activeConnection);
            return;
          }

          if (message.type === RUNNER_SESSION_SYNC_CHUNK_MESSAGE_TYPE) {
            const sessionSync = activeConnection.sessionSync;
            if (
              !sessionSync ||
              sessionSync.manifestId !== message.payload.manifestId ||
              sessionSync.nextSequence !== message.payload.sequence ||
              message.payload.sessions.some((session) => sessionSync.seenSessionIds.has(session.id))
            ) {
              closeSocket(socket, 4400, "Invalid session sync chunk");
              return;
            }

            this.#refreshHeartbeatTimeout(activeConnection);
            for (const session of message.payload.sessions) {
              sessionSync.seenSessionIds.add(session.id);
              sessionSync.sessions.push(session);
            }
            sessionSync.receivedSessionCount += message.payload.sessions.length;
            sessionSync.nextSequence++;
            return;
          }

          if (message.type === RUNNER_SESSION_SYNC_COMPLETE_MESSAGE_TYPE) {
            const sessionSync = activeConnection.sessionSync;
            if (
              !sessionSync ||
              sessionSync.manifestId !== message.payload.manifestId ||
              sessionSync.nextSequence !== message.payload.chunkCount ||
              sessionSync.receivedSessionCount !== message.payload.sessionCount
            ) {
              closeSocket(socket, 4400, "Invalid session sync completion");
              return;
            }
            this.#refreshHeartbeatTimeout(activeConnection);
            await this.#publishSessionManifest(activeConnection, sessionSync);
            return;
          }

          if (message.type === SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE) {
            await this.#acceptProvisionedSession(activeConnection, message);
            return;
          }

          if (message.type === SESSION_PROVISION_REJECTED_MESSAGE_TYPE) {
            const pending = this.#provisionCommands.get(message.correlationId);
            if (
              !pending ||
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected provisioning rejection");
              return;
            }
            this.#provisionCommands.settle(message.correlationId, {
              status: "rejected",
              message: message.payload.message,
            });
            return;
          }

          if (message.type === SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE) {
            const pending = this.#promptCommands.get(message.correlationId);
            // A valid runner may finish preflight after the browser-facing acceptance deadline.
            if (!pending) return;
            if (
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected prompt acceptance");
              return;
            }
            this.#promptCommands.settle(message.correlationId, { status: "accepted" });
            return;
          }

          if (message.type === SESSION_PROMPT_REJECTED_MESSAGE_TYPE) {
            const pending = this.#promptCommands.get(message.correlationId);
            // Rejections can race the same deadline and no longer have a caller to settle.
            if (!pending) return;
            if (
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected prompt rejection");
              return;
            }
            this.#promptCommands.settle(message.correlationId, {
              status: "rejected",
              message: message.payload.message,
            });
            return;
          }

          if (message.type === SESSION_ABORT_ACCEPTED_MESSAGE_TYPE) {
            const pending = this.#abortCommands.get(message.correlationId);
            if (!pending) return;
            if (
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected abort acceptance");
              return;
            }
            this.#abortCommands.settle(message.correlationId, { status: "accepted" });
            return;
          }

          if (message.type === SESSION_ABORT_REJECTED_MESSAGE_TYPE) {
            const pending = this.#abortCommands.get(message.correlationId);
            if (!pending) return;
            if (
              pending.connection !== activeConnection ||
              pending.sessionId !== message.sessionId
            ) {
              closeSocket(socket, 4400, "Unexpected abort rejection");
              return;
            }
            this.#abortCommands.settle(message.correlationId, {
              status: "rejected",
              message: message.payload.message,
            });
            return;
          }

          if (message.type === SESSION_EVENT_MESSAGE_TYPE) {
            const replay = this.#sessionEventReplays.get(message.correlationId);
            if (replay) {
              if (
                replay.connection !== activeConnection || replay.sessionId !== message.sessionId
              ) {
                closeSocket(socket, 4400, "Session event replay does not match its request");
                return;
              }
              if (!replay.accept(message.payload)) {
                this.#sessionEventReplays.delete(message.correlationId);
                replay.fail("Runner sent an invalid session history replay.");
                closeSocket(socket, 4400, "Invalid session event replay sequence");
              }
              return;
            }
            if (
              !this.#sessionRoutes.publish(
                activeConnection,
                message.sessionId,
                message.payload,
                message.correlationId,
              )
            ) {
              closeSocket(socket, 4400, "Session event is not routed through this runner");
              return;
            }
            return;
          }

          if (message.type === SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE) {
            this.#settleSessionEventReplay(activeConnection, message);
            return;
          }

          closeSocket(socket, 4400, "Unexpected message");
        }),
        (cause) => new RunnerConnectionHandlerError(cause),
      ).then(([, handlerError]) => {
        if (handlerError !== undefined) {
          closeSocket(socket, 1011, "Connection handler failed");
          return;
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
          this.#provisionCommands.rejectForConnection(
            activeConnection,
            "Runner disconnected before acknowledging.",
          );
          this.#promptCommands.rejectForConnection(
            activeConnection,
            "Runner disconnected before acknowledging the prompt. Delivery may be uncertain; it will not be retried automatically.",
          );
          this.#abortCommands.rejectForConnection(
            activeConnection,
            "Runner disconnected before acknowledging the abort. The run may still be stopping.",
          );
          this.#failSessionEventReplaysForConnection(
            activeConnection,
            "Runner disconnected before session history was replayed.",
          );
          this.#sessionRoutes.remove(activeConnection);
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
    return this.#sessionRoutes.getRunner(userId, sessionId);
  }

  getSessionSnapshot(userId: string, sessionId: string): RunnerSessionSnapshot | null {
    return this.#sessionRoutes.getSnapshot(userId, sessionId);
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
    if (
      input.payload.mode === "create" &&
      !runnerSupportsOrbSize(liveState.capacity, input.payload.orbSize)
    ) {
      return Promise.resolve({
        status: "unavailable",
        message: `Runner cannot provision the ${input.payload.orbSize} orb size.`,
      });
    }

    if (this.#provisionCommands.hasSession(input.userId, input.sessionId)) {
      return Promise.resolve({
        status: "unavailable",
        message: "This session already has a provisioning request in flight.",
      });
    }
    const existingRoute = this.#sessionRoutes.getRoute(input.userId, input.sessionId);
    if (existingRoute && existingRoute !== connection && this.#isActive(existingRoute)) {
      return Promise.resolve({
        status: "unavailable",
        message: "This session is pinned to another runner.",
      });
    }

    const commandId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#provisionCommands.create(
        commandId,
        connection,
        input.sessionId,
        input.payload,
        resolve,
      );

      const command: RunnerServerMessage = {
        version: 1,
        id: commandId,
        type: SESSION_PROVISION_MESSAGE_TYPE,
        sessionId: input.sessionId,
        payload: input.payload,
      };
      const [, sendError] = trySync(
        () => connection.socket.send(JSON.stringify(command)),
        (cause) => new RunnerWebSocketError("Runner command delivery failed.", cause),
      );
      if (sendError !== undefined) {
        this.#provisionCommands.settle(commandId, {
          status: "unavailable",
          message: "Runner disconnected before provisioning could be sent.",
        });
        return;
      }
    });
  }

  promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    const connection = this.#sessionRoutes.getRoute(input.userId, input.sessionId);
    if (!connection || !this.#isActive(connection)) {
      return Promise.resolve({
        status: "unavailable",
        message: "The pinned runner is offline.",
      });
    }
    const snapshot = this.#sessionRoutes.getSnapshot(input.userId, input.sessionId);
    if (!snapshot || (snapshot.state !== "ready" && snapshot.state !== "running")) {
      return Promise.resolve({
        status: "rejected",
        message: "The session cannot accept a prompt right now.",
      });
    }
    if (snapshot.model !== input.payload.modelRuntime.model) {
      return Promise.resolve({
        status: "rejected",
        message: "The session model cannot change during continuation.",
      });
    }
    if (
      this.#provisionCommands.hasSession(input.userId, input.sessionId) ||
      this.#promptCommands.hasSession(input.userId, input.sessionId) ||
      this.#abortCommands.hasSession(input.userId, input.sessionId)
    ) {
      return Promise.resolve({
        status: "rejected",
        message: "The session already has a command in flight.",
      });
    }

    const commandId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#promptCommands.create(commandId, connection, input.sessionId, resolve);
      const command: RunnerServerMessage = {
        version: 1,
        id: commandId,
        type: SESSION_PROMPT_MESSAGE_TYPE,
        sessionId: input.sessionId,
        payload: input.payload,
      };
      const [, sendError] = trySync(
        () => connection.socket.send(JSON.stringify(command)),
        (cause) => new RunnerWebSocketError("Runner prompt delivery failed.", cause),
      );
      if (sendError !== undefined) {
        this.#promptCommands.settle(commandId, {
          status: "unavailable",
          message:
            "Runner disconnected while sending the prompt. Delivery may be uncertain; it will not be retried automatically.",
        });
        return;
      }
    });
  }

  abortSession(input: AbortSessionInput): Promise<AbortSessionResult> {
    const connection = this.#sessionRoutes.getRoute(input.userId, input.sessionId);
    if (!connection || !this.#isActive(connection)) {
      return Promise.resolve({
        status: "unavailable",
        message: "The pinned runner is offline.",
      });
    }
    const snapshot = this.#sessionRoutes.getSnapshot(input.userId, input.sessionId);
    const runId = this.#sessionRoutes.getActiveRunId(input.userId, input.sessionId);
    if (!snapshot || snapshot.state !== "running" || !runId) {
      return Promise.resolve({
        status: "rejected",
        message: "There is no active Pi run to abort.",
      });
    }
    if (
      this.#provisionCommands.hasSession(input.userId, input.sessionId) ||
      this.#promptCommands.hasSession(input.userId, input.sessionId) ||
      this.#abortCommands.hasSession(input.userId, input.sessionId)
    ) {
      return Promise.resolve({
        status: "rejected",
        message: "The session already has a command in flight.",
      });
    }

    const commandId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#abortCommands.create(commandId, connection, input.sessionId, resolve);
      const command: RunnerServerMessage = {
        version: 1,
        id: commandId,
        type: SESSION_ABORT_MESSAGE_TYPE,
        sessionId: input.sessionId,
        payload: { runId },
      };
      const [, sendError] = trySync(
        () => connection.socket.send(JSON.stringify(command)),
        (cause) => new RunnerWebSocketError("Runner abort delivery failed.", cause),
      );
      if (sendError !== undefined) {
        this.#abortCommands.settle(commandId, {
          status: "unavailable",
          message:
            "Runner disconnected while sending the abort. The run may still be stopping; the abort will not be retried automatically.",
        });
        return;
      }
    });
  }

  subscribeToSessionEvents(
    userId: string,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ): SessionEventSubscription {
    const connection = this.#sessionRoutes.getRoute(userId, sessionId);
    if (!connection || !this.#isActive(connection)) {
      return failedSessionEventSubscription("The pinned runner is offline.");
    }

    const commandId = crypto.randomUUID();
    const replay = new PendingSessionEventReplay(connection, sessionId, afterCursor, listener);
    const liveSubscription = this.#sessionRoutes.subscribe(
      userId,
      sessionId,
      (event) => replay.acceptLive(event),
      () => replay.fail("Runner disconnected from the session event stream."),
    );
    replay.setUnsubscribeLive(() => liveSubscription.unsubscribe());
    this.#sessionEventReplays.set(commandId, replay);

    const command: RunnerServerMessage = {
      version: 1,
      id: commandId,
      type: SESSION_EVENT_REPLAY_MESSAGE_TYPE,
      sessionId,
      payload: { afterCursor },
    };
    const [, sendError] = trySync(
      () => connection.socket.send(JSON.stringify(command)),
      (cause) => new RunnerWebSocketError("Runner replay request delivery failed.", cause),
    );
    if (sendError !== undefined) {
      this.#sessionEventReplays.delete(commandId);
      replay.fail("Runner disconnected before session history could be requested.");
      return replay;
    }
    return replay;
  }

  disconnectRunner(userId: string, runnerId: string): boolean {
    this.#revokedRunners.add(runnerKey(userId, runnerId));
    const connection = this.#connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return false;

    this.#connections.delete(runnerId);
    this.#provisionCommands.rejectForConnection(
      connection,
      "Runner was revoked before acknowledging.",
    );
    this.#promptCommands.rejectForConnection(
      connection,
      "Runner was revoked before acknowledging the prompt. Delivery may be uncertain; it will not be retried automatically.",
    );
    this.#abortCommands.rejectForConnection(
      connection,
      "Runner was revoked before acknowledging the abort. The run may still be stopping.",
    );
    this.#failSessionEventReplaysForConnection(
      connection,
      "Runner was revoked before session history was replayed.",
    );
    this.#sessionRoutes.remove(connection);
    clearTimeout(connection.heartbeatTimeout);
    closeSocket(connection.socket, 4401, "Runner revoked");
    return true;
  }

  close(): void {
    for (const connection of this.#connections.values()) {
      clearTimeout(connection.heartbeatTimeout);
    }
    for (const socket of this.#sockets) {
      closeSocket(socket, 1001, "Gateway shutting down");
    }
    this.#provisionCommands.settleAll({
      status: "unavailable",
      message: "Gateway is shutting down.",
    });
    this.#promptCommands.settleAll({
      status: "unavailable",
      message: "Gateway is shutting down.",
    });
    this.#abortCommands.settleAll({
      status: "unavailable",
      message: "Gateway is shutting down while the abort acknowledgement is pending.",
    });
    for (const replay of this.#sessionEventReplays.values()) {
      replay.fail("Gateway shut down before session history was replayed.");
    }
    this.#sessionEventReplays.clear();
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
      this.#provisionCommands.rejectForConnection(
        connection,
        "Runner heartbeat timed out before acknowledging.",
      );
      this.#promptCommands.rejectForConnection(
        connection,
        "Runner heartbeat timed out before acknowledging the prompt. Delivery may be uncertain; it will not be retried automatically.",
      );
      this.#abortCommands.rejectForConnection(
        connection,
        "Runner heartbeat timed out before acknowledging the abort. The run may still be stopping.",
      );
      this.#failSessionEventReplaysForConnection(
        connection,
        "Runner heartbeat timed out before session history was replayed.",
      );
      this.#sessionRoutes.remove(connection);
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

  async #publishSessionManifest(
    connection: ActiveRunnerConnection,
    sessionSync: SessionSyncState,
  ): Promise<void> {
    if (!this.#isActive(connection)) return;
    if (this.#sessionRoutes.hasConflict(connection, sessionSync.sessions)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    const [reconciled, persistenceError] = await this.#repository.reconcileSessionManifestEntries(
      connection.runner.userId,
      sessionSync.sessions,
    );
    if (persistenceError !== undefined) {
      closeSocket(connection.socket, 1011, "Session catalog persistence failed");
      return;
    }
    if (!this.#isActive(connection)) return;
    if (reconciled.rejected.length > 0) {
      closeSocket(connection.socket, 4400, "Session manifest reconciliation was rejected");
      return;
    }
    if (this.#sessionRoutes.hasConflict(connection, sessionSync.sessions)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    this.#sessionRoutes.replace(connection, new Set(reconciled.acceptedSessionIds));
    for (const session of sessionSync.sessions) {
      if (reconciled.acceptedSessionIds.includes(session.id)) {
        this.#sessionRoutes.setSnapshot(connection.runner.userId, session);
      }
    }
    delete connection.sessionSync;
  }

  async #acceptProvisionedSession(
    connection: ActiveRunnerConnection,
    message: SessionProvisionAcceptedMessage,
  ): Promise<void> {
    const pending = this.#provisionCommands.get(message.correlationId);
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
        pending.expectedInitialPromptPreview !== message.payload.session.initialPromptPreview ||
        pending.expectedOrbSize !== message.payload.session.orbSize)
    ) {
      closeSocket(connection.socket, 4400, "Provisioning acceptance does not match the command");
      return;
    }

    const route = this.#sessionRoutes.getRoute(connection.runner.userId, message.sessionId);
    if (route && route !== connection && this.#isActive(route)) {
      closeSocket(connection.socket, 4400, "Session is already routed through another runner");
      return;
    }

    if (pending.mode === "create") {
      const [reconciled, persistenceError] = await this.#repository.reconcileSessionManifestEntries(
        connection.runner.userId,
        [message.payload.session],
      );
      if (persistenceError !== undefined) {
        this.#provisionCommands.settle(message.correlationId, {
          status: "unavailable",
          message: "The runner accepted the session, but its catalog entry could not be created.",
        });
        closeSocket(connection.socket, 1011, "Session catalog persistence failed");
        return;
      }
      const accepted = reconciled.rejected.length === 0 &&
        reconciled.acceptedSessionIds.includes(message.sessionId);
      if (
        this.#provisionCommands.get(message.correlationId) !== pending ||
        !this.#isActive(connection)
      ) {
        return;
      }
      if (!accepted) {
        this.#provisionCommands.settle(message.correlationId, {
          status: "unavailable",
          message: "The accepted session could not be reconciled with its catalog entry.",
        });
        closeSocket(connection.socket, 4400, "Session catalog reconciliation was rejected");
        return;
      }
    }

    this.#sessionRoutes.install(connection, message.sessionId);
    this.#sessionRoutes.setSnapshot(connection.runner.userId, message.payload.session);
    this.#provisionCommands.settle(message.correlationId, {
      status: "accepted",
      acknowledgement: message.payload,
    });
  }

  #settleSessionEventReplay(
    connection: ActiveRunnerConnection,
    message: SessionEventReplayResultMessage,
  ): void {
    const replay = this.#sessionEventReplays.get(message.correlationId);
    if (!replay || replay.connection !== connection || replay.sessionId !== message.sessionId) {
      closeSocket(connection.socket, 4400, "Unexpected session event replay result");
      return;
    }
    this.#sessionEventReplays.delete(message.correlationId);
    if (!replay.complete(message.payload)) {
      closeSocket(connection.socket, 4400, "Invalid session event replay result");
    }
  }

  #failSessionEventReplaysForConnection(
    connection: ActiveRunnerConnection,
    message: string,
  ): void {
    for (const [commandId, replay] of this.#sessionEventReplays) {
      if (replay.connection !== connection) continue;
      this.#sessionEventReplays.delete(commandId);
      replay.fail(message);
    }
  }

  #isActive(connection: ActiveRunnerConnection): boolean {
    return connection.socket.readyState === WebSocket.OPEN &&
      this.#connections.get(connection.runner.id) === connection;
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

function runnerSupportsOrbSize(capacity: RunnerCapacity, orbSize: OrbSize): boolean {
  const resources = orbSizeResources(orbSize);
  return resources.cpuCount <= capacity.vmCpuCount &&
    resources.memoryMiB <= capacity.vmMemoryMiB;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  // The peer may have closed while an asynchronous authentication lookup was in flight.
  trySync(() => socket.close(code, reason), () => false);
}

class InvalidRunnerMessageError extends Error {
  constructor(override readonly cause: unknown) {
    super("The runner sent an invalid protocol message.", { cause });
    this.name = "InvalidRunnerMessageError";
  }
}

class RunnerConnectionHandlerError extends Error {
  constructor(override readonly cause: unknown) {
    super("Runner connection message handling failed.", { cause });
    this.name = "RunnerConnectionHandlerError";
  }
}

class RunnerWebSocketError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerWebSocketError";
  }
}

class RunnerGatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerGatewayConfigurationError";
  }
}

class PendingSessionEventReplay implements SessionEventSubscription {
  readonly connection: ActiveRunnerConnection;
  readonly sessionId: string;
  readonly replay: Promise<void>;
  readonly #abort = new AbortController();
  readonly #resolveReplay: () => void;
  readonly #rejectReplay: (error: Error) => void;
  readonly #listener: (event: SessionEventPayload) => void;
  readonly #afterCursor: number;
  #unsubscribeLive = () => {};
  #active = true;
  #replaying = true;
  #settled = false;
  #replayMode: "pending" | "incremental" | "reset" = "pending";
  #nextCursor: number;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  constructor(
    connection: ActiveRunnerConnection,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.#afterCursor = afterCursor;
    this.#nextCursor = afterCursor + 1;
    this.#listener = listener;
    const replay = Promise.withResolvers<void>();
    this.replay = replay.promise;
    this.#resolveReplay = replay.resolve;
    this.#rejectReplay = replay.reject;
  }

  setUnsubscribeLive(unsubscribe: () => void): void {
    this.#unsubscribeLive = unsubscribe;
  }

  accept(event: SessionEventPayload): boolean {
    if (!this.#replaying) return false;
    if (!("cursor" in event) && event.event.type === "conversation.reset") {
      if (this.#replayMode !== "pending") return false;
      this.#replayMode = "reset";
      this.#nextCursor = 1;
    } else {
      if (!("cursor" in event)) return false;
      if (this.#replayMode === "pending") {
        if (this.#afterCursor === 0) return false;
        this.#replayMode = "incremental";
      }
      if (event.cursor !== this.#nextCursor) return false;
      this.#nextCursor += 1;
    }
    if (this.#active) {
      // A disconnected browser stream must not disrupt the runner connection.
      trySync(() => this.#listener(event), () => undefined);
    }
    return true;
  }

  acceptLive(event: SessionEventPayload): void {
    if (this.#active && !this.#replaying) this.#listener(event);
  }

  complete(result: SessionEventReplayResultPayload): boolean {
    if (result.status === "failed") {
      this.fail("Runner could not replay Pi session history.");
      return true;
    }
    const expectedCursor = this.#replayMode === "pending"
      ? this.#afterCursor === 0 ? undefined : this.#afterCursor
      : this.#nextCursor - 1;
    if (expectedCursor === undefined || result.cursor !== expectedCursor) {
      this.fail("Runner sent an incomplete Pi session history replay.");
      return false;
    }
    if (this.#settled) return true;
    this.#settled = true;
    this.#replaying = false;
    this.#resolveReplay();
    return true;
  }

  fail(message: string): void {
    if (!this.#active) return;
    this.#active = false;
    this.#unsubscribeLive();
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectReplay(new SessionEventReplayError(message));
    }
    this.#abort.abort();
  }

  unsubscribe(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#unsubscribeLive();
    if (!this.#settled) {
      this.#settled = true;
      this.#resolveReplay();
    }
    this.#abort.abort();
  }
}

function failedSessionEventSubscription(message: string): SessionEventSubscription {
  const replay = Promise.reject<void>(new SessionEventReplayError(message));
  void replay.catch(() => undefined);
  return { replay, signal: AbortSignal.abort(), unsubscribe() {} };
}

class SessionEventReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEventReplayError";
  }
}
