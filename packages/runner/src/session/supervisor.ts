import {
  Cause,
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  MutableHashMap,
  Option,
  type Scope,
  Semaphore,
} from "effect";
import { type OrbSize, orbSizeResources } from "@openorb/protocol";
import type {
  ProvisionSessionPayload,
  RunnerId,
  RunnerSessionSnapshot,
  SessionId,
  SessionIssue,
} from "@openorb/protocol/runner-api";
import {
  ProvisionRejected,
  ProvisionSessionSuccess,
  RunnerSessionSnapshot as RunnerSessionSnapshotValue,
} from "@openorb/protocol/runner-api";

import { RunnerSessionDefinition } from "./definition.ts";
import { runnerSessionDefinitionsEqual } from "./definition.ts";
import { SessionEvents } from "./events.ts";
import { type DeletionAcceptance, type SessionActor, SessionActorFactory } from "./actor/index.ts";
import { appendSessionIssues } from "./actor/issues.ts";
import {
  type RunnerSessionMetadata,
  RunnerSessionStore,
  type RunnerSessionStoreError,
} from "./store.ts";

export interface SessionSupervisorOptions {
  readonly runnerId: RunnerId;
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly idleTimeoutMs?: number;
}

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
const SESSION_RESTART_LIMIT = 3;
const SESSION_RESTART_WINDOW_MS = 30_000;

type SessionSlot =
  | {
    readonly _tag: "Running";
    readonly actor: SessionActor;
    readonly restartTimes: readonly number[];
  }
  | { readonly _tag: "Restarting"; readonly restartTimes: readonly number[] }
  | { readonly _tag: "Quarantined"; readonly issue: SessionIssue }
  | { readonly _tag: "Deleting" };

export interface SessionSupervisor {
  readonly activeSessionCount: () => number;
  readonly getActiveRunId: (sessionId: SessionId) => string | undefined;
  readonly withQuarantineFailure: (snapshot: RunnerSessionSnapshot) => RunnerSessionSnapshot;
  readonly findActor: (sessionId: SessionId) => SessionActor | undefined;
  readonly findOrRestoreActor: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionActor | undefined>;
  readonly provision: (
    payload: typeof ProvisionSessionPayload.Type,
  ) => Effect.Effect<ProvisionSessionSuccess, ProvisionRejected>;
  readonly deleteSession: (
    sessionId: SessionId,
  ) => Effect.Effect<DeletionAcceptance, RunnerSessionStoreError>;
}

export const SessionSupervisor: Context.Service<SessionSupervisor, SessionSupervisor> = Context
  .Service("@openorb/runner/SessionSupervisor");

export class SessionSupervisorInitializationError extends Data.TaggedError(
  "SessionSupervisorInitializationError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SessionSupervisorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSupervisorConfigurationError";
  }
}

type ProvisionAcceptance =
  | { readonly ok: true; readonly value: ProvisionSessionSuccess }
  | { readonly ok: false; readonly message: string };

interface PreparedProvision {
  readonly metadata: RunnerSessionMetadata;
  readonly mode: "create" | "retry" | "restore";
  readonly removeStorageOnFailure: boolean;
}

/** Process-scoped admission and routing service for per-session actors. */
export function makeSessionSupervisor(
  options: SessionSupervisorOptions,
): Effect.Effect<
  SessionSupervisor,
  SessionSupervisorInitializationError,
  Scope.Scope | RunnerSessionStore | SessionEvents | SessionActorFactory
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const actorFactory = yield* SessionActorFactory;
    const events = yield* SessionEvents;
    const scope = yield* Effect.scope;
    const slots = MutableHashMap.empty<string, SessionSlot>();
    const admission = yield* Semaphore.make(1);
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      return yield* Effect.die(
        new SessionSupervisorConfigurationError(
          "The session idle timeout must be a positive integer of milliseconds.",
        ),
      );
    }
    yield* reconcilePersistedSessions(store, actorFactory, idleTimeoutMs);

    function registerActor(
      sessionId: SessionId,
      actor: SessionActor,
      restartTimes: readonly number[] = [],
    ): Effect.Effect<void> {
      return Effect.sync(() => {
        MutableHashMap.set(slots, sessionId, { _tag: "Running", actor, restartTimes });
      }).pipe(
        Effect.andThen(Effect.forkIn(
          Effect.gen(function* () {
            const exit = yield* actor.awaitTermination;
            yield* admission.withPermit(Effect.suspend(() => {
              const current = getSlot(sessionId);
              if (current?._tag !== "Running" || current.actor !== actor) return Effect.void;
              if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
                MutableHashMap.remove(slots, sessionId);
                return Effect.void;
              }
              return restartActor(sessionId, current.restartTimes);
            }));
          }),
          scope,
        )),
        Effect.asVoid,
      );
    }

    function restartActor(
      sessionId: SessionId,
      priorRestartTimes: readonly number[],
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        let restartTimes = priorRestartTimes;
        while (true) {
          const reserved = reserveRestart(restartTimes);
          if (reserved === undefined) return yield* quarantine(sessionId);
          restartTimes = reserved;
          MutableHashMap.set(slots, sessionId, { _tag: "Restarting", restartTimes });
          const metadata = yield* Effect.result(store.readMetadata(sessionId));
          if (metadata._tag === "Failure") continue;
          const spawned = yield* Effect.result(actorFactory.spawn({
            metadata: metadata.success,
            mode: "reconcile",
            trigger: "actor-crash",
            correlationId: crypto.randomUUID(),
            idleTimeoutMs,
          }));
          if (spawned._tag === "Failure") continue;
          yield* registerActor(sessionId, spawned.success, restartTimes);
          return;
        }
      });
    }

    const reserveRestart = (restartTimes: readonly number[]): readonly number[] | undefined => {
      const now = Date.now();
      const recent = restartTimes.filter((time) => now - time < SESSION_RESTART_WINDOW_MS);
      return recent.length >= SESSION_RESTART_LIMIT ? undefined : [...recent, now];
    };

    function quarantine(
      sessionId: SessionId,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const issue: SessionIssue = {
          category: "actor-crash",
          severity: "failure",
          message:
            "The session actor repeatedly crashed and was quarantined. No command was replayed; restart the runner after checking its logs and durable session storage.",
          recovery: "none",
        };
        MutableHashMap.set(slots, sessionId, { _tag: "Quarantined", issue });
        yield* Effect.logError(
          `Session actor ${sessionId} was quarantined after repeated failures.`,
        );
        const metadata = yield* store.readMetadata(sessionId).pipe(Effect.option);
        if (Option.isNone(metadata)) return;
        yield* events.publishLive(sessionId, crypto.randomUUID(), {
          type: "session.state",
          stage: "failed",
          checkoutState: metadata.value.checkoutState,
          issues: appendSessionIssues(metadata.value.issues, [issue]),
        }).pipe(Effect.orDie);
      });
    }

    const shutdownActor = (sessionId: SessionId, actor: SessionActor) => {
      const current = getSlot(sessionId);
      if (current?._tag === "Running" && current.actor === actor) {
        MutableHashMap.remove(slots, sessionId);
      }
      return actor.shutdown;
    };

    const getSlot = (sessionId: SessionId): SessionSlot | undefined =>
      Option.getOrUndefined(MutableHashMap.get(slots, sessionId));

    const getActor = (sessionId: SessionId): SessionActor | undefined => {
      const slot = getSlot(sessionId);
      return slot?._tag === "Running" ? slot.actor : undefined;
    };

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
      const definition = definitionFromCreate(payload);
      const disposition = yield* store.ensureSessionStorage(payload.sessionId);
      if (disposition === "created") {
        const metadata: RunnerSessionMetadata = {
          id: payload.sessionId,
          definition,
          runnerId: options.runnerId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          state: "created",
          checkoutState: "pending",
          issues: [],
        };
        return {
          metadata,
          mode: "create",
          removeStorageOnFailure: true,
        } satisfies PreparedProvision;
      }
      const metadata = yield* store.readMetadata(payload.sessionId);
      if (!runnerSessionDefinitionsEqual(metadata.definition, definition)) {
        return yield* new SessionCreateRejected(
          "This session already exists on the runner.",
        );
      }
      if (getActor(metadata.id) !== undefined) {
        return {
          metadata,
          mode: "restore",
          removeStorageOnFailure: false,
        } satisfies PreparedProvision;
      }
      if (metadata.state === "provisioning" || metadata.state === "running") {
        const actor = yield* actorFactory.spawn({
          metadata,
          mode: "reconcile",
          trigger: "provision-request",
          correlationId: crypto.randomUUID(),
          idleTimeoutMs,
        });
        yield* actor.shutdown;
        return yield* new InterruptedProvisioning({});
      }
      if (metadata.state === "error") {
        return yield* new SessionCreateRejected(
          "A failed session must use the explicit retry operation.",
        );
      }
      return {
        metadata,
        mode: "restore",
        removeStorageOnFailure: false,
      } satisfies PreparedProvision;
    });
    const prepareRetry = (
      payload: Extract<typeof ProvisionSessionPayload.Type, { mode: "retry" }>,
    ) =>
      Effect.gen(function* () {
        const metadata = yield* store.readMetadata(payload.sessionId);
        if (metadata.state !== "error") {
          return yield* new RetryRejected("Only a failed provisioning attempt can be retried.");
        }
        if (
          metadata.issues.findLast((issue) => issue.severity === "failure")?.recovery !==
            "retry-provisioning"
        ) {
          return yield* new RetryRejected(
            "This session failure requires its offered environment recovery action.",
          );
        }
        if (metadata.definition.model !== payload.modelRuntime.model) {
          return yield* new RetryRejected("A session retry must use its original model.");
        }
        if (!supportsOrbSize(metadata.definition.orbSize)) {
          return yield* new RetryRejected(unsupportedOrbSizeMessage(metadata.definition.orbSize));
        }
        return {
          metadata,
          mode: "retry",
          removeStorageOnFailure: false,
        } satisfies PreparedProvision;
      });
    const acceptProvision = (
      payload: typeof ProvisionSessionPayload.Type,
    ): Effect.Effect<ProvisionAcceptance> =>
      Effect.gen(function* () {
        const slot = getSlot(payload.sessionId);
        if (slot?._tag === "Deleting") {
          return { ok: false, message: "This session is being deleted." } as const;
        }
        if (slot?._tag === "Quarantined") {
          return {
            ok: false,
            message: "This session actor is quarantined until the runner restarts.",
          } as const;
        }
        if (slot?._tag === "Restarting") {
          return { ok: false, message: "This session actor is restarting." } as const;
        }
        if (payload.mode === "create" && !supportsOrbSize(payload.orbSize)) {
          return { ok: false, message: unsupportedOrbSizeMessage(payload.orbSize) } as const;
        }
        const preparation: Effect.Effect<PreparedProvision, unknown> = payload.mode === "create"
          ? prepareCreate(payload)
          : prepareRetry(payload);
        const prepared = yield* Effect.match(
          preparation,
          {
            onFailure: (error) => ({ error } as const),
            onSuccess: (value) => ({ value } as const),
          },
        );
        if ("error" in prepared) {
          return {
            ok: false,
            message: commandRejectionMessage(payload.mode, prepared.error),
          } as const;
        }
        const { metadata } = prepared.value;
        if (payload.mode === "retry") {
          const existing = getActor(metadata.id);
          if (existing) yield* shutdownActor(metadata.id, existing);
        }
        const existing = getActor(metadata.id);
        if (
          existing ||
          (payload.mode === "create" && prepared.value.mode === "restore" &&
            metadata.state === "ready")
        ) {
          const snapshot = yield* store.getSessionSnapshot(metadata.id).pipe(Effect.option);
          return Option.isSome(snapshot)
            ? { ok: true, value: provisionSuccess(metadata, snapshot.value) } as const
            : {
              ok: false,
              message: "The runner could not read the durable session snapshot.",
            } as const;
        }
        const actorInput = prepared.value.mode === "restore"
          ? {
            metadata,
            mode: "restore" as const,
            correlationId: crypto.randomUUID(),
            idleTimeoutMs,
          }
          : {
            metadata,
            mode: prepared.value.mode,
            ...(payload.mode === "create" && payload.githubToken !== undefined
              ? { githubToken: payload.githubToken }
              : {}),
            modelRuntime: payload.modelRuntime,
            correlationId: crypto.randomUUID(),
            idleTimeoutMs,
          };
        const spawned = yield* Effect.result(actorFactory.spawn(actorInput));
        if (spawned._tag === "Failure") {
          if (prepared.value.removeStorageOnFailure) {
            yield* store.removeSessionStorage(metadata.id).pipe(Effect.ignore);
          }
          return {
            ok: false,
            message: "The runner could not start the session actor.",
          } as const;
        }
        const actor = spawned.success;
        yield* registerActor(metadata.id, actor);
        const durableMetadata = yield* store.readMetadata(metadata.id).pipe(Effect.option);
        const snapshot = yield* store.getSessionSnapshot(metadata.id).pipe(Effect.option);
        if (Option.isNone(durableMetadata) || Option.isNone(snapshot)) {
          return {
            ok: false,
            message: "The runner could not read the durable session snapshot.",
          } as const;
        }
        return {
          ok: true,
          value: provisionSuccess(durableMetadata.value, snapshot.value),
        } as const;
      });
    const findOrRestoreActor = (
      sessionId: SessionId,
    ): Effect.Effect<SessionActor | undefined> => {
      const slot = getSlot(sessionId);
      if (slot?._tag === "Running") return Effect.succeed(slot.actor);
      return admission.withPermit(Effect.gen(function* () {
        const current = getSlot(sessionId);
        if (current?._tag === "Running") return current.actor;
        if (current !== undefined) return undefined;
        const metadata = yield* store.readMetadata(sessionId).pipe(Effect.option);
        if (
          Option.isNone(metadata) ||
          (metadata.value.state !== "ready" && metadata.value.state !== "stopped" &&
            metadata.value.state !== "error")
        ) return undefined;
        const actor = yield* actorFactory.spawn({
          metadata: metadata.value,
          mode: "restore",
          correlationId: crypto.randomUUID(),
          idleTimeoutMs,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not restore session actor ${sessionId}: ${error.message}`,
            ).pipe(Effect.as(undefined))
          ),
        );
        if (actor === undefined) return undefined;
        yield* registerActor(sessionId, actor);
        return actor;
      }));
    };

    const deleteSession = (
      sessionId: SessionId,
    ): Effect.Effect<DeletionAcceptance, RunnerSessionStoreError> =>
      admission.withPermit(Effect.uninterruptible(Effect.gen(function* () {
        const slot = getSlot(sessionId);
        if (slot?._tag !== "Deleting") {
          const actor = slot?._tag === "Running" ? slot.actor : undefined;
          if (actor) {
            const acceptance = yield* actor.delete();
            if (!acceptance.ok) return acceptance;
          } else {
            const metadata = yield* store.readMetadata(sessionId).pipe(Effect.option);
            if (
              Option.isSome(metadata) && metadata.value.state !== "ready" &&
              metadata.value.state !== "stopped" && metadata.value.state !== "error"
            ) {
              return {
                ok: false,
                message: "Wait for active session work to finish before deleting the session.",
              } as const;
            }
          }
          MutableHashMap.set(slots, sessionId, { _tag: "Deleting" });
          if (actor) yield* actor.shutdown;
        }

        yield* store.removeSessionStorage(sessionId);
        MutableHashMap.remove(slots, sessionId);
        return { ok: true } as const;
      })));

    return SessionSupervisor.of({
      activeSessionCount: () => {
        let count = 0;
        for (const [, slot] of slots) {
          if (slot._tag === "Running" && slot.actor.active) count++;
        }
        return count;
      },
      getActiveRunId: (sessionId) => getActor(sessionId)?.activeRunId,
      withQuarantineFailure: (snapshot) => {
        const slot = getSlot(snapshot.id);
        return slot?._tag !== "Quarantined" ? snapshot : new RunnerSessionSnapshotValue({
          ...snapshot,
          state: "error",
          issues: appendSessionIssues(snapshot.issues, [slot.issue]),
        });
      },
      findActor: getActor,
      findOrRestoreActor,
      deleteSession,
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
  RunnerSessionStore | SessionEvents | SessionActorFactory
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
  actorFactory: SessionActorFactory,
  idleTimeoutMs: number,
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
          const actor = yield* actorFactory.spawn({
            metadata,
            mode: "reconcile",
            trigger: "runner-start",
            correlationId: crypto.randomUUID(),
            idleTimeoutMs,
          });
          yield* actor.shutdown;
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
  return "The runner could not durably create the session.";
}

function unsupportedOrbSizeMessage(orbSize: OrbSize): string {
  const resources = orbSizeResources(orbSize);
  return `The runner cannot provision the ${orbSize} orb size (${resources.cpuCount} CPU${
    resources.cpuCount === 1 ? "" : "s"
  } and ${resources.memoryMiB / 1024} GB memory).`;
}
