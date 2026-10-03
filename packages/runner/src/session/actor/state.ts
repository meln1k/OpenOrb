import type {
  AgentState,
  EnvironmentState,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  RunnerSessionState,
  SessionGitHead,
  SessionId,
  SessionIssue,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";
import { type EventCodec, Journal } from "../persistent-actor/journal.ts";
import type { RunnerSessionDefinition } from "../definition.ts";
import { SessionEvent } from "./events.ts";
import { appendSessionIssues, clearFailureIssues } from "./issues.ts";

export interface RunnerSessionMetadata {
  readonly id: SessionId;
  readonly definition: RunnerSessionDefinition;
  readonly runnerId: RunnerId;
  readonly createdAt: typeof RunnerSessionCreatedAt.Type;
  readonly checkoutState: RunnerCheckoutState;
  readonly issues: readonly SessionIssue[];
  readonly baseCommit?: typeof SessionGitHead.Type;
  readonly lastAcceptedUserMessageAt?: typeof RunnerSessionCreatedAt.Type;
  readonly state: RunnerSessionState;
  readonly agentState: AgentState;
  readonly environmentState: EnvironmentState;
}

export interface SessionState {
  readonly metadata: RunnerSessionMetadata;
  readonly diskInitialized: boolean;
}

export function publicSessionState(
  agent: AgentState,
  environment: EnvironmentState,
): RunnerSessionState {
  if (agent === "error" || environment === "error") return "error";
  if (agent === "running") return "running";
  if (environment === "starting") return "provisioning";
  return environment === "stopped" ? "stopped" : "ready";
}

export function applySessionEvent(
  current: SessionState | undefined,
  event: SessionEvent,
): SessionState | undefined {
  if (event.type === "session.provisioning-started") {
    return current ?? {
      diskInitialized: false,
      metadata: {
        id: event.id,
        definition: event.definition,
        runnerId: event.runnerId,
        createdAt: event.createdAt,
        checkoutState: "pending",
        issues: [],
        agentState: "paused",
        environmentState: "starting",
        state: "provisioning",
      },
    };
  }
  if (!current) return current;
  const metadata = current.metadata;
  switch (event.type) {
    case "disk.initialized":
      return { ...current, diskInitialized: true };
    case "environment.changed":
    case "stop.completed": {
      const environmentState = event.type === "stop.completed" ? "stopped" : event.state;
      return {
        ...current,
        metadata: {
          ...metadata,
          environmentState,
          issues: environmentState === "running"
            ? clearFailureIssues(metadata.issues)
            : metadata.issues,
          state: publicSessionState(metadata.agentState, environmentState),
        },
      };
    }
    case "checkout.updated":
      return {
        ...current,
        metadata: {
          ...metadata,
          checkoutState: event.checkoutState,
          ...(event.baseCommit === undefined ? {} : { baseCommit: event.baseCommit }),
        },
      };
    case "issue.recorded":
      return {
        ...current,
        metadata: { ...metadata, issues: appendSessionIssues(metadata.issues, [event.issue]) },
      };
    case "message.accepted":
      return {
        ...current,
        metadata: { ...metadata, lastAcceptedUserMessageAt: event.acceptedAt },
      };
  }
}

export const sessionEventCodec: EventCodec<SessionEvent> = {
  decode: (value) => Schema.decodeUnknownEffect(SessionEvent)(value, { onExcessProperty: "error" }),
  encode: (value) => Schema.encodeEffect(SessionEvent)(value, { onExcessProperty: "error" }),
};

export const replaySessionState = Effect.fnUntraced(function* (sessionId: string) {
  const journal = yield* Journal;
  const entries = yield* journal.replay(sessionId, sessionEventCodec).pipe(
    Effect.catchTag("JournalNotFound", () => Effect.succeed([])),
  );
  let state: SessionState | undefined;
  for (const entry of entries) {
    state = applySessionEvent(state, entry.event);
  }
  return { state, sequence: entries.at(-1)?.sequence ?? 0 };
});
