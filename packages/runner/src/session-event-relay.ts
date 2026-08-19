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
  #attachments: Promise<void> = Promise.resolve();
  #publishGate: Promise<void> = Promise.resolve();
  readonly #publishes = new Map<string, Promise<void>>();

  constructor(sessionStore: RunnerSessionStore) {
    this.#sessionStore = sessionStore;
  }

  attach(
    send: SendRunnerMessage,
    replay: () => Promise<boolean>,
  ): Promise<() => void> {
    const token = {};
    return this.#enqueueAttachment(async () => {
      if (this.#consumer) throw new Error("A session event consumer is already attached.");
      const existingPublishes = [...this.#publishes.values()];
      const handoff = Promise.withResolvers<void>();
      this.#publishGate = handoff.promise;
      try {
        await Promise.all(existingPublishes);
        if (!await replay()) return () => {};

        this.#consumer = { token, send };
        return () => {
          if (this.#consumer?.token === token) this.#consumer = undefined;
        };
      } finally {
        handoff.resolve();
      }
    });
  }

  async readEvents(sessionId: string): Promise<SessionEventPayload[]> {
    const records = await this.#sessionStore.readEvents(sessionId);
    return records.map((record) => ({ cursor: record.cursor, event: record.event }));
  }

  replayEvents(
    sessionId: string,
    send: (event: SessionEventPayload) => void | Promise<void>,
  ): Promise<void> {
    return this.#sessionStore.forEachEvent(
      sessionId,
      (record) => send({ cursor: record.cursor, event: record.event }),
    );
  }

  publish(
    sessionId: string,
    correlationId: string,
    event: SessionProvisioningEvent,
  ): Promise<void> {
    const gate = this.#publishGate;
    const previous = this.#publishes.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      await gate;
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
    this.#publishes.set(sessionId, pending);
    return pending.finally(() => {
      if (this.#publishes.get(sessionId) === pending) this.#publishes.delete(sessionId);
    });
  }

  #enqueueAttachment<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#attachments.then(operation, operation);
    this.#attachments = result.then(() => undefined, () => undefined);
    return result;
  }
}
