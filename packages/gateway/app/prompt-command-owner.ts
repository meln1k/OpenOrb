import type { PromptSessionResult } from "@/app/runner-connection-gateway.ts";

export interface PromptCommandConnection {
  readonly runner: { userId: string };
}

export interface PendingPromptCommand<Connection> {
  connection: Connection;
  sessionId: string;
}

interface OwnedPromptCommand<Connection> extends PendingPromptCommand<Connection> {
  resolve: (result: PromptSessionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class PromptCommandOwner<Connection extends PromptCommandConnection> {
  readonly #commands = new Map<string, OwnedPromptCommand<Connection>>();
  readonly #sessions = new Set<string>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  hasSession(userId: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(userId, sessionId));
  }

  get(commandId: string): PendingPromptCommand<Connection> | undefined {
    return this.#commands.get(commandId);
  }

  create(
    commandId: string,
    connection: Connection,
    sessionId: string,
    resolve: (result: PromptSessionResult) => void,
  ): void {
    const timeout = setTimeout(() => {
      this.settle(commandId, {
        status: "unavailable",
        message: "Runner did not acknowledge the prompt in time.",
      });
    }, this.#timeoutMs);
    this.#commands.set(commandId, { connection, sessionId, resolve, timeout });
    this.#sessions.add(sessionKey(connection.runner.userId, sessionId));
  }

  settle(commandId: string, result: PromptSessionResult): void {
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

  settleAll(result: PromptSessionResult): void {
    for (const commandId of [...this.#commands.keys()]) this.settle(commandId, result);
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
