import {
  type RunnerClientMessage,
  SESSION_EVENT_MESSAGE_TYPE,
  type SessionEventPayload,
  type SessionProvisioningEvent,
} from "@openorb/protocol";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import type { RunnerSessionStore, RunnerSessionStoreError } from "@/src/session-store.ts";

export type SendRunnerMessage = (message: RunnerClientMessage) => void;

interface EventConsumer {
  token: object;
  send: SendRunnerMessage;
}

export class SessionEventRelayError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "SessionEventRelayError";
  }
}

export class SessionEventRelay {
  readonly #sessionStore: RunnerSessionStore;
  #consumer?: EventConsumer;
  #attachments: Promise<void> = Promise.resolve();
  #publishGate: Promise<void> = Promise.resolve();
  readonly #publishes = new Map<string, Promise<Result<void, SessionEventRelayError>>>();

  constructor(sessionStore: RunnerSessionStore) {
    this.#sessionStore = sessionStore;
  }

  attach(
    send: SendRunnerMessage,
    replay: () => Promise<Result<boolean, Error>>,
  ): Promise<Result<() => void, SessionEventRelayError>> {
    const token = {};
    return this.#enqueueAttachment(async () => {
      if (this.#consumer) {
        return err(
          new SessionEventRelayError("A session event consumer is already attached.", undefined),
        );
      }
      const existingPublishes = [...this.#publishes.values()];
      const handoff = Promise.withResolvers<void>();
      this.#publishGate = handoff.promise;
      using cleanup = new DisposableStack();
      cleanup.defer(() => handoff.resolve());

      const publishErrors = await Promise.all(
        existingPublishes.map(async (publish) => {
          const [, publishError] = await publish;
          if (publishError !== undefined) return publishError;
          return undefined;
        }),
      );
      const publishError = publishErrors.find((error) => error !== undefined);
      if (publishError !== undefined) return err(publishError);
      const [replayResult, replayBoundaryError] = await tryAsync(
        Promise.resolve().then(replay),
        (cause) => new SessionEventRelayError("Could not replay runner session state.", cause),
      );
      if (replayBoundaryError !== undefined) return err(replayBoundaryError);
      const [replayed, replayError] = replayResult;
      if (replayError !== undefined) {
        return err(
          replayError instanceof SessionEventRelayError ? replayError : new SessionEventRelayError(
            "Could not replay persisted session events.",
            replayError,
          ),
        );
      }
      if (!replayed) return ok(() => {});

      this.#consumer = { token, send };
      return ok(() => {
        if (this.#consumer?.token === token) this.#consumer = undefined;
      });
    });
  }

  async readEvents(
    sessionId: string,
  ): Promise<Result<SessionEventPayload[], SessionEventRelayError>> {
    const [records, storeError] = await this.#sessionStore.readEvents(sessionId);
    if (storeError !== undefined) return err(relayStoreError(sessionId, storeError));
    return ok(records.map((record) => ({ cursor: record.cursor, event: record.event })));
  }

  async replayEvents(
    sessionId: string,
    send: (event: SessionEventPayload) => void | Promise<void>,
  ): Promise<Result<void, SessionEventRelayError>> {
    let deliveryError: SessionEventRelayError | undefined;
    const [, storeError] = await this.#sessionStore.forEachEvent(
      sessionId,
      async (record) => {
        if (deliveryError !== undefined) return;
        const [, sendError] = await tryAsync(
          Promise.resolve().then(() => send({ cursor: record.cursor, event: record.event })),
          (cause) =>
            new SessionEventRelayError("Could not replay a persisted session event.", cause),
        );
        if (sendError !== undefined) {
          deliveryError = sendError;
          return;
        }
      },
    );
    if (storeError !== undefined) return err(relayStoreError(sessionId, storeError));
    return deliveryError === undefined ? ok(undefined) : err(deliveryError);
  }

  async publish(
    sessionId: string,
    correlationId: string,
    event: SessionProvisioningEvent,
  ): Promise<Result<void, SessionEventRelayError>> {
    const gate = this.#publishGate;
    const previous = this.#publishes.get(sessionId) ?? Promise.resolve(ok(undefined));
    const pending = previous.then(async () => {
      await gate;
      const [cursor, storeError] = await this.#sessionStore.appendEvent(
        sessionId,
        event,
      );
      if (storeError !== undefined) return err(relayStoreError(sessionId, storeError));
      if (this.#consumer) {
        const [, sendError] = trySync(
          () =>
            this.#consumer?.send({
              version: 1,
              id: crypto.randomUUID(),
              type: SESSION_EVENT_MESSAGE_TYPE,
              sessionId,
              correlationId,
              payload: { cursor, event },
            }),
          (cause) => new SessionEventRelayError("Could not send a persisted session event.", cause),
        );
        if (sendError !== undefined) return err(sendError);
      }
      return ok(undefined);
    });
    this.#publishes.set(sessionId, pending);
    const [, publishError] = await pending;
    if (publishError !== undefined) {
      if (this.#publishes.get(sessionId) === pending) this.#publishes.delete(sessionId);
      return err(publishError);
    }
    if (this.#publishes.get(sessionId) === pending) this.#publishes.delete(sessionId);
    return ok(undefined);
  }

  #enqueueAttachment<T>(
    operation: () => Promise<Result<T, SessionEventRelayError>>,
  ): Promise<Result<T, SessionEventRelayError>> {
    const result = this.#attachments.then(operation);
    this.#attachments = result.then(() => undefined);
    return result;
  }
}

function relayStoreError(
  sessionId: string,
  cause: RunnerSessionStoreError,
): SessionEventRelayError {
  return new SessionEventRelayError(
    `Session event persistence failed for runner session ${sessionId}.`,
    cause,
  );
}
