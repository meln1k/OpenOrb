import type { AbortSessionResult } from "@/app/runner-connection-gateway.ts";

export interface AbortCommandConnection {
  readonly runner: { userId: string };
}

export interface PendingAbortCommand<Connection> {
  connection: Connection;
  sessionId: string;
}

interface OwnedAbortCommand<Connection> extends PendingAbortCommand<Connection> {
  resolve: (result: AbortSessionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class AbortCommandOwner<Connection extends AbortCommandConnection> {
  readonly #commands = new Map<string, OwnedAbortCommand<Connection>>();
  readonly #sessions = new Set<string>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  hasSession(userId: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(userId, sessionId));
  }

  get(commandId: string): PendingAbortCommand<Connection> | undefined {
    return this.#commands.get(commandId);
  }

  create(
    commandId: string,
    connection: Connection,
    sessionId: string,
    resolve: (result: AbortSessionResult) => void,
  ): void {
    const timeout = setTimeout(() => {
      this.settle(commandId, {
        status: "unavailable",
        message:
          "Runner did not acknowledge the abort in time. The run may still be stopping; the abort will not be retried automatically.",
      });
    }, this.#timeoutMs);
    this.#commands.set(commandId, { connection, sessionId, resolve, timeout });
    this.#sessions.add(sessionKey(connection.runner.userId, sessionId));
  }

  settle(commandId: string, result: AbortSessionResult): void {
    const pending = this.#commands.get(commandId);
    if (!pending) return;
    this.#commands.delete(commandId);
    this.#sessions.delete(sessionKey(pending.connection.runner.userId, pending.sessionId));
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  rejectForConnection(connection: Connection, message: string): void {
    for (const [commandId, pending] of this.#commands) {
      if (pending.connection === connection) {
        this.settle(commandId, { status: "unavailable", message });
      }
    }
  }

  settleAll(result: AbortSessionResult): void {
    for (const commandId of [...this.#commands.keys()]) this.settle(commandId, result);
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
