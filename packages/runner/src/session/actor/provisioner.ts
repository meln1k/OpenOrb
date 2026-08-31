import { orbSizeResources } from "@openorb/protocol";
import type { SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Effect, Exit, Scope } from "effect";

import {
  type AgentEnvironment,
  AgentEnvironmentProvider,
} from "../../environment/agent-environment.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import type { ProvisioningLogBudget, ProvisioningUpdate } from "./commands.ts";
import {
  makeProvisioningLogBudget,
  redactedErrorMessage,
  type SessionReporter,
} from "./reporter.ts";
import { type RunnerSessionMetadata, RunnerSessionStore } from "../store.ts";

export interface ProvisioningPrepared {
  readonly environment: AgentEnvironment;
  readonly modelRuntime: SessionModelRuntime;
  readonly correlationId: string;
  readonly logBudget: ProvisioningLogBudget;
}

export interface ProvisioningFailed {
  readonly correlationId: string;
  readonly logBudget: ProvisioningLogBudget;
  readonly error: SessionActorError;
}

export interface ProvisioningSink {
  readonly update: (
    input: ProvisioningUpdate,
  ) => Effect.Effect<RunnerSessionMetadata, SessionActorError>;
  readonly environmentStarted: (
    environment: AgentEnvironment,
  ) => Effect.Effect<void, SessionActorError>;
  readonly prepared: (result: ProvisioningPrepared) => Effect.Effect<unknown>;
  readonly failed: (result: ProvisioningFailed) => Effect.Effect<unknown>;
}

export interface SessionProvisioner {
  readonly restore: (
    metadata: RunnerSessionMetadata,
  ) => Effect.Effect<AgentEnvironment, SessionActorError, Scope.Scope>;
  readonly resume: (
    metadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
  ) => Effect.Effect<AgentEnvironment, SessionActorError, Scope.Scope>;
  readonly provision: (
    initialMetadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
    sink: ProvisioningSink,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeSessionProvisioner = Effect.fn("makeSessionProvisioner")(function* (
  sessionId: RunnerSessionMetadata["id"],
  reporter: SessionReporter,
) {
  const store = yield* RunnerSessionStore;
  const environmentProvider = yield* AgentEnvironmentProvider;

  const restore: SessionProvisioner["restore"] = (metadata) =>
    Effect.gen(function* () {
      const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      const environment = yield* environmentProvider.make({
        workspacePath,
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.definition.repositoryUrl,
          gitAuthor: metadata.definition.gitAuthor,
        },
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
      }).pipe(Effect.mapError(actorError));
      if (metadata.checkoutState === "available") {
        yield* environment.runShell(
          "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
          { cwd: ".", onOutput: () => Effect.void },
        ).pipe(
          Effect.mapError(actorError),
          Effect.asVoid,
        );
      }
      return environment;
    });

  const resume: SessionProvisioner["resume"] = (
    metadata,
    githubToken,
    modelRuntime,
    correlationId,
  ) => {
    let resumedScope: Scope.Closeable | undefined;
    const operation = Effect.gen(function* () {
      const checkpoint = yield* store.readCurrentCheckpoint(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      resumedScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(resumedScope!, Exit.void));
      const environment = yield* environmentProvider.make({
        workspacePath,
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.definition.repositoryUrl,
          gitAuthor: metadata.definition.gitAuthor,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
        resumeCheckpoint: checkpoint,
      }).pipe(
        Effect.provideService(Scope.Scope, resumedScope),
        Effect.mapError(actorError),
      );
      if (metadata.checkoutState === "available") {
        const logBudget = makeProvisioningLogBudget([
          githubToken,
          modelRuntime.credential.value,
        ]);
        const result = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
          ],
          correlationId,
          logBudget,
        );
        if (result.exitCode !== 0) {
          yield* reporter.emitLog(
            correlationId,
            "stderr",
            `.agents/resume exited with status ${result.exitCode}; continuing to Pi so it can repair the project.\n`,
          ).pipe(Effect.ignore);
        }
      }
      return environment;
    });
    return operation.pipe(
      Effect.onError(() => resumedScope ? Scope.close(resumedScope, Exit.void) : Effect.void),
      Effect.tapError((error) =>
        reporter.emitLog(
          correlationId,
          "stderr",
          `Checkpoint resume failed: ${
            redactedErrorMessage(
              error,
              [githubToken, modelRuntime.credential.value].filter(
                (value): value is string => value !== undefined,
              ),
            )
          }\n`,
        ).pipe(Effect.ignore)
      ),
    );
  };

  const provision: SessionProvisioner["provision"] = (
    initialMetadata,
    githubToken,
    modelRuntime,
    correlationId,
    sink,
  ) => {
    const logBudget = makeProvisioningLogBudget([
      githubToken,
      modelRuntime.credential.value,
    ]);
    let metadata = initialMetadata;
    const operation = Effect.gen(function* () {
      yield* reporter.emitState(metadata, "starting-vm", correlationId);
      const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      const environment = yield* environmentProvider.make({
        workspacePath,
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.definition.repositoryUrl,
          gitAuthor: metadata.definition.gitAuthor,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
      }).pipe(Effect.mapError(actorError));
      yield* sink.environmentStarted(environment);

      if (metadata.checkoutState === "pending") {
        yield* store.clearSessionWorkspace(sessionId).pipe(Effect.mapError(actorError));
        yield* reporter.emitState(metadata, "cloning", correlationId);
        const clone = yield* reporter.runCommand(
          environment,
          [
            "/usr/bin/git",
            "clone",
            "--no-recurse-submodules",
            "--branch",
            metadata.definition.ref,
            "--single-branch",
            metadata.definition.repositoryUrl,
            ".",
          ],
          correlationId,
          logBudget,
        );
        if (clone.exitCode !== 0) {
          metadata = yield* sink.update({
            checkoutState: "unavailable",
          });
          yield* reporter.emitLog(
            correlationId,
            "stderr",
            "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
          );
        } else {
          const revision = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "rev-parse", "HEAD"],
            correlationId,
            logBudget,
            true,
          );
          if (revision.exitCode !== 0) {
            return yield* new SessionActorError(
              "Git could not report the cloned base commit.",
              undefined,
            );
          }
          yield* reporter.emitState(metadata, "creating-branch", correlationId);
          const branch = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "switch", "-c", metadata.definition.branchName],
            correlationId,
            logBudget,
          );
          if (branch.exitCode !== 0) {
            return yield* new SessionActorError(
              "Git could not create the session branch.",
              undefined,
            );
          }
          metadata = yield* sink.update({
            checkoutState: "available",
            baseCommit: revision.stdout.trim(),
          });
        }
      }

      if (metadata.checkoutState === "available") {
        yield* reporter.emitState(metadata, "setup", correlationId);
        const setup = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
          ],
          correlationId,
          logBudget,
        );
        if (setup.exitCode !== 0) {
          yield* reporter.emitLog(
            correlationId,
            "stderr",
            `.agents/setup exited with status ${setup.exitCode}; continuing to Pi so it can repair the project.\n`,
          );
        }
      }

      yield* sink.prepared({
        environment,
        modelRuntime,
        correlationId,
        logBudget,
      });
    });
    return operation.pipe(
      Effect.catch((error) =>
        sink.failed({
          correlationId,
          logBudget,
          error: actorError(error),
        })
      ),
      Effect.asVoid,
    );
  };

  return { restore, resume, provision } satisfies SessionProvisioner;
});
