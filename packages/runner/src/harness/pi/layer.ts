import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EphemeralSessionEvent } from "@openorb/protocol/runner-api";
import { Deferred, Effect, Fiber, Layer, Queue, Result, type Scope, Stream } from "effect";

import {
  type ActiveAgentRun,
  AgentHarness,
  AgentHarnessError,
  type AgentHarnessOpenOptions,
  type AgentHarnessSession,
} from "../agent-harness.ts";
import { SessionEvents } from "../../session/events.ts";
import { makePiEventNormalizer } from "./event-normalizer.ts";
import {
  type ConversationProjectionSink,
  createOpenOrbPiSession,
  type OpenOrbPiSessionOptions,
} from "./session.ts";
import { createPiTools } from "./tools.ts";

export interface RawPiSession {
  readonly isIdle: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(
    input: string,
    options?: { preflightResult?: (success: boolean) => void },
  ): Promise<void>;
  followUp(input: string): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  dispose(): void;
}

export type CreateRawPiSession = (
  options: OpenOrbPiSessionOptions,
) => Effect.Effect<{ session: RawPiSession }, AgentHarnessError, Scope.Scope>;

type RawRunItem =
  | { readonly _tag: "Event"; readonly event: AgentSessionEvent }
  | { readonly _tag: "Completed"; readonly error?: AgentHarnessError };

type RunOutput =
  | { readonly _tag: "Event"; readonly event: EphemeralSessionEvent }
  | { readonly _tag: "End" }
  | { readonly _tag: "Failure"; readonly error: AgentHarnessError };

export function makePiAgentHarness(
  options: {
    readonly conversationProjection: ConversationProjectionSink;
    readonly create?: CreateRawPiSession;
  },
): AgentHarness {
  const create = options.create ?? createOpenOrbPiSession;
  return AgentHarness.of({
    open: (openOptions) => openPiSession(create, options.conversationProjection, openOptions),
  });
}

export function piAgentHarnessLayer(
  create?: CreateRawPiSession,
): Layer.Layer<AgentHarness, never, SessionEvents> {
  return Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const conversationProjection: ConversationProjectionSink = {
        activate: (sessionId, initial) =>
          events.activateConversation(sessionId, initial).pipe(
            Effect.mapError((cause) =>
              new AgentHarnessError("Could not activate the conversation cache.", cause)
            ),
          ),
      };
      return makePiAgentHarness({
        conversationProjection,
        ...(create === undefined ? {} : { create }),
      });
    }),
  );
}

function openPiSession(
  create: CreateRawPiSession,
  conversationProjection: ConversationProjectionSink,
  options: AgentHarnessOpenOptions,
): Effect.Effect<AgentHarnessSession, AgentHarnessError, Scope.Scope> {
  return Effect.gen(function* () {
    const created = yield* Effect.acquireRelease(
      create({
        sessionId: options.sessionId,
        runnerSessionFile: options.state.sessionFile,
        runnerAgentDirectory: options.state.agentDirectory,
        repositoryUrl: options.git.repositoryUrl,
        branchName: options.git.branchName,
        modelRuntime: options.modelRuntime,
        tools: createPiTools(options.environment),
        conversationProjection,
      }),
      ({ session }) =>
        Effect.gen(function* () {
          if (!session.isIdle) {
            yield* Effect.tryPromise(() => {
              session.clearQueue();
              return session.abort();
            }).pipe(Effect.ignore);
          }
          yield* Effect.sync(() => session.dispose());
        }),
    );
    const raw = created.session;

    return {
      start: (input) => startPiRun(raw, options.modelRuntime, input),
    };
  });
}

function startPiRun(
  raw: RawPiSession,
  modelRuntime: AgentHarnessOpenOptions["modelRuntime"],
  input: string,
): Effect.Effect<ActiveAgentRun, AgentHarnessError> {
  return Effect.gen(function* () {
    const rawEvents = yield* Queue.unbounded<RawRunItem>();
    const output = yield* Queue.unbounded<RunOutput>();
    const accepted = yield* Deferred.make<boolean>();
    const unsubscribe = raw.subscribe((event) => {
      Queue.offerUnsafe(rawEvents, { _tag: "Event", event });
    });

    let finalModelError: AgentHarnessError | undefined;
    const normalize = makePiEventNormalizer({
      secrets: [modelRuntime.credential.value],
      publishLive: (event) =>
        Queue.offer(output, { _tag: "Event", event }).pipe(
          Effect.asVoid,
        ),
    });

    const processor = yield* Stream.fromQueue(rawEvents).pipe(
      Stream.takeUntil((item) => item._tag === "Completed"),
      Stream.runForEach((item) => {
        if (item._tag === "Completed") {
          const error = item.error ?? finalModelError;
          return Queue.offer(
            output,
            error === undefined ? { _tag: "End" } : { _tag: "Failure", error },
          ).pipe(Effect.asVoid);
        }
        const event = item.event;
        return Effect.sync(() => {
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          finalModelError = event.message.stopReason === "error"
            ? new AgentHarnessError(
              "The agent run failed.",
              event.message.errorMessage ?? `The model stopped with ${event.message.stopReason}.`,
            )
            : undefined;
        }).pipe(Effect.andThen(normalize(event)));
      }),
      Effect.catch((cause) =>
        Queue.offer(output, {
          _tag: "Failure",
          error: cause instanceof AgentHarnessError
            ? cause
            : new AgentHarnessError("Could not normalize agent events.", cause),
        }).pipe(Effect.asVoid)
      ),
      Effect.forkChild({ startImmediately: true }),
    );

    const prompt = yield* Effect.tryPromise({
      try: () =>
        raw.prompt(input, {
          preflightResult: (success) => {
            Deferred.doneUnsafe(accepted, Effect.succeed(success));
          },
        }),
      catch: (cause) => new AgentHarnessError("The agent run failed.", cause),
    }).pipe(
      Effect.ensuring(Deferred.succeed(accepted, false)),
      Effect.onExit((exit) =>
        Queue.offer(rawEvents, {
          _tag: "Completed",
          ...(exit._tag === "Failure"
            ? { error: new AgentHarnessError("The agent run failed.", exit.cause) }
            : {}),
        }).pipe(Effect.asVoid)
      ),
      Effect.forkChild({ startImmediately: true }),
    );

    if (!(yield* Deferred.await(accepted))) {
      yield* Fiber.await(prompt);
      unsubscribe();
      yield* Queue.shutdown(rawEvents);
      yield* Queue.shutdown(output);
      return yield* new AgentHarnessError("The agent harness rejected the prompt.", undefined);
    }

    const events = Stream.fromQueue(output).pipe(
      Stream.takeUntil((item) => item._tag !== "Event"),
      Stream.filterMapEffect((item) => {
        switch (item._tag) {
          case "Event":
            return Effect.succeed(Result.succeed(item.event));
          case "End":
            return Effect.succeed(Result.fail(undefined));
          case "Failure":
            return Effect.fail(item.error);
        }
      }),
      Stream.ensuring(Fiber.join(processor).pipe(Effect.ignore)),
      Stream.ensuring(Effect.sync(unsubscribe)),
      Stream.ensuring(Queue.shutdown(rawEvents)),
      Stream.ensuring(Queue.shutdown(output)),
    );

    return {
      events,
      followUp: (input) =>
        Effect.tryPromise({
          try: () => raw.followUp(input),
          catch: (cause) =>
            new AgentHarnessError(
              "The agent harness did not confirm the follow-up handoff.",
              cause,
            ),
        }),
      abort: Effect.tryPromise({
        try: async () => {
          raw.clearQueue();
          await raw.abort();
        },
        catch: (cause) => new AgentHarnessError("Could not abort the active agent run.", cause),
      }),
    };
  });
}
