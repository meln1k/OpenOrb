import {
  MAX_PROVISIONING_EVENT_TEXT_BYTES,
  type RunnerClientMessage,
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionModelRuntime,
  type SessionProvisionCommand,
  type SessionProvisioningStage,
} from "@openorb/protocol";
import { join } from "node:path";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import type { DeveloperImage } from "@/src/developer-image.ts";
import { PiEventNormalizer } from "@/src/pi-event-normalizer.ts";
import { OpenOrbPiSessionFactory, type OpenOrbPiSessionOptions } from "@/src/pi-session-factory.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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

const MAX_PROVISIONING_LOG_BYTES = 256 * 1024;
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
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(input: string): Promise<void>;
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

export class SessionProvisioner {
  readonly #sessionStore: RunnerSessionStore;
  readonly #eventRelay: SessionEventRelay;
  readonly #cpuCount: number;
  readonly #memoryMiB: number;
  readonly #createRuntime: NonNullable<SessionProvisionerOptions["createRuntime"]>;
  readonly #createPiSession: CreatePiSession;
  readonly #jobs = new Map<string, Promise<Result<void, SessionProvisioningError>>>();
  readonly #runtimes = new Map<string, ProvisioningRuntime>();
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

    const [metadata, preparationError] = command.payload.mode === "create"
      ? await this.#sessionStore.createSession({
        id: command.sessionId,
        projectId: command.payload.projectId,
        repositoryUrl: command.payload.repositoryUrl,
        ref: command.payload.ref,
        branchName: command.payload.branchName,
        initialPrompt: command.payload.initialPrompt,
        model: command.payload.modelRuntime.model,
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

  async close(): Promise<Result<void, SessionProvisioningError>> {
    if (this.#closed) return ok(undefined);
    this.#closed = true;
    await Promise.all(this.#jobs.values());
    const closeErrors = await Promise.all(
      [...this.#runtimes.values()].map(async (runtime) => {
        const [, closeError] = await runtime.close();
        if (closeError !== undefined) return closeError;
        return undefined;
      }),
    );
    this.#runtimes.clear();
    this.#activeSessionIds.clear();
    const closeError = closeErrors.find((error) => error !== undefined);
    return closeError === undefined
      ? ok(undefined)
      : err(new SessionProvisioningError("Could not close a provisioning runtime.", closeError));
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
      const [runtime, runtimeError] = await this.#createRuntime({
        workspacePath,
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.repositoryUrl,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: this.#cpuCount,
        memoryMiB: this.#memoryMiB,
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

      const [running, runningError] = mapStoreResult(
        sessionId,
        await this.#sessionStore.updateProvisioning(sessionId, {
          state: "running",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }),
      );
      if (runningError !== undefined) return err(runningError);
      metadata = running;
      const [, runningEventError] = await this.#emitState(metadata, "running", correlationId);
      if (runningEventError !== undefined) return err(runningEventError);

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

    const normalizer = new PiEventNormalizer({
      secrets: [modelRuntime.credential.value],
      publishConversation: async (event) => {
        const [, relayError] = mapRelayResult(
          metadata.id,
          await this.#eventRelay.publish(metadata.id, correlationId, event),
        );
        if (relayError !== undefined) throw relayError;
      },
      publishLive: async (event) => {
        const [, relayError] = mapRelayResult(
          metadata.id,
          await this.#eventRelay.publishLive(metadata.id, correlationId, event),
        );
        if (relayError !== undefined) throw relayError;
      },
    });
    using cleanup = new DisposableStack();
    cleanup.defer(() => pi.session.dispose());
    let finalPiError: Error | undefined;
    const unsubscribe = pi.session.subscribe((event) => {
      normalizer.handle(event);
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      finalPiError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
        ? new Error(event.message.errorMessage ?? `Pi stopped with ${event.message.stopReason}.`)
        : undefined;
    });
    cleanup.defer(unsubscribe);
    const [, promptError] = await tryAsync(
      pi.session.prompt(metadata.initialPrompt),
      (cause) => new SessionProvisioningError("The initial Pi run failed.", cause),
    );
    if (promptError !== undefined) return err(promptError);
    const [, eventError] = await tryAsync(
      normalizer.flush(),
      (cause) => new SessionProvisioningError("Could not publish Pi session events.", cause),
    );
    if (eventError !== undefined) return err(eventError);
    if (finalPiError !== undefined) {
      return err(new SessionProvisioningError("The initial Pi run failed.", finalPiError));
    }
    return ok(undefined);
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
      const limit = Math.min(budget.remainingBytes, MAX_PROVISIONING_EVENT_TEXT_BYTES);
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
