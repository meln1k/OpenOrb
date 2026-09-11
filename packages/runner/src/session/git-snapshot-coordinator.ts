import type {
  GitMutationRevision,
  SessionGitFileAction,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Deferred, Effect, Exit, Schedule, type Scope, Stream } from "effect";

import type { AgentEnvironment } from "../environment/agent-environment.ts";
import type { GitSnapshotSynchronizer } from "./git-snapshot-synchronizer.ts";
import type { SessionGitFileUpdateResult } from "./git-snapshot.ts";
import type { RunnerSessionMetadata } from "./store.ts";

export interface GitSnapshotBoundaries<E> {
  readonly trigger: Effect.Effect<void>;
  readonly flush: Effect.Effect<Exit.Exit<void, E>>;
}

export interface GitWorkContext {
  readonly correlationId: string;
  readonly environment: AgentEnvironment;
  readonly metadata: RunnerSessionMetadata;
}

export interface GitMutationInput {
  readonly action: SessionGitFileAction;
  readonly path: string;
  readonly previousPath?: string;
}

export type GitFileUpdateAcceptance =
  | { readonly ok: true; readonly mutationRevision: GitMutationRevision }
  | { readonly ok: false; readonly message: string };

interface PendingGitMutation extends GitWorkContext {
  readonly input: GitMutationInput;
  readonly reply: Deferred.Deferred<GitFileUpdateAcceptance>;
}

interface PendingGitSnapshot extends GitWorkContext {
  readonly replies: Deferred.Deferred<void, unknown>[];
}

interface GitSnapshotCoordinatorOptions {
  readonly sessionId: SessionId;
  readonly advanceMutationRevision: (
    sessionId: SessionId,
  ) => Effect.Effect<GitMutationRevision, unknown>;
  readonly updateFile: (
    environment: AgentEnvironment,
    metadata: RunnerSessionMetadata,
    input: GitMutationInput,
  ) => Effect.Effect<SessionGitFileUpdateResult>;
  readonly snapshots: GitSnapshotSynchronizer;
  readonly requestRefresh: (wait: boolean) => Effect.Effect<void, unknown>;
  readonly recordIssue: (error: unknown) => Effect.Effect<void>;
}

export interface GitSnapshotCoordinator {
  readonly boundaries: GitSnapshotBoundaries<unknown>;
  readonly busy: () => boolean;
  readonly open: Effect.Effect<void>;
  readonly enqueueMutation: (
    context: GitWorkContext,
    input: GitMutationInput,
    reply: Deferred.Deferred<GitFileUpdateAcceptance>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly enqueueRefresh: (
    context: GitWorkContext,
    reply: Deferred.Deferred<void, unknown>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly quiesce: (
    context: GitWorkContext,
  ) => Effect.Effect<void, unknown, Scope.Scope>;
}

export const makeGitSnapshotCoordinator = Effect.fn("makeGitSnapshotCoordinator")(
  function* (
    options: GitSnapshotCoordinatorOptions,
  ): Effect.fn.Return<GitSnapshotCoordinator, never, Scope.Scope> {
    let mode: "open" | "quiescing" = "open";
    let workerActive = false;
    const mutations: PendingGitMutation[] = [];
    let snapshot: PendingGitSnapshot | undefined;

    const trigger = options.requestRefresh(false).pipe(Effect.ignore);
    const boundaries: GitSnapshotBoundaries<unknown> = {
      trigger,
      flush: Effect.exit(options.requestRefresh(true)),
    };
    yield* Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
      Stream.runForEach(() => trigger),
      Effect.forkScoped,
    );

    const requestSnapshot = (
      context: GitWorkContext,
      reply?: Deferred.Deferred<void, unknown>,
    ): void => {
      const replies = reply === undefined ? [] : [reply];
      snapshot = snapshot === undefined
        ? { ...context, replies }
        : { ...context, replies: [...snapshot.replies, ...replies] };
    };

    const settleSnapshotReplies = (
      replies: readonly Deferred.Deferred<void, unknown>[],
      outcome: Exit.Exit<void, unknown>,
    ) =>
      Effect.forEach(
        replies,
        (reply) => Deferred.done(reply, outcome),
        { discard: true },
      );

    const runWorker = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        while (true) {
          const mutation = mutations.shift();
          if (mutation !== undefined) {
            const result = yield* options.updateFile(
              mutation.environment,
              mutation.metadata,
              mutation.input,
            );
            requestSnapshot(mutation);
            if (!result.ok) {
              yield* Deferred.succeed(mutation.reply, result);
              continue;
            }
            const revision = yield* Effect.result(
              options.advanceMutationRevision(options.sessionId),
            );
            if (revision._tag === "Failure") {
              yield* options.recordIssue(revision.failure);
              yield* Deferred.succeed(mutation.reply, {
                ok: false,
                message:
                  "The Git index changed, but the update could not be tracked. Git changes are being refreshed.",
              });
            } else {
              yield* Deferred.succeed(mutation.reply, {
                ok: true,
                mutationRevision: revision.success,
              });
            }
            continue;
          }

          const current = snapshot;
          snapshot = undefined;
          if (current === undefined) {
            workerActive = false;
            return;
          }
          let outcome = yield* Effect.exit(
            options.snapshots.refresh(current.environment, current.metadata).pipe(Effect.asVoid),
          );
          if (Exit.isFailure(outcome)) {
            yield* options.recordIssue(outcome.cause);
          } else if (mutations.length === 0 && snapshot === undefined) {
            outcome = yield* Effect.exit(options.snapshots.publishPending(current.correlationId));
            if (Exit.isFailure(outcome)) yield* options.recordIssue(outcome.cause);
          }
          yield* settleSnapshotReplies(current.replies, outcome);
        }
      });

    const ensureWorker = (): Effect.Effect<void, never, Scope.Scope> => {
      if (workerActive) return Effect.void;
      workerActive = true;
      return Effect.forkScoped(
        runWorker().pipe(
          Effect.ensuring(Effect.sync(() => workerActive = false)),
        ),
      ).pipe(Effect.asVoid);
    };

    return {
      boundaries,
      busy: () => workerActive || mutations.length > 0 || snapshot !== undefined,
      open: Effect.sync(() => mode = "open"),
      enqueueMutation: (context, input, reply) =>
        Effect.suspend(() => {
          if (mode === "quiescing") {
            return Deferred.succeed(reply, {
              ok: false,
              message: "Files cannot be staged or unstaged while the session is stopping.",
            }).pipe(Effect.asVoid);
          }
          mutations.push({ ...context, input, reply });
          return ensureWorker();
        }),
      enqueueRefresh: (context, reply) =>
        Effect.suspend(() => {
          if (mode === "quiescing") return Deferred.succeed(reply, undefined).pipe(Effect.asVoid);
          requestSnapshot(context, reply);
          return ensureWorker();
        }),
      quiesce: (context) =>
        Effect.gen(function* () {
          mode = "quiescing";
          const completed = yield* Deferred.make<void, unknown>();
          requestSnapshot(context, completed);
          yield* ensureWorker();
          yield* Deferred.await(completed);
        }),
    };
  },
);
