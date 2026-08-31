import type { SessionId, SessionProvisioningStage } from "@openorb/protocol/runner-api";
import { MAX_RPC_SESSION_EVENT_TEXT_BYTES } from "@openorb/protocol/runner-api";
import { Effect } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import { SessionActorError } from "./actor-error.ts";
import type { ProvisioningLogBudget } from "./commands.ts";
import { SessionEvents } from "../events.ts";
import type { RunnerSessionMetadata } from "../store.ts";

const MAX_CAPTURED_COMMAND_BYTES = 4 * 1024;
const MAX_PROVISIONING_LOG_BYTES = 256 * 1024;
const OUTPUT_TRUNCATED_MESSAGE = "\n[Provisioning output was truncated.]\n";

export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface SessionReporter {
  readonly publish: (
    correlationId: string,
    event: unknown,
  ) => Effect.Effect<void, SessionActorError>;
  readonly emitLog: (
    correlationId: string,
    stream: "stdout" | "stderr",
    text: string,
  ) => Effect.Effect<void, SessionActorError>;
  readonly emitState: (
    metadata: RunnerSessionMetadata,
    stage: SessionProvisioningStage,
    correlationId: string,
  ) => Effect.Effect<void, SessionActorError>;
  readonly runCommand: (
    environment: AgentEnvironment,
    command: string[],
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    captureStdout?: boolean,
  ) => Effect.Effect<CommandOutput, SessionActorError>;
}

export function makeProvisioningLogBudget(
  secrets: ReadonlyArray<string | undefined>,
): ProvisioningLogBudget {
  return {
    remainingBytes: MAX_PROVISIONING_LOG_BYTES,
    truncated: false,
    secrets: secrets.filter((value): value is string => value !== undefined),
  };
}

export function redactedErrorMessage(error: unknown, secrets: readonly string[]): string {
  let redacted = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return sanitizeOutput(redacted).slice(0, 1000) || "unknown runner error";
}

export const makeSessionReporter = Effect.fn("makeSessionReporter")(function* (
  sessionId: SessionId,
) {
  const events = yield* SessionEvents;

  const publish = (
    correlationId: string,
    event: unknown,
  ): Effect.Effect<void, SessionActorError> =>
    events.publishLive(sessionId, correlationId, event).pipe(
      Effect.mapError((cause) => new SessionActorError("Session event publication failed.", cause)),
    );

  const emitLog = (
    correlationId: string,
    stream: "stdout" | "stderr",
    text: string,
  ): Effect.Effect<void, SessionActorError> =>
    publish(correlationId, { type: "provisioning.log", stream, text });

  const emitState = (
    metadata: RunnerSessionMetadata,
    stage: SessionProvisioningStage,
    correlationId: string,
  ): Effect.Effect<void, SessionActorError> =>
    publish(correlationId, {
      type: "session.state",
      stage,
      checkoutState: metadata.checkoutState,
    });

  const emitBoundedOutput = (
    correlationId: string,
    stream: "stdout" | "stderr",
    rawText: string,
    budget: ProvisioningLogBudget,
  ): Effect.Effect<void, SessionActorError> =>
    Effect.gen(function* () {
      let text = sanitizeOutput(rawText);
      for (const secret of budget.secrets) text = text.replaceAll(secret, "[REDACTED]");
      while (text.length > 0 && budget.remainingBytes > 0) {
        const limit = Math.min(budget.remainingBytes, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
        const { head, tail, bytes } = takeUtf8(text, limit);
        if (head.length === 0) break;
        yield* emitLog(correlationId, stream, head);
        budget.remainingBytes -= bytes;
        text = tail;
      }
      if (text.length > 0 && !budget.truncated) {
        budget.truncated = true;
        yield* emitLog(correlationId, "stderr", OUTPUT_TRUNCATED_MESSAGE);
      }
    });

  const runCommand = (
    environment: AgentEnvironment,
    command: string[],
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    captureStdout = false,
  ): Effect.Effect<CommandOutput, SessionActorError> => {
    let stdout = "";
    return Effect.gen(function* () {
      const result = yield* environment.run(command, {
        onOutput: (output) =>
          Effect.gen(function* () {
            if (captureStdout && output.stream === "stdout") {
              stdout = appendBounded(stdout, output.text, MAX_CAPTURED_COMMAND_BYTES);
            }
            yield* emitBoundedOutput(
              correlationId,
              output.stream,
              output.text,
              logBudget,
            );
          }),
      }).pipe(
        Effect.mapError((cause) =>
          new SessionActorError("The session actor operation failed.", cause)
        ),
      );
      return { exitCode: result.exitCode, stdout };
    });
  };

  return { publish, emitLog, emitState, runCommand } satisfies SessionReporter;
});

function sanitizeOutput(value: string): string {
  let sanitized = "";
  for (const codePoint of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) sanitized += codePoint;
  }
  return sanitized;
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const remaining = maxBytes - byteLength(current);
  return remaining <= 0 ? current : current + takeUtf8(next, remaining).head;
}

function takeUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0 || value.length === 0) return { head: "", tail: value, bytes: 0 };
  const encoder = new TextEncoder();
  let end = 0;
  let bytes = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return { head: value.slice(0, end), tail: value.slice(end), bytes };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
