import { Effect } from "effect";

import { AgentEnvironmentError } from "../agent-environment.ts";

const MAX_TIMER_MS = 2_147_483_647;
// One second for guest SIGKILL escalation, then one second for output draining.
const HOST_GRACE_SECONDS = 2;
const MAX_TIMEOUT_SECONDS = MAX_TIMER_MS / 1000 - HOST_GRACE_SECONDS;

export function shellWaitTimeoutMs(
  timeoutSeconds: number | undefined,
): Effect.Effect<number | undefined, AgentEnvironmentError> {
  if (timeoutSeconds === undefined) return Effect.succeed(undefined);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return Effect.fail(
      new AgentEnvironmentError(
        "Invalid timeout: must be a finite, positive number of seconds.",
        undefined,
      ),
    );
  }
  const waitMs = (timeoutSeconds + HOST_GRACE_SECONDS) * 1000;
  if (waitMs > MAX_TIMER_MS) {
    return Effect.fail(
      new AgentEnvironmentError(
        `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds (including a two-second host grace period).`,
        undefined,
      ),
    );
  }
  return Effect.succeed(waitMs);
}
