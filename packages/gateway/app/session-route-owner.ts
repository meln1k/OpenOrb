import {
  type RunnerSessionSnapshot,
  runnerSessionStateForProvisioningStage,
  type SessionEventPayload,
} from "@openorb/protocol";
import { trySync } from "@openorb/result";

export interface SessionRouteConnection {
  readonly runner: { id: string; userId: string };
  readonly sessionIds: Set<string>;
}

interface SessionEventChannel {
  listeners: Set<SessionEventListener>;
  snapshot?: RunnerSessionSnapshot;
  activeRunId?: string | undefined;
}

interface SessionEventListener {
  publish(event: SessionEventPayload): void;
  close(): void;
}

export interface OwnedSessionEventSubscription {
  unsubscribe(): void;
}

export class SessionRouteOwner<Connection extends SessionRouteConnection> {
  readonly #routes = new Map<string, Connection>();
  readonly #eventChannels = new Map<string, SessionEventChannel>();
  readonly #isActive: (connection: Connection) => boolean;

  constructor(isActive: (connection: Connection) => boolean) {
    this.#isActive = isActive;
  }

  getRunner(userId: string, sessionId: string): string | null {
    const route = this.#routes.get(sessionKey(userId, sessionId));
    return route && route.runner.userId === userId && this.#isActive(route)
      ? route.runner.id
      : null;
  }

  getRoute(userId: string, sessionId: string): Connection | undefined {
    return this.#routes.get(sessionKey(userId, sessionId));
  }

  getSnapshot(userId: string, sessionId: string): RunnerSessionSnapshot | null {
    const key = sessionKey(userId, sessionId);
    const route = this.#routes.get(key);
    if (!route || route.runner.userId !== userId || !this.#isActive(route)) return null;
    const snapshot = this.#eventChannels.get(key)?.snapshot;
    return snapshot ? { ...snapshot } : null;
  }

  getActiveRunId(userId: string, sessionId: string): string | null {
    const key = sessionKey(userId, sessionId);
    const route = this.#routes.get(key);
    if (!route || route.runner.userId !== userId || !this.#isActive(route)) return null;
    return this.#eventChannels.get(key)?.activeRunId ?? null;
  }

  setSnapshot(userId: string, session: RunnerSessionSnapshot): void {
    const channel = this.#getEventChannel(sessionKey(userId, session.id));
    channel.snapshot = session;
    channel.activeRunId = session.state === "running" ? session.activeRunId : undefined;
  }

  install(connection: Connection, sessionId: string): void {
    this.#routes.set(sessionKey(connection.runner.userId, sessionId), connection);
    connection.sessionIds.add(sessionId);
  }

  replace(connection: Connection, sessionIds: ReadonlySet<string>): void {
    this.remove(connection);
    for (const sessionId of sessionIds) this.install(connection, sessionId);
  }

  remove(connection: Connection): void {
    for (const sessionId of connection.sessionIds) {
      const key = sessionKey(connection.runner.userId, sessionId);
      if (this.#routes.get(key) !== connection) continue;
      this.#routes.delete(key);
      const channel = this.#eventChannels.get(key);
      if (!channel) continue;
      for (const listener of channel.listeners) {
        trySync(listener.close, () => undefined);
      }
      channel.listeners.clear();
    }
    connection.sessionIds.clear();
  }

  hasConflict(connection: Connection, sessions: RunnerSessionSnapshot[]): boolean {
    for (const session of sessions) {
      const key = sessionKey(connection.runner.userId, session.id);
      const route = this.#routes.get(key);
      if (!route || route === connection) continue;
      if (this.#isActive(route)) return true;
      this.#routes.delete(key);
      route.sessionIds.delete(session.id);
    }
    return false;
  }

  publish(
    connection: Connection,
    sessionId: string,
    event: SessionEventPayload,
    runId: string,
  ): boolean {
    const key = sessionKey(connection.runner.userId, sessionId);
    if (this.#routes.get(key) !== connection) return false;
    const channel = this.#getEventChannel(key);
    if (event.event.type === "session.state") {
      channel.activeRunId = event.event.stage === "running" ? runId : undefined;
      if (channel.snapshot) {
        channel.snapshot = {
          ...channel.snapshot,
          state: runnerSessionStateForProvisioningStage(event.event.stage),
          activeRunId: event.event.stage === "running" ? runId : undefined,
        };
      }
    }
    if ("cursor" in event) {
      if (channel.snapshot) {
        channel.snapshot = {
          ...channel.snapshot,
          lastEventCursor: event.cursor,
        };
      }
    }
    for (const listener of channel.listeners) {
      // A disconnected browser stream must not disrupt the runner connection.
      trySync(() => listener.publish(event), () => undefined);
    }
    return true;
  }

  subscribe(
    userId: string,
    sessionId: string,
    publish: (event: SessionEventPayload) => void,
    close: () => void,
  ): OwnedSessionEventSubscription {
    const channel = this.#getEventChannel(sessionKey(userId, sessionId));
    const listener = { publish, close };
    channel.listeners.add(listener);
    let subscribed = true;
    return {
      unsubscribe() {
        if (!subscribed) return;
        subscribed = false;
        channel.listeners.delete(listener);
      },
    };
  }

  clear(): void {
    for (const channel of this.#eventChannels.values()) {
      for (const listener of channel.listeners) {
        trySync(listener.close, () => undefined);
      }
      channel.listeners.clear();
    }
    this.#routes.clear();
    this.#eventChannels.clear();
  }

  #getEventChannel(key: string): SessionEventChannel {
    let channel = this.#eventChannels.get(key);
    if (!channel) {
      channel = { listeners: new Set() };
      this.#eventChannels.set(key, channel);
    }
    return channel;
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
