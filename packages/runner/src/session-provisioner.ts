import {
  MAX_PROVISIONING_LOG_BYTES,
  MAX_SESSION_EVENT_TEXT_BYTES,
  type OrbSize,
  orbSizeResources,
  type RunnerClientMessage,
  SESSION_ABORT_ACCEPTED_MESSAGE_TYPE,
  SESSION_ABORT_REJECTED_MESSAGE_TYPE,
  SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROMPT_REJECTED_MESSAGE_TYPE,
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionAbortCommand,
  type SessionModelRuntime,
  type SessionPromptCommand,
  type SessionProvisionCommand,
  type SessionProvisioningStage,
} from "@openorb/protocol";
import { join } from "node:path";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import type { DeveloperImage } from "@/src/developer-image.ts";
import { PiEventNormalizer } from "@/src/pi-event-normalizer.ts";
import { OpenOrbPiSessionFactory, type OpenOrbPiSessionOptions } from "@/src/pi-session-factory.ts";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createOpenOrbGondolinToolRuntime,
  type GondolinRuntimeError,
  type OpenOrbGondolinToolRuntime,
  type OpenOrbGondolinToolRuntimeOptions,
} from "@/src/gondolin-tools.ts";
import type {
  SendRunnerMessage,
  SessionEventRelay,
  SessionEventRelayError,
} from "@/src/session-event-relay.ts";
import type {
  RunnerSessionMetadata,
  RunnerSessionStore,
  RunnerSessionStoreError,
} from "@/src/session-store.ts";

const MAX_CAPTURED_COMMAND_BYTES = 4 * 1024;
const OUTPUT_TRUNCATED_MESSAGE = "\n[Provisioning output was truncated.]\n";

export interface SessionProvisionerOptions {
  sessionStore: RunnerSessionStore;
  eventRelay: SessionEventRelay;
  developerImage?: DeveloperImage;
  cpuCount: number;
  memoryMiB: number;
  createRuntime?: (
    options: Omit<OpenOrbGondolinToolRuntimeOptions, "developerImage">,
  ) => Promise<Result<ProvisioningRuntime, GondolinRuntimeError>>;
  createPiSession?: CreatePiSession;
}

export interface ProvisioningRuntime {
  tools: OpenOrbGondolinToolRuntime["tools"];
  run: OpenOrbGondolinToolRuntime["run"];
  close(): Promise<Result<void, GondolinRuntimeError>>;
}

interface ProvisioningPiSession {
  readonly isIdle: boolean;
  sessionManager: Pick<SessionManager, "getLeafEntry">;
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

type CreatePiSession = (
  options: OpenOrbPiSessionOptions,
) => Promise<{ session: ProvisioningPiSession }>;

interface ProvisioningLogBudget {
  remainingBytes: number;
  truncated: boolean;
  secrets: string[];
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
}

interface Utf8Slice {
  head: string;
  tail: string;
  bytes: number;
}

interface LivePiRun {
  runId: string;
  session: ProvisioningPiSession;
}

export class SessionProvisioner {
  readonly #sessionStore: RunnerSessionStore;
  readonly #eventRelay: SessionEventRelay;
  readonly #cpuCount: number;
  readonly #memoryMiB: number;
  readonly #createRuntime: NonNullable<SessionProvisionerOptions["createRuntime"]>;
  readonly #createPiSession: CreatePiSession;
  readonly #jobs = new Map<string, Promise<Result<void, SessionProvisioningError>>>();
  readonly #runtimes = new Map<string, ProvisioningRuntime>();
  readonly #livePiRuns = new Map<string, LivePiRun>();
  readonly #abortingSessionIds = new Set<string>();
  readonly #commandTails = new Map<string, Promise<void>>();
  readonly #activeSessionIds = new Set<string>();
  #closed = false;

  constructor(options: SessionProvisionerOptions) {
    this.#sessionStore = options.sessionStore;
    this.#eventRelay = options.eventRelay;
    this.#cpuCount = options.cpuCount;
    this.#memoryMiB = options.memoryMiB;
    this.#createPiSession = options.createPiSession ?? OpenOrbPiSessionFactory.create;
    if (options.createRuntime) {
      this.#createRuntime = options.createRuntime;
    } else {
      if (!options.developerImage) {
        throw new SessionProvisioningError(
          "A verified developer image is required for Gondolin provisioning.",
          undefined,
        );
      }
      const developerImage = options.developerImage;
      this.#createRuntime = (runtimeOptions) =>
        createOpenOrbGondolinToolRuntime({ ...runtimeOptions, developerImage });
    }
  }

  get activeSessionCount(): number {
    return this.#activeSessionIds.size;
  }

  getActiveRunId(sessionId: string): string | undefined {
    const liveRun = this.#livePiRuns.get(sessionId);
    return liveRun && !liveRun.session.isIdle ? liveRun.runId : undefined;
  }

  async handleCommand(
    command: SessionProvisionCommand,
    send: SendRunnerMessage,
  ): Promise<Result<void, SessionProvisioningError>> {
    if (this.#closed) {
      return sendProvisioningMessage(
        send,
        rejectedMessage(command, "The runner is shutting down."),
      );
    }
    if (this.#jobs.has(command.sessionId)) {
      return sendProvisioningMessage(
        send,
        rejectedMessage(command, "This session is already provisioning."),
      );
    }
    if (command.payload.mode === "create" && !this.#supportsOrbSize(command.payload.orbSize)) {
      return sendProvisioningMessage(
        send,
        rejectedMessage(command, unsupportedOrbSizeMessage(command.payload.orbSize)),
      );
    }

    const [metadata, preparationError] = command.payload.mode === "create"
      ? await this.#sessionStore.createSession({
        id: command.sessionId,
        projectId: command.payload.projectId,
        repositoryUrl: command.payload.repositoryUrl,
        ref: command.payload.ref,
        branchName: command.payload.branchName,
        initialPrompt: command.payload.initialPrompt,
        model: command.payload.modelRuntime.model,
        orbSize: command.payload.orbSize,
      })
      : await this.#prepareRetry(
        command.sessionId,
        command.payload.modelRuntime.model,
      );
    if (preparationError !== undefined) {
      const [, sendError] = sendProvisioningMessage(
        send,
        rejectedMessage(command, commandRejectionMessage(command, preparationError)),
      );
      if (sendError !== undefined) return err(sendError);
      return ok(undefined);
    }

    const [snapshot, snapshotError] = await this.#sessionStore.getSessionSnapshot(metadata.id);
    if (snapshotError !== undefined) {
      const [, sendError] = sendProvisioningMessage(
        send,
        rejectedMessage(command, "The runner could not read the durable session snapshot."),
      );
      if (sendError !== undefined) return err(sendError);
      return ok(undefined);
    }
    const [, sendError] = sendProvisioningMessage(send, {
      version: 1,
      id: crypto.randomUUID(),
      type: SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
      sessionId: metadata.id,
      correlationId: command.id,
      payload: {
        session: snapshot,
        ref: metadata.ref,
        branchName: metadata.branchName,
        checkoutState: metadata.checkoutState,
      },
    });
    if (sendError !== undefined) return err(sendError);

    const githubToken = command.payload.githubToken;
    const job = this.#provision(metadata, githubToken, command.payload.modelRuntime, command.id);
    this.#jobs.set(metadata.id, job);
    void job.then(() => {
      if (this.#jobs.get(metadata.id) === job) this.#jobs.delete(metadata.id);
    });
    return ok(undefined);
  }

  async handlePromptCommand(
    command: SessionPromptCommand,
    send: SendRunnerMessage,
  ): Promise<Result<void, SessionProvisioningError>> {
    return await this.#serializeSessionCommand(
      command.sessionId,
      () => this.#handlePromptCommand(command, send),
    );
  }

  async #handlePromptCommand(
    command: SessionPromptCommand,
    send: SendRunnerMessage,
  ): Promise<Result<void, SessionProvisioningError>> {
    if (this.#closed) {
      return sendPromptMessage(
        send,
        rejectedPromptMessage(command, "The runner is shutting down."),
      );
    }
    if (this.#abortingSessionIds.has(command.sessionId)) {
      return sendPromptMessage(
        send,
        rejectedPromptMessage(command, "The session is aborting."),
      );
    }

    const [metadata, metadataError] = await this.#sessionStore.readMetadata(command.sessionId);
    if (metadataError !== undefined) {
      return sendPromptMessage(
        send,
        rejectedPromptMessage(command, "The runner could not read this session."),
      );
    }
    if (metadata.model !== command.payload.modelRuntime.model) {
      return sendPromptMessage(
        send,
        rejectedPromptMessage(command, "The session model cannot change during continuation."),
      );
    }

    const liveRun = this.#livePiRuns.get(command.sessionId);
    if (liveRun) {
      if (liveRun.session.isIdle) {
        return sendPromptMessage(
          send,
          rejectedPromptMessage(command, "The active Pi run is settling."),
        );
      }
      const [, followUpError] = await tryAsync(
        liveRun.session.followUp(command.payload.prompt),
        (cause) => new SessionProvisioningError("Pi did not confirm the follow-up handoff.", cause),
      );
      if (followUpError !== undefined) {
        return sendPromptMessage(
          send,
          rejectedPromptMessage(
            command,
            "Pi could not confirm the follow-up; delivery may be uncertain and will not be retried automatically.",
          ),
        );
      }
      return sendPromptMessage(send, acceptedPromptMessage(command));
    }
    if (this.#jobs.has(command.sessionId)) {
      return sendPromptMessage(
        send,
        rejectedPromptMessage(command, "The session is not ready and idle."),
      );
    }

    const acceptance = Promise.withResolvers<Result<void, SessionProvisioningError>>();
    const job = this.#continuePrompt(command, send, acceptance.resolve);
    this.#jobs.set(command.sessionId, job);
    void job.then(() => {
      if (this.#jobs.get(command.sessionId) === job) this.#jobs.delete(command.sessionId);
    });
    return await acceptance.promise;
  }

  async handleAbortCommand(
    command: SessionAbortCommand,
    send: SendRunnerMessage,
  ): Promise<Result<void, SessionProvisioningError>> {
    return await this.#serializeSessionCommand(
      command.sessionId,
      () => this.#handleAbortCommand(command, send),
    );
  }

  #handleAbortCommand(
    command: SessionAbortCommand,
    send: SendRunnerMessage,
  ): Result<void, SessionProvisioningError> {
    if (this.#closed) {
      return sendAbortMessage(send, rejectedAbortMessage(command, "The runner is shutting down."));
    }
    const liveRun = this.#livePiRuns.get(command.sessionId);
    if (
      !liveRun || liveRun.runId !== command.payload.runId || liveRun.session.isIdle ||
      this.#abortingSessionIds.has(command.sessionId)
    ) {
      return sendAbortMessage(
        send,
        rejectedAbortMessage(command, "That Pi run is no longer active."),
      );
    }

    const [, clearError] = trySync(
      () => liveRun.session.clearQueue(),
      (cause) => new SessionProvisioningError("Could not clear Pi's queued follow-ups.", cause),
    );
    if (clearError !== undefined) {
      return sendAbortMessage(
        send,
        rejectedAbortMessage(command, "The queued follow-ups could not be cleared."),
      );
    }

    this.#abortingSessionIds.add(command.sessionId);
    const abort = tryAsync(
      liveRun.session.abort(),
      (cause) => new SessionProvisioningError("Could not abort the active Pi run.", cause),
    );
    void abort.then(() => {
      if (this.#livePiRuns.get(command.sessionId) === liveRun && liveRun.session.isIdle) {
        this.#abortingSessionIds.delete(command.sessionId);
      }
    });
    return sendAbortMessage(send, acceptedAbortMessage(command));
  }

  async close(): Promise<Result<void, SessionProvisioningError>> {
    if (this.#closed) return ok(undefined);
    this.#closed = true;
    await Promise.all([...this.#livePiRuns.values()].map(async ({ session }) => {
      trySync(() => session.clearQueue(), () => undefined);
      await tryAsync(session.abort(), () => undefined);
    }));
    await Promise.all(this.#jobs.values());
    const closeErrors = await Promise.all(
      [...this.#runtimes.values()].map(async (runtime) => {
        const [, closeError] = await runtime.close();
        if (closeError !== undefined) return closeError;
        return undefined;
      }),
    );
    this.#runtimes.clear();
    this.#livePiRuns.clear();
    this.#abortingSessionIds.clear();
    this.#commandTails.clear();
    this.#activeSessionIds.clear();
    const closeError = closeErrors.find((error) => error !== undefined);
    return closeError === undefined
      ? ok(undefined)
      : err(new SessionProvisioningError("Could not close a provisioning runtime.", closeError));
  }

  #serializeSessionCommand(
    sessionId: string,
    task: () =>
      | Result<void, SessionProvisioningError>
      | Promise<Result<void, SessionProvisioningError>>,
  ): Promise<Result<void, SessionProvisioningError>> {
    const previous = this.#commandTails.get(sessionId) ?? Promise.resolve();
    const command = previous.then(task, task);
    const tail = command.then(() => undefined, () => undefined);
    this.#commandTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#commandTails.get(sessionId) === tail) this.#commandTails.delete(sessionId);
    });
    return command;
  }

  async #prepareRetry(
    sessionId: string,
    model: string,
  ): Promise<Result<RunnerSessionMetadata, SessionProvisioningError>> {
    const [metadata, metadataError] = await this.#sessionStore.readMetadata(sessionId);
    if (metadataError !== undefined) return err(provisioningStoreError(sessionId, metadataError));
    if (metadata.state !== "error") {
      return err(new RetryRejected("Only a failed provisioning attempt can be retried."));
    }
    if (metadata.model !== model) {
      return err(new RetryRejected("A session retry must use its original model."));
    }
    if (!this.#supportsOrbSize(metadata.orbSize)) {
      return err(new RetryRejected(unsupportedOrbSizeMessage(metadata.orbSize)));
    }
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) {
      const [, closeError] = await runtime.close();
      if (closeError !== undefined) {
        return err(
          new SessionProvisioningError(
            `Could not close the previous runtime for session ${sessionId}.`,
            closeError,
          ),
        );
      }
      this.#runtimes.delete(sessionId);
      this.#activeSessionIds.delete(sessionId);
    }
    const [updated, updateError] = await this.#sessionStore.updateProvisioning(sessionId, {
      state: "created",
      checkoutState: metadata.checkoutState,
      ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
    });
    if (updateError !== undefined) return err(provisioningStoreError(sessionId, updateError));
    return ok(updated);
  }

  async #provision(
    initialMetadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
  ): Promise<Result<void, SessionProvisioningError>> {
    const sessionId = initialMetadata.id;
    const logBudget: ProvisioningLogBudget = {
      remainingBytes: MAX_PROVISIONING_LOG_BYTES,
      truncated: false,
      secrets: [githubToken, modelRuntime.credential.value].filter((value): value is string =>
        value !== undefined
      ),
    };
    let metadata = initialMetadata;

    this.#activeSessionIds.add(sessionId);
    using activeSessionCleanup = new DisposableStack();
    activeSessionCleanup.defer(() => {
      // Resource ownership is retained only when a runtime was successfully installed.
      if (!this.#runtimes.has(sessionId)) this.#activeSessionIds.delete(sessionId);
    });
    const [, provisionError] = await (async (): Promise<Result<void, SessionProvisioningError>> => {
      const [provisioning, provisioningError] = mapStoreResult(
        sessionId,
        await this.#sessionStore.updateProvisioning(sessionId, {
          state: "provisioning",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }),
      );
      if (provisioningError !== undefined) return err(provisioningError);
      metadata = provisioning;

      const [, startingEventError] = await this.#emitState(
        metadata,
        "starting-vm",
        correlationId,
      );
      if (startingEventError !== undefined) return err(startingEventError);

      const [workspacePath, workspaceError] = mapStoreResult(
        sessionId,
        await this.#sessionStore.getSessionWorkspacePath(sessionId),
      );
      if (workspaceError !== undefined) return err(workspaceError);
      const resources = orbSizeResources(metadata.orbSize);
      const [runtime, runtimeError] = await this.#createRuntime({
        workspacePath,
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.repositoryUrl,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: resources.cpuCount,
        memoryMiB: resources.memoryMiB,
      });
      if (runtimeError !== undefined) {
        return err(
          new SessionProvisioningError(
            `Could not start the provisioning runtime for session ${sessionId}.`,
            runtimeError,
          ),
        );
      }
      this.#runtimes.set(sessionId, runtime);

      if (metadata.checkoutState === "pending") {
        const [, clearError] = await tryAsync(
          clearWorkspace(workspacePath),
          (cause) =>
            new SessionProvisioningError(
              `Could not clear the workspace for session ${sessionId}.`,
              cause,
            ),
        );
        if (clearError !== undefined) return err(clearError);
        const [, cloningEventError] = await this.#emitState(
          metadata,
          "cloning",
          correlationId,
        );
        if (cloningEventError !== undefined) return err(cloningEventError);
        const [clone, cloneError] = await this.#runCommand(
          runtime,
          [
            "/usr/bin/git",
            "clone",
            "--no-recurse-submodules",
            "--branch",
            metadata.ref,
            "--single-branch",
            metadata.repositoryUrl,
            ".",
          ],
          sessionId,
          correlationId,
          logBudget,
        );
        if (cloneError !== undefined) return err(cloneError);
        if (clone.exitCode !== 0) {
          const [unavailable, updateError] = mapStoreResult(
            sessionId,
            await this.#sessionStore.updateProvisioning(sessionId, {
              state: "provisioning",
              checkoutState: "unavailable",
            }),
          );
          if (updateError !== undefined) return err(updateError);
          metadata = unavailable;
          const [, logError] = await this.#emitLog(
            sessionId,
            correlationId,
            "stderr",
            "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
          );
          if (logError !== undefined) return err(logError);
        } else {
          const [revision, revisionError] = await this.#runCommand(
            runtime,
            ["/usr/bin/git", "rev-parse", "HEAD"],
            sessionId,
            correlationId,
            logBudget,
            true,
          );
          if (revisionError !== undefined) return err(revisionError);
          if (revision.exitCode !== 0) {
            return err(
              new SessionProvisioningError(
                "Git could not report the cloned base commit.",
                undefined,
              ),
            );
          }
          const baseCommit = revision.stdout.trim();

          const [, branchEventError] = await this.#emitState(
            metadata,
            "creating-branch",
            correlationId,
          );
          if (branchEventError !== undefined) return err(branchEventError);
          const [branch, branchError] = await this.#runCommand(
            runtime,
            ["/usr/bin/git", "switch", "-c", metadata.branchName],
            sessionId,
            correlationId,
            logBudget,
          );
          if (branchError !== undefined) return err(branchError);
          if (branch.exitCode !== 0) {
            return err(
              new SessionProvisioningError(
                "Git could not create the session branch.",
                undefined,
              ),
            );
          }
          const [available, updateError] = mapStoreResult(
            sessionId,
            await this.#sessionStore.updateProvisioning(sessionId, {
              state: "provisioning",
              checkoutState: "available",
              baseCommit,
            }),
          );
          if (updateError !== undefined) return err(updateError);
          metadata = available;
        }
      }

      if (metadata.checkoutState === "available") {
        const [, setupEventError] = await this.#emitState(metadata, "setup", correlationId);
        if (setupEventError !== undefined) return err(setupEventError);
        const [setup, setupError] = await this.#runCommand(
          runtime,
          [
            "/bin/sh",
            "-lc",
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
          ],
          sessionId,
          correlationId,
          logBudget,
        );
        if (setupError !== undefined) return err(setupError);
        if (setup.exitCode !== 0) {
          const [, logError] = await this.#emitLog(
            sessionId,
            correlationId,
            "stderr",
            `.agents/setup exited with status ${setup.exitCode}; continuing to Pi so it can repair the project.\n`,
          );
          if (logError !== undefined) return err(logError);
        }
      }

      const [, piRunError] = await this.#runInitialPrompt(
        metadata,
        runtime,
        modelRuntime,
        correlationId,
      );
      if (piRunError !== undefined) return err(piRunError);

      const [ready, readyError] = mapStoreResult(
        sessionId,
        await this.#sessionStore.updateProvisioning(sessionId, {
          state: "ready",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }),
      );
      if (readyError !== undefined) return err(readyError);
      metadata = ready;
      return await this.#emitState(metadata, "ready", correlationId);
    })();

    if (provisionError !== undefined) {
      const [storedCurrent, readError] = await this.#sessionStore.readMetadata(sessionId);
      if (readError !== undefined) return err(provisionError);
      const current = storedCurrent ?? metadata;
      const [storedFailed, updateError] = await this.#sessionStore.updateProvisioning(sessionId, {
        state: "error",
        checkoutState: current.checkoutState,
        ...(current.baseCommit === undefined ? {} : { baseCommit: current.baseCommit }),
      });
      if (updateError !== undefined) return err(provisionError);
      const failed = storedFailed ?? current;
      const [, logError] = await this.#emitLog(
        sessionId,
        correlationId,
        "stderr",
        `Provisioning failed: ${
          redactedErrorMessage(
            provisionError,
            logBudget.secrets,
          )
        }\n`,
      );
      if (logError !== undefined) return err(provisionError);
      const [, stateError] = await this.#emitState(failed, "failed", correlationId);
      if (stateError !== undefined) return err(provisionError);
      return err(provisionError);
    }
    return ok(undefined);
  }

  async #runInitialPrompt(
    metadata: RunnerSessionMetadata,
    runtime: ProvisioningRuntime,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
  ): Promise<Result<void, SessionProvisioningError>> {
    return await this.#runPiPrompt(
      metadata,
      runtime,
      modelRuntime,
      correlationId,
      metadata.initialPrompt,
    );
  }

  async #continuePrompt(
    command: SessionPromptCommand,
    send: SendRunnerMessage,
    settleAcceptance: (result: Result<void, SessionProvisioningError>) => void,
  ): Promise<Result<void, SessionProvisioningError>> {
    const reject = (message: string): Result<void, SessionProvisioningError> => {
      const [, sendError] = sendPromptMessage(send, rejectedPromptMessage(command, message));
      if (sendError !== undefined) {
        settleAcceptance(err(sendError));
        return err(sendError);
      }
      settleAcceptance(ok(undefined));
      return ok(undefined);
    };
    const [metadata, metadataError] = await this.#sessionStore.readMetadata(command.sessionId);
    if (metadataError !== undefined) return reject("The runner could not read this session.");
    if (metadata.state !== "ready") return reject("The session is not ready and idle.");
    if (metadata.model !== command.payload.modelRuntime.model) {
      return reject("The session model cannot change during continuation.");
    }
    const runtime = this.#runtimes.get(command.sessionId);
    if (!runtime) return reject("This session orb is unavailable.");

    const preflight = Promise.withResolvers<boolean>();
    const promptRun = this.#runPiPrompt(
      metadata,
      runtime,
      command.payload.modelRuntime,
      command.id,
      command.payload.prompt,
      (success) => preflight.resolve(success),
    );
    const acceptedByPi = await Promise.race([
      preflight.promise,
      promptRun.then(() => false),
    ]);
    if (!acceptedByPi) {
      const [, promptError] = await promptRun;
      if (promptError !== undefined) {
        const [, readyError] = await this.#restoreReady(metadata, command.id);
        if (readyError !== undefined) {
          return reject("The session could not recover after rejecting the prompt.");
        }
        return reject("Pi did not accept the prompt.");
      }
      const [, readyError] = await this.#restoreReady(metadata, command.id);
      if (readyError !== undefined) {
        return reject("The session could not recover after rejecting the prompt.");
      }
      return reject("Pi did not accept the prompt.");
    }

    settlePromptAcceptance(
      send,
      acceptedPromptMessage(command),
      settleAcceptance,
    );

    const [, promptError] = await promptRun;
    if (promptError !== undefined) {
      const [, readyError] = await this.#restoreReady(metadata, command.id);
      if (readyError !== undefined) return err(readyError);
      return err(promptError);
    }
    const [, readyError] = await this.#restoreReady(metadata, command.id);
    if (readyError !== undefined) return err(readyError);
    return ok(undefined);
  }

  async #runPiPrompt(
    metadata: RunnerSessionMetadata,
    runtime: ProvisioningRuntime,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
    prompt: string,
    preflightResult?: (success: boolean) => void,
  ): Promise<Result<void, SessionProvisioningError>> {
    const [piPaths, pathsError] = mapStoreResult(
      metadata.id,
      await this.#sessionStore.getSessionPiPaths(metadata.id),
    );
    if (pathsError !== undefined) return err(pathsError);
    const [pi, creationError] = await tryAsync(
      this.#createPiSession({
        runnerSessionFile: piPaths.sessionFile,
        runnerAgentDirectory: piPaths.agentDirectory,
        modelRuntime,
        tools: runtime.tools,
      }),
      (cause) => new SessionProvisioningError("Could not create the Pi session.", cause),
    );
    if (creationError !== undefined) return err(creationError);
    if (!pi.session.isIdle) {
      pi.session.dispose();
      return err(new SessionProvisioningError("The Pi session is not idle.", undefined));
    }

    const piPublicationReady = Promise.withResolvers<void>();
    let publishPiEvents = false;
    const waitForPiPublication = async (): Promise<boolean> => {
      await piPublicationReady.promise;
      return publishPiEvents;
    };
    const normalizer = new PiEventNormalizer({
      secrets: [modelRuntime.credential.value],
      getCompactionEntryId: () => {
        const entry = pi.session.sessionManager.getLeafEntry();
        return entry?.type === "compaction" ? entry.id : undefined;
      },
      getMessageEntryId: (message) => {
        const entry = pi.session.sessionManager.getLeafEntry();
        return entry?.type === "message" && entry.message === message ? entry.id : undefined;
      },
      publishConversation: async (event) => {
        if (!await waitForPiPublication()) return;
        const [, relayError] = mapRelayResult(
          metadata.id,
          await this.#eventRelay.publish(metadata.id, correlationId, event),
        );
        if (relayError !== undefined) throw relayError;
      },
      publishLive: async (event) => {
        if (!await waitForPiPublication()) return;
        const [, relayError] = mapRelayResult(
          metadata.id,
          await this.#eventRelay.publishLive(metadata.id, correlationId, event),
        );
        if (relayError !== undefined) throw relayError;
      },
    });
    using cleanup = new DisposableStack();
    cleanup.defer(() => pi.session.dispose());
    cleanup.defer(() => piPublicationReady.resolve());
    let finalPiError: Error | undefined;
    const unsubscribe = pi.session.subscribe((event) => {
      normalizer.handle(event);
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      finalPiError = event.message.stopReason === "error"
        ? new Error(event.message.errorMessage ?? `Pi stopped with ${event.message.stopReason}.`)
        : undefined;
    });
    cleanup.defer(unsubscribe);
    const liveRun = { runId: correlationId, session: pi.session };
    this.#livePiRuns.set(metadata.id, liveRun);
    cleanup.defer(() => {
      if (this.#livePiRuns.get(metadata.id) === liveRun) this.#livePiRuns.delete(metadata.id);
      this.#abortingSessionIds.delete(metadata.id);
    });
    const piPreflight = Promise.withResolvers<boolean>();
    const promptRun = tryAsync(
      pi.session.prompt(
        prompt,
        { preflightResult: piPreflight.resolve },
      ),
      (cause) => new SessionProvisioningError("The Pi run failed.", cause),
    );
    const acceptedByPi = await Promise.race([
      piPreflight.promise,
      promptRun.then(() => false),
    ]);
    if (!acceptedByPi) {
      preflightResult?.(false);
      const [, promptError] = await promptRun;
      if (promptError !== undefined) return err(promptError);
      return err(new SessionProvisioningError("Pi did not accept the prompt.", undefined));
    }

    if (!pi.session.isIdle) {
      const [running, runningError] = mapStoreResult(
        metadata.id,
        await this.#sessionStore.updateProvisioning(metadata.id, {
          state: "running",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }),
      );
      if (runningError !== undefined) {
        preflightResult?.(false);
        trySync(() => pi.session.clearQueue(), () => undefined);
        await tryAsync(pi.session.abort(), () => undefined);
        return err(runningError);
      }
      const [, runningEventError] = await this.#emitState(running, "running", correlationId);
      if (runningEventError !== undefined) {
        preflightResult?.(false);
        trySync(() => pi.session.clearQueue(), () => undefined);
        await tryAsync(pi.session.abort(), () => undefined);
        return err(runningEventError);
      }
    }

    publishPiEvents = true;
    piPublicationReady.resolve();
    preflightResult?.(true);
    const [, promptError] = await promptRun;
    if (promptError !== undefined) return err(promptError);
    const [, eventError] = await tryAsync(
      normalizer.flush(),
      (cause) => new SessionProvisioningError("Could not publish Pi session events.", cause),
    );
    if (eventError !== undefined) return err(eventError);
    if (finalPiError !== undefined) {
      return err(new SessionProvisioningError("The Pi run failed.", finalPiError));
    }
    return ok(undefined);
  }

  async #restoreReady(
    metadata: RunnerSessionMetadata,
    correlationId: string,
  ): Promise<Result<void, SessionProvisioningError>> {
    const [ready, readyError] = mapStoreResult(
      metadata.id,
      await this.#sessionStore.updateProvisioning(metadata.id, {
        state: "ready",
        checkoutState: metadata.checkoutState,
        ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
      }),
    );
    if (readyError !== undefined) return err(readyError);
    return await this.#emitState(ready, "ready", correlationId);
  }

  async #runCommand(
    runtime: ProvisioningRuntime,
    command: string[],
    sessionId: string,
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    captureStdout = false,
  ): Promise<Result<CommandOutput, SessionProvisioningError>> {
    let stdout = "";
    let outputError: SessionProvisioningError | undefined;
    const [result, commandError] = await runtime.run(command, {
      onOutput: async (output) => {
        if (outputError !== undefined) return;
        if (captureStdout && output.stream === "stdout") {
          stdout = appendBounded(stdout, output.text, MAX_CAPTURED_COMMAND_BYTES);
        }
        const [, error] = await this.#emitBoundedOutput(
          sessionId,
          correlationId,
          output.stream,
          output.text,
          logBudget,
        );
        if (error !== undefined) {
          outputError = error;
          return;
        }
      },
    });
    if (commandError !== undefined) {
      return err(
        new SessionProvisioningError(
          `Guest command failed while provisioning session ${sessionId}.`,
          commandError,
        ),
      );
    }
    if (outputError !== undefined) return err(outputError);
    return ok({ exitCode: result.exitCode, stdout });
  }

  async #emitBoundedOutput(
    sessionId: string,
    correlationId: string,
    stream: "stdout" | "stderr",
    rawText: string,
    budget: ProvisioningLogBudget,
  ): Promise<Result<void, SessionProvisioningError>> {
    let text = sanitizeOutput(rawText);
    for (const secret of budget.secrets) text = text.replaceAll(secret, "[REDACTED]");
    while (text.length > 0 && budget.remainingBytes > 0) {
      const limit = Math.min(budget.remainingBytes, MAX_SESSION_EVENT_TEXT_BYTES);
      const { head, tail, bytes } = takeUtf8(text, limit);
      if (head.length === 0) break;
      const [, logError] = await this.#emitLog(sessionId, correlationId, stream, head);
      if (logError !== undefined) return err(logError);
      budget.remainingBytes -= bytes;
      text = tail;
    }
    if (text.length > 0 && !budget.truncated) {
      budget.truncated = true;
      const [, logError] = await this.#emitLog(
        sessionId,
        correlationId,
        "stderr",
        OUTPUT_TRUNCATED_MESSAGE,
      );
      if (logError !== undefined) return err(logError);
    }
    return ok(undefined);
  }

  async #emitState(
    metadata: RunnerSessionMetadata,
    stage: SessionProvisioningStage,
    correlationId: string,
  ): Promise<Result<void, SessionProvisioningError>> {
    return mapRelayResult(
      metadata.id,
      await this.#eventRelay.publishLive(
        metadata.id,
        correlationId,
        { type: "session.state", stage, checkoutState: metadata.checkoutState },
      ),
    );
  }

  async #emitLog(
    sessionId: string,
    correlationId: string,
    stream: "stdout" | "stderr",
    text: string,
  ): Promise<Result<void, SessionProvisioningError>> {
    return mapRelayResult(
      sessionId,
      await this.#eventRelay.publishLive(
        sessionId,
        correlationId,
        { type: "provisioning.log", stream, text },
      ),
    );
  }

  #supportsOrbSize(orbSize: OrbSize): boolean {
    const resources = orbSizeResources(orbSize);
    return resources.cpuCount <= this.#cpuCount && resources.memoryMiB <= this.#memoryMiB;
  }
}

export class SessionProvisioningError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "SessionProvisioningError";
  }
}

class RetryRejected extends SessionProvisioningError {
  constructor(message: string) {
    super(message, undefined);
    this.name = "RetryRejected";
  }
}

function sendProvisioningMessage(
  send: SendRunnerMessage,
  message: RunnerClientMessage,
): Result<void, SessionProvisioningError> {
  return trySync(
    () => send(message),
    (cause) => new SessionProvisioningError("Could not send a provisioning response.", cause),
  );
}

function sendPromptMessage(
  send: SendRunnerMessage,
  message: RunnerClientMessage,
): Result<void, SessionProvisioningError> {
  return trySync(
    () => send(message),
    (cause) => new SessionProvisioningError("Could not send a prompt response.", cause),
  );
}

function sendAbortMessage(
  send: SendRunnerMessage,
  message: RunnerClientMessage,
): Result<void, SessionProvisioningError> {
  return trySync(
    () => send(message),
    (cause) => new SessionProvisioningError("Could not send an abort response.", cause),
  );
}

function settlePromptAcceptance(
  send: SendRunnerMessage,
  message: RunnerClientMessage,
  settle: (result: Result<void, SessionProvisioningError>) => void,
): void {
  const [, sendError] = sendPromptMessage(send, message);
  if (sendError !== undefined) {
    settle(err(sendError));
    return;
  }
  settle(ok(undefined));
}

function mapStoreResult<T>(
  sessionId: string,
  result: Result<T, RunnerSessionStoreError>,
): Result<T, SessionProvisioningError> {
  const [value, storeError] = result;
  if (storeError !== undefined) return err(provisioningStoreError(sessionId, storeError));
  return ok(value);
}

function provisioningStoreError(
  sessionId: string,
  cause: RunnerSessionStoreError,
): SessionProvisioningError {
  return new SessionProvisioningError(
    `Durable session state failed for runner session ${sessionId}.`,
    cause,
  );
}

function mapRelayResult<T>(
  sessionId: string,
  result: Result<T, SessionEventRelayError>,
): Result<T, SessionProvisioningError> {
  const [value, relayError] = result;
  if (relayError !== undefined) {
    return err(
      new SessionProvisioningError(
        `Session event publication failed for runner session ${sessionId}.`,
        relayError,
      ),
    );
  }
  return ok(value);
}

function rejectedMessage(
  command: SessionProvisionCommand,
  message: string,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload: { message },
  };
}

function rejectedPromptMessage(
  command: SessionPromptCommand,
  message: string,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_PROMPT_REJECTED_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload: { message },
  };
}

function acceptedPromptMessage(command: SessionPromptCommand): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_PROMPT_ACCEPTED_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload: {},
  };
}

function acceptedAbortMessage(command: SessionAbortCommand): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_ABORT_ACCEPTED_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload: {},
  };
}

function rejectedAbortMessage(
  command: SessionAbortCommand,
  message: string,
): RunnerClientMessage {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: SESSION_ABORT_REJECTED_MESSAGE_TYPE,
    sessionId: command.sessionId,
    correlationId: command.id,
    payload: { message },
  };
}

function commandRejectionMessage(command: SessionProvisionCommand, error: unknown): string {
  if (error instanceof RetryRejected) return error.message;
  if (command.payload.mode === "retry") return "The runner could not prepare this session retry.";
  if (hasAlreadyExistsCause(error)) {
    return "This session already exists on the runner.";
  }
  return "The runner could not durably create the session.";
}

function hasAlreadyExistsCause(error: unknown): boolean {
  if (error instanceof Deno.errors.AlreadyExists) return true;
  return error instanceof Error && hasAlreadyExistsCause(error.cause);
}

function unsupportedOrbSizeMessage(orbSize: OrbSize): string {
  const resources = orbSizeResources(orbSize);
  return `The runner cannot provision the ${orbSize} orb size (${resources.cpuCount} CPU${
    resources.cpuCount === 1 ? "" : "s"
  } and ${resources.memoryMiB / 1024} GB memory).`;
}

async function clearWorkspace(workspacePath: string): Promise<void> {
  for await (const entry of Deno.readDir(workspacePath)) {
    await Deno.remove(join(workspacePath, entry.name), { recursive: entry.isDirectory });
  }
}

function sanitizeOutput(value: string): string {
  let sanitized = "";
  for (const codePoint of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) sanitized += codePoint;
  }
  return sanitized;
}

function redactedErrorMessage(error: unknown, secrets: string[]): string {
  let redacted = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return sanitizeOutput(redacted).slice(0, 1000) || "unknown runner error";
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const remaining = maxBytes - byteLength(current);
  return remaining <= 0 ? current : current + takeUtf8(next, remaining).head;
}

function takeUtf8(
  value: string,
  maxBytes: number,
): Utf8Slice {
  let bytes = 0;
  let codeUnits = 0;
  for (const codePoint of value) {
    const nextBytes = byteLength(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    codeUnits += codePoint.length;
  }
  return { head: value.slice(0, codeUnits), tail: value.slice(codeUnits), bytes };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
