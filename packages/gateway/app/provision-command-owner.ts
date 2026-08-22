import {
  initialPromptPreview,
  type OrbSize,
  type SessionProvisionCommandPayload,
} from "@openorb/protocol";

import type { ProvisionSessionResult } from "@/app/runner-connection-gateway.ts";

export interface ProvisionCommandConnection {
  readonly runner: { userId: string };
  reservedCreateSessions: number;
  capacity?: { activeSessions: number };
}

interface PendingProvisionCommandBase<Connection> {
  connection: Connection;
  sessionId: string;
  resolve: (result: ProvisionSessionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type PendingProvisionCommand<Connection> =
  & PendingProvisionCommandBase<Connection>
  & (
    | {
      mode: "create";
      expectedProjectId: string;
      expectedRef: string;
      expectedBranchName: string;
      expectedInitialPromptPreview: string;
      expectedOrbSize: OrbSize;
    }
    | { mode: "retry" }
  );

export class ProvisionCommandOwner<Connection extends ProvisionCommandConnection> {
  readonly #commands = new Map<string, PendingProvisionCommand<Connection>>();
  readonly #sessions = new Set<string>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  hasSession(userId: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(userId, sessionId));
  }

  get(commandId: string): PendingProvisionCommand<Connection> | undefined {
    return this.#commands.get(commandId);
  }

  create(
    commandId: string,
    connection: Connection,
    sessionId: string,
    payload: SessionProvisionCommandPayload,
    resolve: (result: ProvisionSessionResult) => void,
  ): void {
    if (payload.mode === "create") connection.reservedCreateSessions++;
    const timeout = setTimeout(() => {
      this.settle(commandId, {
        status: "unavailable",
        message: "Runner did not acknowledge provisioning in time.",
      });
    }, this.#timeoutMs);
    this.#commands.set(commandId, {
      connection,
      sessionId,
      ...(payload.mode === "create"
        ? {
          mode: payload.mode,
          expectedProjectId: payload.projectId,
          expectedRef: payload.ref,
          expectedBranchName: payload.branchName,
          expectedInitialPromptPreview: initialPromptPreview(payload.initialPrompt),
          expectedOrbSize: payload.orbSize,
        }
        : { mode: payload.mode }),
      resolve,
      timeout,
    });
    this.#sessions.add(sessionKey(connection.runner.userId, sessionId));
  }

  settle(commandId: string, result: ProvisionSessionResult): void {
    const pending = this.#commands.get(commandId);
    if (!pending) return;
    this.#commands.delete(commandId);
    this.#sessions.delete(sessionKey(pending.connection.runner.userId, pending.sessionId));
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

  rejectForConnection(connection: Connection, message: string): void {
    for (const [commandId, pending] of this.#commands) {
      if (pending.connection === connection) {
        this.settle(commandId, { status: "unavailable", message });
      }
    }
  }

  settleAll(result: ProvisionSessionResult): void {
    for (const commandId of [...this.#commands.keys()]) this.settle(commandId, result);
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
