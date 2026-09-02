import { orbSizeResources } from "@openorb/protocol";
import type {
  SessionEnvironmentRecoveryMode,
  SessionIssue,
  SessionIssueCategory,
  SessionModelRuntime,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Scope } from "effect";

import {
  type AgentEnvironment,
  AgentEnvironmentProvider,
} from "../../environment/agent-environment.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import type { ProvisioningLogBudget, ProvisioningUpdate } from "./commands.ts";
import {
  commandDiagnostics,
  makeProvisioningLogBudget,
  redactedErrorMessage,
  type SessionReporter,
} from "./reporter.ts";
import { type RunnerSessionMetadata, RunnerSessionStore } from "../store.ts";
import { makeSessionIssue } from "./issues.ts";

export interface ProvisioningPrepared {
  readonly environment: AgentEnvironment;
  readonly modelRuntime: SessionModelRuntime;
  readonly correlationId: string;
  readonly logBudget: ProvisioningLogBudget;
  readonly issues: readonly SessionIssue[];
}

export interface ProvisioningFailed {
  readonly correlationId: string;
  readonly logBudget: ProvisioningLogBudget;
  readonly error: SessionActorError;
  readonly issue: SessionIssue;
}

export interface RestoredEnvironment {
  readonly environment: AgentEnvironment;
  readonly issues: readonly SessionIssue[];
  readonly release: Effect.Effect<void>;
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
    correlationId: string,
  ) => Effect.Effect<RestoredEnvironment, SessionActorError, Scope.Scope>;
  readonly recover: (
    metadata: RunnerSessionMetadata,
    mode: SessionEnvironmentRecoveryMode,
    githubToken: string | undefined,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
  ) => Effect.Effect<RestoredEnvironment, SessionActorError, Scope.Scope>;
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

  const restore: SessionProvisioner["restore"] = (metadata, correlationId) =>
    Effect.gen(function* () {
      const issues: SessionIssue[] = [];
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
        const setup = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
          ],
          correlationId,
          makeProvisioningLogBudget([]),
        );
        if (setup.exitCode !== 0) {
          issues.push(makeSessionIssue({
            category: "setup",
            severity: "warning",
            message:
              ".agents/setup failed while restoring the runner process, but the Pi session remains available.",
            diagnostics: commandDiagnostics(setup),
            recovery: "none",
          }));
        }
      }
      return { environment, issues, release: Effect.void };
    });

  const recover: SessionProvisioner["recover"] = (
    metadata,
    mode,
    githubToken,
    modelRuntime,
    correlationId,
  ) => {
    let recoveryScope: Scope.Closeable | undefined;
    const operation = Effect.gen(function* () {
      const issues: SessionIssue[] = [];
      const logBudget = makeProvisioningLogBudget([
        githubToken,
        modelRuntime.credential.value,
      ]);
      const checkpoint = mode === "resume-prior-checkpoint"
        ? yield* store.readCurrentCheckpoint(sessionId).pipe(Effect.mapError(actorError))
        : undefined;
      const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      recoveryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(recoveryScope!, Exit.void));
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
        ...(checkpoint === undefined ? {} : { resumeCheckpoint: checkpoint }),
      }).pipe(
        Effect.provideService(Scope.Scope, recoveryScope),
        Effect.mapError(actorError),
      );
      if (metadata.checkoutState === "available") {
        if (mode === "start-clean-vm") {
          yield* reporter.emitState(metadata, "setup", correlationId);
        }
        const hook = mode === "resume-prior-checkpoint" ? "resume" : "setup";
        const result = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            `if [ -x .agents/${hook} ]; then exec ./.agents/${hook}; fi`,
          ],
          correlationId,
          logBudget,
        );
        if (result.exitCode !== 0) {
          issues.push(makeSessionIssue({
            category: mode === "resume-prior-checkpoint" ? "resume-hook" : "setup",
            severity: "warning",
            message: mode === "resume-prior-checkpoint"
              ? ".agents/resume failed, but the prompt can still run so Pi can diagnose or repair the project."
              : ".agents/setup failed while starting a clean VM, but the recovered Pi session remains available.",
            diagnostics: commandDiagnostics(result),
            recovery: "none",
          }));
          const reportFailure = reporter.emitLog(
            correlationId,
            "stderr",
            `.agents/${hook} exited with status ${result.exitCode}; continuing to Pi so it can repair the project.\n`,
          );
          yield* mode === "resume-prior-checkpoint"
            ? reportFailure.pipe(Effect.ignore)
            : reportFailure;
        }
      }
      return { environment, issues, release: Scope.close(recoveryScope, Exit.void) };
    });
    return operation.pipe(
      Effect.onError(() => recoveryScope ? Scope.close(recoveryScope, Exit.void) : Effect.void),
      Effect.tapError((error) =>
        mode === "resume-prior-checkpoint"
          ? reporter.emitLog(
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
          : Effect.void
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
    const issues: SessionIssue[] = [];
    let failureCategory: SessionIssueCategory = "runner-storage";
    let failureMessage = "Session provisioning failed.";
    let failureDiagnostics: string | undefined;
    let metadata = initialMetadata;
    const operation = Effect.gen(function* () {
      yield* reporter.emitState(metadata, "starting-vm", correlationId);
      const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      failureCategory = "vm-start";
      failureMessage = "The Gondolin VM could not be started.";
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
        failureCategory = "runner-storage";
        failureMessage = "The session workspace could not be prepared for cloning.";
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
          const category = gitFailureCategory(`${clone.stdout}\n${clone.stderr}`);
          issues.push(makeSessionIssue({
            category,
            severity: "warning",
            message: category === "github-authentication"
              ? "GitHub authentication failed while cloning. The checkout is unavailable, but the stored prompt will still run."
              : "Repository cloning failed. The checkout is unavailable, but the stored prompt will still run.",
            diagnostics: commandDiagnostics(clone),
            recovery: "none",
          }));
          metadata = yield* sink.update({
            checkoutState: "unavailable",
          });
          yield* reporter.emitLog(
            correlationId,
            "stderr",
            "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
          );
        } else {
          failureCategory = "report";
          failureMessage = "Git could not report the cloned base commit.";
          const revision = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "rev-parse", "HEAD"],
            correlationId,
            logBudget,
          );
          if (revision.exitCode !== 0) {
            failureDiagnostics = commandDiagnostics(revision);
            return yield* new SessionActorError(
              failureMessage,
              undefined,
            );
          }
          yield* reporter.emitState(metadata, "creating-branch", correlationId);
          failureCategory = "clone";
          failureMessage = "Git could not create the session branch.";
          const branch = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "switch", "-c", metadata.definition.branchName],
            correlationId,
            logBudget,
          );
          if (branch.exitCode !== 0) {
            failureDiagnostics = commandDiagnostics(branch);
            return yield* new SessionActorError(
              failureMessage,
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
        failureCategory = "setup";
        failureMessage = "The project setup command could not be executed.";
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
          issues.push(makeSessionIssue({
            category: "setup",
            severity: "warning",
            message:
              ".agents/setup failed, but the stored prompt will still run so Pi can diagnose or repair the project.",
            diagnostics: commandDiagnostics(setup),
            recovery: "none",
          }));
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
        issues,
      });
    });
    return operation.pipe(
      Effect.catch((error) =>
        sink.failed({
          correlationId,
          logBudget,
          error: actorError(error),
          issue: makeSessionIssue({
            category: failureCategory,
            severity: "failure",
            message: failureMessage,
            diagnostics: failureDiagnostics ?? redactedErrorMessage(error, logBudget.secrets),
            recovery: "retry-provisioning",
          }),
        })
      ),
      Effect.asVoid,
    );
  };

  return { restore, recover, provision } satisfies SessionProvisioner;
});

function gitFailureCategory(
  diagnostics: string,
): "github-authentication" | "clone" {
  return /authentication failed|bad credentials|could not read username|http (?:401|403)|access denied/iu
      .test(diagnostics)
    ? "github-authentication"
    : "clone";
}
