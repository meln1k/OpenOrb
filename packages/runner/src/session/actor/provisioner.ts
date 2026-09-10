import { orbSizeResources } from "@openorb/protocol";
import type {
  SessionIssue,
  SessionIssueCategory,
  SessionModelRuntime,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Scope } from "effect";

import {
  AGENT_WORKSPACE,
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
    githubToken: string | undefined,
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

  const restore: SessionProvisioner["restore"] = (metadata, githubToken, correlationId) => {
    let restorationScope: Scope.Closeable | undefined;
    const operation = Effect.gen(function* () {
      const issues: SessionIssue[] = [];
      const logBudget = makeProvisioningLogBudget([githubToken]);
      const rootDiskPath = yield* store.getSessionRootDiskPath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      restorationScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(restorationScope!, Exit.void));
      const environment = yield* environmentProvider.make({
        rootDiskPath,
        sessionLabel: `openorb session ${sessionId}`,
        sessionId,
        github: {
          repositoryUrl: metadata.definition.repositoryUrl,
          gitAuthor: metadata.definition.gitAuthor,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
      }).pipe(
        Effect.provideService(Scope.Scope, restorationScope),
        Effect.mapError(actorError),
      );
      if (metadata.checkoutState === "available") {
        const resume = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
          ],
          correlationId,
          logBudget,
        );
        if (resume.exitCode !== 0) {
          issues.push(makeSessionIssue({
            category: "resume-hook",
            severity: "warning",
            message:
              ".agents/resume failed, but the prompt can still run so Pi can diagnose or repair the project.",
            diagnostics: commandDiagnostics(resume),
            recovery: "none",
          }));
          yield* reporter.emitLog(
            correlationId,
            "stderr",
            `.agents/resume exited with status ${resume.exitCode}; continuing to Pi so it can repair the project.\n`,
          ).pipe(Effect.ignore);
        }
      }
      return {
        environment,
        issues,
        release: Scope.close(restorationScope, Exit.void),
      };
    });
    return operation.pipe(
      Effect.onError(() =>
        restorationScope ? Scope.close(restorationScope, Exit.void) : Effect.void
      ),
      Effect.tapError((error) =>
        reporter.emitLog(
          correlationId,
          "stderr",
          `Environment restart failed: ${
            redactedErrorMessage(
              error,
              [githubToken].filter((value): value is string => value !== undefined),
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
    const issues: SessionIssue[] = [];
    let failureCategory: SessionIssueCategory = "runner-storage";
    let failureMessage = "Session provisioning failed.";
    let failureDiagnostics: string | undefined;
    let metadata = initialMetadata;
    const operation = Effect.gen(function* () {
      yield* reporter.emitState(metadata, "starting-vm", correlationId);
      const rootDiskPath = yield* store.getSessionRootDiskPath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      if (metadata.checkoutState === "pending") {
        failureCategory = "runner-storage";
        failureMessage = "The persistent root disk could not be initialized.";
        yield* environmentProvider.initializeRootDisk(rootDiskPath).pipe(
          Effect.mapError(actorError),
        );
      }
      failureCategory = "vm-start";
      failureMessage = "The Gondolin VM could not be started.";
      const environment = yield* environmentProvider.make({
        rootDiskPath,
        sessionLabel: `openorb session ${sessionId}`,
        sessionId,
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
        const cleared = yield* reporter.runCommand(
          environment,
          ["/usr/bin/find", AGENT_WORKSPACE, "-mindepth", "1", "-delete"],
          correlationId,
          logBudget,
        );
        if (cleared.exitCode !== 0) {
          failureDiagnostics = commandDiagnostics(cleared);
          return yield* new SessionActorError(failureMessage, undefined);
        }
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

  return { restore, provision } satisfies SessionProvisioner;
});

function gitFailureCategory(
  diagnostics: string,
): "github-authentication" | "clone" {
  return /authentication failed|bad credentials|could not read username|http (?:401|403)|access denied/iu
      .test(diagnostics)
    ? "github-authentication"
    : "clone";
}
