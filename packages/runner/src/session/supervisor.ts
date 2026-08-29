import {
  Context,
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  type Scope,
  Semaphore,
} from "effect";
import { type OrbSize, orbSizeResources } from "@openorb/protocol";
import type { ProvisionSessionPayload, SessionId } from "@openorb/protocol/runner-api";
import { ProvisionRejected, ProvisionSessionSuccess } from "@openorb/protocol/runner-api";

import { RunnerSessionDefinition } from "./definition.ts";
import {
  RunnerSessionDefinitionConflict,
  type RunnerSessionMetadata,
  RunnerSessionStore,
  type RunnerSessionStoreError,
} from "./store.ts";
import { type SessionWorker, SessionWorkerFactory } from "./worker.ts";

export interface SessionSupervisorOptions {
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly maxConcurrentSessions: number;
}

interface WorkerRegistryEntry {
  readonly worker: SessionWorker;
}

export interface SessionSupervisor {
  readonly activeSessionCount: () => number;
  readonly getActiveRunId: (sessionId: SessionId) => string | undefined;
  readonly findWorker: (sessionId: SessionId) => SessionWorker | undefined;
  readonly findOrRestoreWorker: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionWorker | undefined>;
  readonly provision: (
    payload: typeof ProvisionSessionPayload.Type,
  ) => Effect.Effect<ProvisionSessionSuccess, ProvisionRejected>;
}

export const SessionSupervisor: Context.Service<SessionSupervisor, SessionSupervisor> = Context
  .Service("@openorb/runner/SessionSupervisor");

export class SessionSupervisorInitializationError extends Data.TaggedError(
  "SessionSupervisorInitializationError",
)<{
  readonly message: string;
  readonly cause: RunnerSessionStoreError;
}> {}

type ProvisionAcceptance =
  | { readonly ok: true; readonly value: ProvisionSessionSuccess }
  | { readonly ok: false; readonly message: string };

/** Process-scoped admission and routing service for per-session actors. */
export function makeSessionSupervisor(
  options: SessionSupervisorOptions,
): Effect.Effect<
  SessionSupervisor,
  SessionSupervisorInitializationError,
  Scope.Scope | RunnerSessionStore | SessionWorkerFactory
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const workerFactory = yield* SessionWorkerFactory;
    const workers = MutableHashMap.empty<string, WorkerRegistryEntry>();
    const admission = yield* Semaphore.make(1);
    yield* reconcilePersistedSessions(store);

    const supportsOrbSize = (orbSize: OrbSize): boolean => {
      const resources = orbSizeResources(orbSize);
      return resources.cpuCount <= options.cpuCount && resources.memoryMiB <= options.memoryMiB;
    };
    const definitionFromCreate = (
      payload: Extract<typeof ProvisionSessionPayload.Type, { mode: "create" }>,
    ) =>
      new RunnerSessionDefinition({
        userId: payload.userId,
        projectId: payload.projectId,
        repositoryUrl: payload.repositoryUrl,
        ref: payload.ref,
        branchName: payload.branchName,
        gitAuthor: payload.gitAuthor,
        initialPrompt: payload.initialPrompt,
        model: payload.modelRuntime.model,
        orbSize: payload.orbSize,
      });
    const prepareCreate = Effect.fn("SessionSupervisor.prepareCreate")(function* (
      payload: Extract<typeof ProvisionSessionPayload.Type, { mode: "create" }>,
    ) {
      const ensured = yield* store.ensureSession(
        payload.sessionId,
        definitionFromCreate(payload),
      );
      const metadata = ensured.metadata;
      if (ensured.disposition === "created") return metadata;
      if (MutableHashMap.has(workers, metadata.id)) return metadata;
      if (metadata.state === "provisioning" || metadata.state === "running") {
        yield* store.updateProvisioning(payload.sessionId, {
          state: "error",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        });
        return yield* new InterruptedProvisioning({});
      }
      if (metadata.state === "error") {
        return yield* new SessionCreateRejected(
          "A failed session must use the explicit retry operation.",
        );
      }
      return metadata;
    });
    const prepareRetry = (
      payload: Extract<typeof ProvisionSessionPayload.Type, { mode: "retry" }>,
    ) =>
      Effect.gen(function* () {
        const metadata = yield* store.readMetadata(payload.sessionId);
        if (metadata.state !== "error") {
          return yield* new RetryRejected("Only a failed provisioning attempt can be retried.");
        }
        if (metadata.definition.model !== payload.modelRuntime.model) {
          return yield* new RetryRejected("A session retry must use its original model.");
        }
        if (!supportsOrbSize(metadata.definition.orbSize)) {
          return yield* new RetryRejected(unsupportedOrbSizeMessage(metadata.definition.orbSize));
        }
        return yield* store.updateProvisioning(payload.sessionId, {
          state: "created",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        });
      });
    const acceptProvision = (
      payload: typeof ProvisionSessionPayload.Type,
    ): Effect.Effect<ProvisionAcceptance> =>
      Effect.gen(function* () {
        if (payload.mode === "create" && !supportsOrbSize(payload.orbSize)) {
          return { ok: false, message: unsupportedOrbSizeMessage(payload.orbSize) } as const;
        }
        const preparation: Effect.Effect<RunnerSessionMetadata, unknown> = payload.mode === "create"
          ? prepareCreate(payload)
          : prepareRetry(payload);
        const prepared = yield* Effect.match(
          preparation,
          {
            onFailure: (error) => ({ error } as const),
            onSuccess: (metadata) => ({ metadata } as const),
          },
        );
        if ("error" in prepared) {
          return {
            ok: false,
            message: commandRejectionMessage(payload.mode, prepared.error),
          } as const;
        }
        const metadata = prepared.metadata;
        const snapshot = yield* store.getSessionSnapshot(metadata.id).pipe(Effect.option);
        if (Option.isNone(snapshot)) {
          return {
            ok: false,
            message: "The runner could not read the durable session snapshot.",
          } as const;
        }
        if (payload.mode === "create" && metadata.state === "ready") {
          return { ok: true, value: provisionSuccess(metadata, snapshot.value) } as const;
        }
        if (payload.mode === "retry") {
          const existing = Option.getOrUndefined(MutableHashMap.get(workers, metadata.id));
          if (existing) yield* existing.worker.shutdown;
          MutableHashMap.remove(workers, metadata.id);
        }
        const existing = Option.getOrUndefined(MutableHashMap.get(workers, metadata.id));
        if (existing) {
          return { ok: true, value: provisionSuccess(metadata, snapshot.value) } as const;
        }
        let activeWorkers = 0;
        for (const [, entry] of workers) if (entry.worker.active) activeWorkers++;
        if (activeWorkers >= options.maxConcurrentSessions) {
          return {
            ok: false,
            message: "The runner has reached its concurrent session limit.",
          } as const;
        }
        const worker = yield* workerFactory.spawn({
          metadata,
          ...(payload.mode === "create" && payload.githubToken !== undefined
            ? { githubToken: payload.githubToken }
            : {}),
          modelRuntime: payload.modelRuntime,
          correlationId: crypto.randomUUID(),
          restore: metadata.state === "ready",
        });
        MutableHashMap.set(workers, metadata.id, { worker });
        return { ok: true, value: provisionSuccess(metadata, snapshot.value) } as const;
      });
    const findOrRestoreWorker = (
      sessionId: SessionId,
    ): Effect.Effect<SessionWorker | undefined> => {
      const existing = Option.getOrUndefined(MutableHashMap.get(workers, sessionId));
      if (existing) return Effect.succeed(existing.worker);
      return admission.withPermit(Effect.gen(function* () {
        const current = Option.getOrUndefined(MutableHashMap.get(workers, sessionId));
        if (current) return current.worker;
        let activeWorkers = 0;
        for (const [, candidate] of workers) if (candidate.worker.active) activeWorkers++;
        if (activeWorkers >= options.maxConcurrentSessions) return undefined;
        const metadata = yield* store.readMetadata(sessionId).pipe(Effect.option);
        if (Option.isNone(metadata) || metadata.value.state !== "ready") return undefined;
        const worker = yield* workerFactory.spawn({
          metadata: metadata.value,
          correlationId: crypto.randomUUID(),
          restore: true,
        });
        MutableHashMap.set(workers, sessionId, { worker });
        return worker;
      }));
    };

    return SessionSupervisor.of({
      activeSessionCount: () => {
        let count = 0;
        for (const [, { worker }] of workers) {
          if (worker.active) count++;
        }
        return count;
      },
      getActiveRunId: (sessionId) =>
        Option.getOrUndefined(MutableHashMap.get(workers, sessionId))?.worker.activeRunId,
      findWorker: (sessionId) =>
        Option.getOrUndefined(MutableHashMap.get(workers, sessionId))?.worker,
      findOrRestoreWorker,
      provision: (payload) =>
        admission.withPermit(
          Effect.uninterruptible(acceptProvision(payload)),
        ).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : new ProvisionRejected({ sessionId: payload.sessionId, message: result.message })
          ),
        ),
    });
  });
}

export function sessionSupervisorLayer(
  options: SessionSupervisorOptions,
): Layer.Layer<
  SessionSupervisor,
  SessionSupervisorInitializationError,
  RunnerSessionStore | SessionWorkerFactory
> {
  return Layer.effect(SessionSupervisor, makeSessionSupervisor(options));
}

class RetryRejected extends Data.TaggedError("RetryRejected")<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

class InterruptedProvisioning extends Data.TaggedError("InterruptedProvisioning")<
  Record<PropertyKey, never>
> {}

class SessionCreateRejected extends Data.TaggedError("SessionCreateRejected")<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

function reconcilePersistedSessions(
  store: RunnerSessionStore,
): Effect.Effect<void, SessionSupervisorInitializationError> {
  return Effect.gen(function* () {
    const manifest = yield* store.loadSessionManifest().pipe(
      Effect.mapError((cause) =>
        new SessionSupervisorInitializationError({
          message: "Could not load durable sessions during supervisor startup.",
          cause,
        })
      ),
    );
    const corruptDirectories = new Set(
      manifest.errors.map((error) => error.sessionDirectory),
    );
    yield* Effect.forEach(
      manifest.sessions,
      (snapshot) => {
        if (corruptDirectories.has(snapshot.id)) return Effect.void;
        return Effect.gen(function* () {
          const metadata = yield* store.readMetadata(snapshot.id);
          const state = metadata.state === "running"
            ? "ready" as const
            : metadata.state === "created" || metadata.state === "provisioning"
            ? "error" as const
            : undefined;
          if (state === undefined) return;
          yield* store.updateProvisioning(metadata.id, {
            state,
            checkoutState: metadata.checkoutState,
            ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
          });
        }).pipe(
          Effect.mapError((cause) =>
            new SessionSupervisorInitializationError({
              message:
                `Could not reconcile durable session ${snapshot.id} during supervisor startup.`,
              cause,
            })
          ),
        );
      },
      { discard: true },
    );
  });
}

function provisionSuccess(
  metadata: RunnerSessionMetadata,
  snapshot: ProvisionSessionSuccess["session"],
): ProvisionSessionSuccess {
  return new ProvisionSessionSuccess({
    session: snapshot,
    ref: metadata.definition.ref,
    branchName: metadata.definition.branchName,
    checkoutState: metadata.checkoutState,
  });
}

function commandRejectionMessage(mode: "create" | "retry", error: unknown): string {
  if (error instanceof RetryRejected) return error.message;
  if (error instanceof SessionCreateRejected) return error.message;
  if (error instanceof InterruptedProvisioning) {
    return "The previous provisioning attempt was interrupted and must be retried explicitly.";
  }
  if (mode === "retry") return "The runner could not prepare this session retry.";
  if (error instanceof RunnerSessionDefinitionConflict) {
    return "This session already exists on the runner.";
  }
  return "The runner could not durably create the session.";
}

function unsupportedOrbSizeMessage(orbSize: OrbSize): string {
  const resources = orbSizeResources(orbSize);
  return `The runner cannot provision the ${orbSize} orb size (${resources.cpuCount} CPU${
    resources.cpuCount === 1 ? "" : "s"
  } and ${resources.memoryMiB / 1024} GB memory).`;
}
