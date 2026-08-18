import {
  type RunnerClientMessage,
  SESSION_EVENT_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionProvisioningEvent,
} from "@openorb/protocol";

import type { RunnerSessionStore } from "@/src/session-store.ts";

export type SendRunnerMessage = (message: RunnerClientMessage) => void;

interface EventConsumer {
  token: object;
  send: SendRunnerMessage;
}

export class SessionEventRelay {
  readonly #sessionStore: RunnerSessionStore;
  #consumer?: EventConsumer;
  #operations: Promise<void> = Promise.resolve();

  constructor(sessionStore: RunnerSessionStore) {
    this.#sessionStore = sessionStore;
  }

  attach(
    send: SendRunnerMessage,
    replay: () => Promise<boolean>,
  ): Promise<() => void> {
    const token = {};
    return this.#enqueue(async () => {
      if (this.#consumer) throw new Error("A session event consumer is already attached.");
      if (!await replay()) return () => {};

      this.#consumer = { token, send };
      return () => {
        if (this.#consumer?.token === token) this.#consumer = undefined;
      };
    });
  }

  async readEvents(sessionId: string): Promise<SessionEventPayload[]> {
    const records = await this.#sessionStore.readEvents(sessionId);
    return records.map((record) => ({ cursor: record.cursor, event: record.event }));
  }

  publish(
    sessionId: string,
    correlationId: string,
    event: SessionProvisioningEvent,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const cursor = await this.#sessionStore.appendEvent(
        sessionId,
        event,
      );
      this.#consumer?.send({
        version: 1,
        id: crypto.randomUUID(),
        type: SESSION_EVENT_MESSAGE_TYPE,
        sessionId,
        correlationId,
        payload: { cursor, event },
      });
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
