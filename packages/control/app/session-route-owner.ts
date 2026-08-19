import {
  type RunnerSessionSnapshot,
  runnerSessionStateForProvisioningStage,
  type SessionEventPayload,
} from "@openorb/protocol";
import { trySync } from "@openorb/result";

const MAX_CACHED_SESSION_EVENTS = 1_024;

export interface SessionRouteConnection {
  readonly runner: { id: string; userId: string };
  readonly sessionIds: Set<string>;
}

interface SessionEventChannel {
  events: SessionEventPayload[];
  listeners: Set<(event: SessionEventPayload) => void>;
  snapshot?: RunnerSessionSnapshot;
}

export interface OwnedSessionEventSubscription {
  events: SessionEventPayload[];
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

  setSnapshot(userId: string, session: RunnerSessionSnapshot): void {
    this.#getEventChannel(sessionKey(userId, session.id)).snapshot = session;
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
      if (this.#routes.get(key) === connection) this.#routes.delete(key);
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

  publish(connection: Connection, sessionId: string, event: SessionEventPayload): boolean {
    const key = sessionKey(connection.runner.userId, sessionId);
    if (this.#routes.get(key) !== connection) return false;
    const channel = this.#getEventChannel(key);
    const lastCursor = channel.events.at(-1)?.cursor ?? 0;
    if (event.cursor <= lastCursor) return true;
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
      // A disconnected browser stream must not disrupt the runner connection.
      trySync(() => listener(event), () => undefined);
    }
    return true;
  }

  subscribe(
    userId: string,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ): OwnedSessionEventSubscription {
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

  clear(): void {
    this.#routes.clear();
    this.#eventChannels.clear();
  }

  #getEventChannel(key: string): SessionEventChannel {
    let channel = this.#eventChannels.get(key);
    if (!channel) {
      channel = { events: [], listeners: new Set() };
      this.#eventChannels.set(key, channel);
    }
    return channel;
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
