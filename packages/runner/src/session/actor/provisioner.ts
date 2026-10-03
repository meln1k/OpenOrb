import { orbSizeResources } from "@openorb/protocol";
import type {
  SessionEnvironmentSecret,
  SessionIssue,
  SessionIssueCategory,
  SessionModelRuntime,
} from "@openorb/protocol/runner-api";
import { Effect, type Scope } from "effect";

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
  readonly logBudget: ProvisioningLogBudget;
  readonly issues: readonly SessionIssue[];
}

export interface ProvisioningFailed {
  readonly logBudget: ProvisioningLogBudget;
  readonly error: SessionActorError;
  readonly issue: SessionIssue;
}

export interface RestoredEnvironment {
  readonly environment: AgentEnvironment;
  readonly issues: readonly SessionIssue[];
}

export interface ProvisioningSink {
  readonly initializeDisk: (path: string) => Effect.Effect<void, SessionActorError>;
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
    environmentSecrets: readonly SessionEnvironmentSecret[] | undefined,
    environmentStarted: (environment: AgentEnvironment) => Effect.Effect<void>,
  ) => Effect.Effect<RestoredEnvironment, SessionActorError, Scope.Scope>;
  readonly provision: (
    initialMetadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    environmentSecrets: readonly SessionEnvironmentSecret[] | undefined,
    modelRuntime: SessionModelRuntime,
    sink: ProvisioningSink,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeSessionProvisioner = Effect.fn("makeSessionProvisioner")(function* (
  sessionId: RunnerSessionMetadata["id"],
  reporter: SessionReporter,
) {
  const store = yield* RunnerSessionStore;
  const environmentProvider = yield* AgentEnvironmentProvider;

  const restore: SessionProvisioner["restore"] = (
    metadata,
    githubToken,
    environmentSecrets,
    environmentStarted,
  ) => {
    const secretValues = environmentSecrets?.map((secret) => secret.value) ?? [];
    const operation = Effect.gen(function* () {
      const issues: SessionIssue[] = [];
      const logBudget = makeProvisioningLogBudget([githubToken, ...secretValues]);
      const rootDiskPath = yield* store.getSessionRootDiskPath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      const environment = yield* environmentProvider.make({
        rootDiskPath,
        sessionLabel: `openorb session ${sessionId}`,
        sessionId,
        github: {
          repositoryUrl: metadata.definition.repositoryUrl,
          gitAuthor: metadata.definition.gitAuthor,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        ...(environmentSecrets === undefined ? {} : { environmentSecrets }),
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
      }).pipe(
        Effect.mapError(actorError),
      );
      yield* environmentStarted(environment);
      if (metadata.checkoutState === "available") {
        const resume = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
          ],
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
            "stderr",
            `.agents/resume exited with status ${resume.exitCode}; continuing to Pi so it can repair the project.\n`,
          ).pipe(Effect.ignore);
        }
      }
      return {
        environment,
        issues,
      };
    });
    return operation.pipe(
      Effect.tapError((error) =>
        reporter.emitLog(
          "stderr",
          `Environment restart failed: ${
            redactedErrorMessage(
              error,
              [githubToken, ...secretValues].filter(
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
    environmentSecrets,
    modelRuntime,
    sink,
  ) => {
    const logBudget = makeProvisioningLogBudget([
      githubToken,
      modelRuntime.credential.value,
      ...(environmentSecrets?.map((secret) => secret.value) ?? []),
    ]);
    const issues: SessionIssue[] = [];
    let failureCategory: SessionIssueCategory = "runner-storage";
    let failureMessage = "Session provisioning failed.";
    let failureDiagnostics: string | undefined;
    let metadata = initialMetadata;
    const operation = Effect.gen(function* () {
      yield* reporter.emitState(metadata, "starting-vm");
      const rootDiskPath = yield* store.getSessionRootDiskPath(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const resources = orbSizeResources(metadata.definition.orbSize);
      if (metadata.checkoutState === "pending") {
        failureCategory = "runner-storage";
        failureMessage = "The persistent root disk could not be initialized.";
        yield* sink.initializeDisk(rootDiskPath);
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
        ...(environmentSecrets === undefined ? {} : { environmentSecrets }),
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
          logBudget,
        );
        if (cleared.exitCode !== 0) {
          failureDiagnostics = commandDiagnostics(cleared);
          return yield* new SessionActorError(failureMessage, undefined);
        }
        yield* reporter.emitState(metadata, "cloning");
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
            "stderr",
            "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
          );
        } else {
          failureCategory = "report";
          failureMessage = "Git could not report the cloned base commit.";
          const revision = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "rev-parse", "HEAD"],
            logBudget,
          );
          if (revision.exitCode !== 0) {
            failureDiagnostics = commandDiagnostics(revision);
            return yield* new SessionActorError(
              failureMessage,
              undefined,
            );
          }
          yield* reporter.emitState(metadata, "creating-branch");
          failureCategory = "clone";
          failureMessage = "Git could not create the session branch.";
          const branch = yield* reporter.runCommand(
            environment,
            ["/usr/bin/git", "switch", "-C", metadata.definition.branchName],
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
        yield* reporter.emitState(metadata, "setup");
        const setup = yield* reporter.runCommand(
          environment,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
          ],
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
            "stderr",
            `.agents/setup exited with status ${setup.exitCode}; continuing to Pi so it can repair the project.\n`,
          );
        }
      }

      yield* sink.prepared({
        environment,
        modelRuntime,
        logBudget,
        issues,
      });
    });
    return operation.pipe(
      Effect.catch((error) =>
        sink.failed({
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
