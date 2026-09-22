import type { SessionThinkingLevel } from "@openorb/protocol/browser-session-events";
import { tryAsync } from "../../../../result/src/index.ts";
import { literal, object, parseSafe, union } from "remix/data-schema";

import { routes } from "@/app/routes.ts";
import { actionResponseError } from "@/app/ui/session/session-action-response.ts";
import { nextThinkingLevel } from "@/app/ui/session-thinking-level.ts";
import type { SessionState } from "@/app/ui/session/session-transcript-state.ts";

const responseSchema = object({
  level: union([
    literal("off" as const),
    literal("minimal" as const),
    literal("low" as const),
    literal("medium" as const),
    literal("high" as const),
    literal("xhigh" as const),
    literal("max" as const),
  ]),
});

interface ThinkingLevelControllerOptions {
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly supportedLevels: readonly SessionThinkingLevel[];
  readonly signal: AbortSignal;
  readonly confirmedLevel: () => SessionThinkingLevel;
  readonly setError: (error: string | undefined) => void;
  readonly update: () => Promise<void>;
}

export interface SessionThinkingLevelController {
  readonly cycle: (sessionState: SessionState) => Promise<void>;
  readonly displayedLevel: (sessionState: SessionState) => SessionThinkingLevel;
  readonly promptLevel: (sessionState: SessionState) => SessionThinkingLevel | undefined;
  readonly requestPending: () => boolean;
  readonly observeConfirmed: () => void;
  readonly syncSessionState: (sessionState: SessionState) => void;
}

export function createSessionThinkingLevelController(
  options: ThinkingLevelControllerOptions,
  initialSessionState: SessionState,
): SessionThinkingLevelController {
  let stoppedDraft: SessionThinkingLevel | undefined;
  let sessionState = initialSessionState;
  let nextRequest = 0;
  let request: { readonly id: number; readonly level: SessionThinkingLevel } | undefined;
  let pending = false;

  const syncSessionState = (next: SessionState) => {
    if (sessionState === "stopped" && next !== "stopped") stoppedDraft = undefined;
    sessionState = next;
  };
  const displayedLevel = (state: SessionState) =>
    state === "stopped"
      ? stoppedDraft ?? options.confirmedLevel()
      : request?.level ?? options.confirmedLevel();
  const promptLevel = (state: SessionState) => state === "stopped" ? stoppedDraft : undefined;
  const observeConfirmed = () => {
    request = undefined;
    pending = false;
  };

  async function cycle(state: SessionState): Promise<void> {
    if (
      pending || (state !== "ready" && state !== "running" && state !== "stopped")
    ) return;
    const level = nextThinkingLevel(displayedLevel(state), options.supportedLevels);
    options.setError(undefined);
    if (state === "stopped") {
      stoppedDraft = level;
      await options.update();
      return;
    }

    const id = nextRequest++;
    request = { id, level };
    pending = true;
    await options.update();
    if (options.signal.aborted || request?.id !== id) return;

    const body = new FormData();
    body.set("_csrf", options.csrfToken);
    body.set("thinkingLevel", level);
    const [response, requestError] = await tryAsync(
      fetch(routes.app.sessions.thinkingLevel.href({ sessionId: options.sessionId }), {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: options.signal,
      }),
      () => true,
    );
    if (requestError !== undefined) {
      if (options.signal.aborted || request?.id !== id) return;
      request = undefined;
      pending = false;
      options.setError(
        "Thinking-level acknowledgement was lost. Check the current level before trying again.",
      );
      await options.update();
      return;
    }
    if (options.signal.aborted || request?.id !== id) return;

    if (!response.ok) {
      const error = await actionResponseError(response, "Thinking level was not changed");
      if (options.signal.aborted || request?.id !== id) return;
      request = undefined;
      pending = false;
      options.setError(error);
      await options.update();
      return;
    }

    const [encoded, decodeError] = await tryAsync(response.json(), () => true);
    if (decodeError !== undefined) {
      if (options.signal.aborted || request?.id !== id) return;
      request = undefined;
      pending = false;
      options.setError("The thinking-level acknowledgement was invalid.");
      await options.update();
      return;
    }
    if (options.signal.aborted || request?.id !== id) return;
    const result = parseSafe(responseSchema, encoded);
    pending = false;
    if (result?.success && result.value.level === level) {
      if (options.confirmedLevel() === level) request = undefined;
    } else {
      request = undefined;
      options.setError("The thinking-level acknowledgement was invalid.");
    }
    await options.update();
  }

  return {
    cycle,
    displayedLevel,
    promptLevel,
    requestPending: () => pending,
    observeConfirmed,
    syncSessionState,
  };
}
