import {
  MAX_PROVISIONING_EVENT_TEXT_BYTES,
  type RunnerClientMessage,
  SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE,
  SESSION_PROVISION_REJECTED_MESSAGE_TYPE,
  type SessionProvisionCommand,
  type SessionProvisioningStage,
} from "@openorb/protocol";
import { join } from "node:path";

import type { DeveloperImage } from "@/src/developer-image.ts";
import {
  createOpenOrbGondolinToolRuntime,
  type OpenOrbGondolinToolRuntime,
  type OpenOrbGondolinToolRuntimeOptions,
} from "@/src/gondolin-tools.ts";
import type { SendRunnerMessage, SessionEventRelay } from "@/src/session-event-relay.ts";
import type { RunnerSessionMetadata, RunnerSessionStore } from "@/src/session-store.ts";

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
  ) => Promise<ProvisioningRuntime>;
}

export interface ProvisioningRuntime {
  run: OpenOrbGondolinToolRuntime["run"];
  close(): Promise<void>;
}

interface ProvisioningLogBudget {
  remainingBytes: number;
  truncated: boolean;
  secret?: string;
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
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #runtimes = new Map<string, ProvisioningRuntime>();
  readonly #activeSessionIds = new Set<string>();
  #closed = false;

  constructor(options: SessionProvisionerOptions) {
    this.#sessionStore = options.sessionStore;
    this.#eventRelay = options.eventRelay;
    this.#cpuCount = options.cpuCount;
    this.#memoryMiB = options.memoryMiB;
    if (options.createRuntime) {
      this.#createRuntime = options.createRuntime;
    } else {
      if (!options.developerImage) {
        throw new Error("A verified developer image is required for Gondolin provisioning.");
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
  ): Promise<void> {
    if (this.#closed) {
      send(rejectedMessage(command, "The runner is shutting down."));
      return;
    }
    if (this.#jobs.has(command.sessionId)) {
      send(rejectedMessage(command, "This session is already provisioning."));
      return;
    }

    let metadata: RunnerSessionMetadata;
    try {
      if (command.payload.mode === "create") {
        metadata = await this.#sessionStore.createSession({
          id: command.sessionId,
          projectId: command.payload.projectId,
          repositoryUrl: command.payload.repositoryUrl,
          ref: command.payload.ref,
          branchName: command.payload.branchName,
          initialPrompt: command.payload.initialPrompt,
        });
      } else {
        metadata = await this.#prepareRetry(command.sessionId);
      }
    } catch (error) {
      send(rejectedMessage(command, commandRejectionMessage(command, error)));
      return;
    }

    const snapshot = await this.#sessionStore.getSessionSnapshot(metadata.id);
    send({
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

    const githubToken = command.payload.githubToken;
    const job = Promise.resolve()
      .then(() => this.#provision(metadata, githubToken, command.id))
      .finally(() => {
        if (this.#jobs.get(metadata.id) === job) this.#jobs.delete(metadata.id);
      });
    this.#jobs.set(metadata.id, job);
    void job;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.#jobs.values());
    await Promise.allSettled([...this.#runtimes.values()].map((runtime) => runtime.close()));
    this.#runtimes.clear();
    this.#activeSessionIds.clear();
  }

  async #prepareRetry(sessionId: string): Promise<RunnerSessionMetadata> {
    const metadata = await this.#sessionStore.readMetadata(sessionId);
    if (metadata.state !== "error") {
      throw new RetryRejected("Only a failed provisioning attempt can be retried.");
    }
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) {
      await runtime.close();
      this.#runtimes.delete(sessionId);
      this.#activeSessionIds.delete(sessionId);
    }
    return await this.#sessionStore.updateProvisioning(sessionId, {
      state: "created",
      checkoutState: metadata.checkoutState,
      ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
    });
  }

  async #provision(
    initialMetadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const sessionId = initialMetadata.id;
    const logBudget: ProvisioningLogBudget = {
      remainingBytes: MAX_PROVISIONING_LOG_BYTES,
      truncated: false,
      ...(githubToken === undefined ? {} : { secret: githubToken }),
    };
    let metadata = initialMetadata;

    this.#activeSessionIds.add(sessionId);
    try {
      metadata = await this.#sessionStore.updateProvisioning(sessionId, {
        state: "provisioning",
        checkoutState: metadata.checkoutState,
        ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
      });
      await this.#emitState(metadata, "starting-vm", correlationId);

      const runtime = await this.#createRuntime({
        workspacePath: await this.#sessionStore.getSessionWorkspacePath(sessionId),
        sessionLabel: `openorb session ${sessionId}`,
        github: {
          repositoryUrl: metadata.repositoryUrl,
          ...(githubToken === undefined ? {} : { token: githubToken }),
        },
        cpuCount: this.#cpuCount,
        memoryMiB: this.#memoryMiB,
      });
      this.#runtimes.set(sessionId, runtime);

      if (metadata.checkoutState === "pending") {
        await clearWorkspace(await this.#sessionStore.getSessionWorkspacePath(sessionId));
        await this.#emitState(metadata, "cloning", correlationId);
        const clone = await this.#runCommand(
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
        if (clone.exitCode !== 0) {
          metadata = await this.#sessionStore.updateProvisioning(sessionId, {
            state: "ready",
            checkoutState: "unavailable",
          });
          await this.#emitLog(
            sessionId,
            correlationId,
            "stderr",
            "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
          );
          await this.#emitState(metadata, "ready", correlationId);
          return;
        }

        const revision = await this.#runCommand(
          runtime,
          ["/usr/bin/git", "rev-parse", "HEAD"],
          sessionId,
          correlationId,
          logBudget,
          true,
        );
        if (revision.exitCode !== 0) {
          throw new Error("Git could not report the cloned base commit.");
        }
        const baseCommit = revision.stdout.trim();

        await this.#emitState(metadata, "creating-branch", correlationId);
        const branch = await this.#runCommand(
          runtime,
          ["/usr/bin/git", "switch", "-c", metadata.branchName],
          sessionId,
          correlationId,
          logBudget,
        );
        if (branch.exitCode !== 0) throw new Error("Git could not create the session branch.");
        metadata = await this.#sessionStore.updateProvisioning(sessionId, {
          state: "provisioning",
          checkoutState: "available",
          baseCommit,
        });
      }

      await this.#emitState(metadata, "setup", correlationId);
      const setup = await this.#runCommand(
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
      if (setup.exitCode !== 0) {
        metadata = await this.#sessionStore.updateProvisioning(sessionId, {
          state: "error",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        });
        await this.#emitLog(
          sessionId,
          correlationId,
          "stderr",
          `.agents/setup exited with status ${setup.exitCode}; the initial prompt was not dispatched.\n`,
        );
        await this.#emitState(metadata, "failed", correlationId);
        return;
      }

      metadata = await this.#sessionStore.updateProvisioning(sessionId, {
        state: "ready",
        checkoutState: metadata.checkoutState,
        ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
      });
      await this.#emitState(metadata, "ready", correlationId);
    } catch (error) {
      const current = await this.#sessionStore.readMetadata(sessionId).catch(() => metadata);
      const failed = await this.#sessionStore.updateProvisioning(sessionId, {
        state: "error",
        checkoutState: current.checkoutState,
        ...(current.baseCommit === undefined ? {} : { baseCommit: current.baseCommit }),
      }).catch(() => current);
      await this.#emitLog(
        sessionId,
        correlationId,
        "stderr",
        `Provisioning failed: ${redactedErrorMessage(error, githubToken)}\n`,
      ).catch(() => undefined);
      await this.#emitState(failed, "failed", correlationId).catch(() => undefined);
    } finally {
      if (!this.#runtimes.has(sessionId)) this.#activeSessionIds.delete(sessionId);
    }
  }

  async #runCommand(
    runtime: ProvisioningRuntime,
    command: string[],
    sessionId: string,
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    captureStdout = false,
  ): Promise<CommandOutput> {
    let stdout = "";
    const result = await runtime.run(command, {
      onOutput: async (output) => {
        if (captureStdout && output.stream === "stdout") {
          stdout = appendBounded(stdout, output.text, MAX_CAPTURED_COMMAND_BYTES);
        }
        await this.#emitBoundedOutput(
          sessionId,
          correlationId,
          output.stream,
          output.text,
          logBudget,
        );
      },
    });
    return { exitCode: result.exitCode, stdout };
  }

  async #emitBoundedOutput(
    sessionId: string,
    correlationId: string,
    stream: "stdout" | "stderr",
    rawText: string,
    budget: ProvisioningLogBudget,
  ): Promise<void> {
    let text = sanitizeOutput(rawText);
    if (budget.secret !== undefined) text = text.replaceAll(budget.secret, "[REDACTED]");
    while (text.length > 0 && budget.remainingBytes > 0) {
      const limit = Math.min(budget.remainingBytes, MAX_PROVISIONING_EVENT_TEXT_BYTES);
      const { head, tail, bytes } = takeUtf8(text, limit);
      if (head.length === 0) break;
      await this.#emitLog(sessionId, correlationId, stream, head);
      budget.remainingBytes -= bytes;
      text = tail;
    }
    if (text.length > 0 && !budget.truncated) {
      budget.truncated = true;
      await this.#emitLog(
        sessionId,
        correlationId,
        "stderr",
        OUTPUT_TRUNCATED_MESSAGE,
      );
    }
  }

  async #emitState(
    metadata: RunnerSessionMetadata,
    stage: SessionProvisioningStage,
    correlationId: string,
  ): Promise<void> {
    await this.#eventRelay.publish(
      metadata.id,
      correlationId,
      { type: "session.state", stage, checkoutState: metadata.checkoutState },
    );
  }

  async #emitLog(
    sessionId: string,
    correlationId: string,
    stream: "stdout" | "stderr",
    text: string,
  ): Promise<void> {
    await this.#eventRelay.publish(
      sessionId,
      correlationId,
      { type: "provisioning.log", stream, text },
    );
  }
}

class RetryRejected extends Error {}

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
  if (error instanceof Deno.errors.AlreadyExists) {
    return "This session already exists on the runner.";
  }
  return "The runner could not durably create the session.";
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

function redactedErrorMessage(error: unknown, secret: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret === undefined ? message : message.replaceAll(secret, "[REDACTED]");
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
