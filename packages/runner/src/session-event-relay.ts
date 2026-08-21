import {
  type RunnerClientMessage,
  SESSION_EVENT_MESSAGE_TYPE,
  type SessionConversationEvent,
  type SessionEventPayload,
  type SessionLiveEvent,
} from "@openorb/protocol";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import { readPiSessionEvents } from "@/src/pi-session-history.ts";
import type { RunnerSessionStore } from "@/src/session-store.ts";

export type SendRunnerMessage = (message: RunnerClientMessage) => void;

interface EventConsumer {
  token: object;
  send: SendRunnerMessage;
}

interface SessionCursorState {
  cursor: number;
  eventCursors: Map<string, number>;
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
  readonly #sessionOperations = new Map<string, Promise<void>>();
  readonly #cursorStates = new Map<string, SessionCursorState>();

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
      const existingOperations = [...this.#sessionOperations.values()];
      const handoff = Promise.withResolvers<void>();
      this.#publishGate = handoff.promise;
      using cleanup = new DisposableStack();
      cleanup.defer(() => handoff.resolve());

      await Promise.all(existingOperations);
      const [replayResult, replayBoundaryError] = await tryAsync(
        Promise.resolve().then(replay),
        (cause) => new SessionEventRelayError("Could not replay runner session state.", cause),
      );
      if (replayBoundaryError !== undefined) return err(replayBoundaryError);
      const [replayed, replayError] = replayResult;
      if (replayError !== undefined) {
        return err(
          replayError instanceof SessionEventRelayError ? replayError : new SessionEventRelayError(
            "Could not replay Pi session history.",
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
    const [events, historyError] = await this.#readHistory(sessionId);
    if (historyError !== undefined) return err(historyError);
    return ok(events.map((event, index) => ({ cursor: index + 1, event })));
  }

  async replayEvents(
    sessionId: string,
    afterCursor: number,
    send: (event: SessionEventPayload) => void | Promise<void>,
    complete?: (cursor: number) => void | Promise<void>,
  ): Promise<Result<number, SessionEventRelayError>> {
    const gate = this.#publishGate;
    return await this.#enqueueSessionOperation(sessionId, async () => {
      await gate;
      const [events, historyError] = await this.#readHistory(sessionId);
      if (historyError !== undefined) return err(historyError);
      this.#rememberHistory(sessionId, events);

      const reset = afterCursor === 0 || afterCursor > events.length;
      if (reset) {
        const [, resetError] = await tryAsync(
          Promise.resolve().then(() => send({ event: { type: "conversation.reset" } })),
          (cause) =>
            new SessionEventRelayError("Could not reset replayed conversation state.", cause),
        );
        if (resetError !== undefined) return err(resetError);
      }

      const firstEventIndex = reset ? 0 : afterCursor;
      for (let index = firstEventIndex; index < events.length; index += 1) {
        const event = events[index];
        if (!event) continue;
        const [, sendError] = await tryAsync(
          Promise.resolve().then(() => send({ cursor: index + 1, event })),
          (cause) => new SessionEventRelayError("Could not replay a Pi session event.", cause),
        );
        if (sendError !== undefined) return err(sendError);
      }
      if (complete) {
        const [, completeError] = await tryAsync(
          Promise.resolve().then(() => complete(events.length)),
          (cause) => new SessionEventRelayError("Could not complete Pi session replay.", cause),
        );
        if (completeError !== undefined) return err(completeError);
      }
      return ok(events.length);
    });
  }

  async publish(
    sessionId: string,
    correlationId: string,
    event: SessionConversationEvent,
  ): Promise<Result<void, SessionEventRelayError>> {
    const gate = this.#publishGate;
    return await this.#enqueueSessionOperation(sessionId, async () => {
      await gate;
      const [state, stateError] = await this.#cursorState(sessionId);
      if (stateError !== undefined) return err(stateError);
      const key = eventKey(event);
      if (state.eventCursors.has(key)) return ok(undefined);
      const cursor = state.cursor + 1;
      state.cursor = cursor;
      state.eventCursors.set(key, cursor);
      if (!this.#consumer) return ok(undefined);
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
        (cause) => new SessionEventRelayError("Could not send a Pi session event.", cause),
      );
      if (sendError !== undefined) return err(sendError);
      return ok(undefined);
    });
  }

  async publishLive(
    sessionId: string,
    correlationId: string,
    event: SessionLiveEvent,
  ): Promise<Result<void, SessionEventRelayError>> {
    const gate = this.#publishGate;
    return await this.#enqueueSessionOperation(sessionId, async () => {
      await gate;
      if (!this.#consumer) return ok(undefined);
      const [, sendError] = trySync(
        () =>
          this.#consumer?.send({
            version: 1,
            id: crypto.randomUUID(),
            type: SESSION_EVENT_MESSAGE_TYPE,
            sessionId,
            correlationId,
            payload: { event },
          }),
        (cause) => new SessionEventRelayError("Could not send a live session event.", cause),
      );
      if (sendError !== undefined) return err(sendError);
      return ok(undefined);
    });
  }

  async #readHistory(
    sessionId: string,
  ): Promise<Result<SessionConversationEvent[], SessionEventRelayError>> {
    const [paths, pathsError] = await this.#sessionStore.getSessionPiPaths(sessionId);
    if (pathsError !== undefined) {
      return err(new SessionEventRelayError("Could not locate Pi session history.", pathsError));
    }
    return await tryAsync(
      readPiSessionEvents(paths.sessionFile),
      (cause) => new SessionEventRelayError("Could not read Pi session history.", cause),
    );
  }

  async #cursorState(
    sessionId: string,
  ): Promise<Result<SessionCursorState, SessionEventRelayError>> {
    const existing = this.#cursorStates.get(sessionId);
    if (existing) return ok(existing);
    const [events, historyError] = await this.#readHistory(sessionId);
    if (historyError !== undefined) return err(historyError);
    return ok(this.#rememberHistory(sessionId, events));
  }

  #rememberHistory(
    sessionId: string,
    events: readonly SessionConversationEvent[],
  ): SessionCursorState {
    const state = {
      cursor: events.length,
      eventCursors: new Map(events.map((event, index) => [eventKey(event), index + 1])),
    };
    this.#cursorStates.set(sessionId, state);
    return state;
  }

  #enqueueSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionOperations.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#sessionOperations.set(sessionId, tail);
    void tail.then(() => {
      if (this.#sessionOperations.get(sessionId) === tail) {
        this.#sessionOperations.delete(sessionId);
      }
    });
    return result;
  }

  #enqueueAttachment<T>(
    operation: () => Promise<Result<T, SessionEventRelayError>>,
  ): Promise<Result<T, SessionEventRelayError>> {
    const result = this.#attachments.then(operation);
    this.#attachments = result.then(() => undefined);
    return result;
  }
}

function eventKey(event: SessionConversationEvent): string {
  switch (event.type) {
    case "user.message":
    case "assistant.completed":
      return `${event.type}:${event.messageId}`;
    case "tool.started":
    case "tool.completed":
      return `${event.type}:${event.toolCallId}`;
    case "context.compacted":
      return `${event.type}:${event.compactionId}`;
  }
}
