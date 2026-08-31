import type { RunId } from "@openorb/protocol/runner-api";
import { Effect, MutableRef } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import type { ActiveAgentRun } from "../../harness/agent-harness.ts";
import type { OpenAgentSession } from "./agent-runtime.ts";

export interface SessionActorStatus {
  readonly active: boolean;
  readonly activeRunId?: string;
}

export interface SessionRuntimeHandles {
  readonly environment?: AgentEnvironment;
  readonly agentSession?: OpenAgentSession;
  readonly activeRun?: {
    readonly runId: RunId;
    readonly run: ActiveAgentRun;
  };
}

export interface SessionRuntime {
  readonly get: () => SessionRuntimeHandles;
  readonly setEnvironment: (environment: AgentEnvironment) => Effect.Effect<void>;
  readonly setAgentSession: (agentSession: OpenAgentSession) => Effect.Effect<void>;
  readonly setSession: (
    environment: AgentEnvironment,
    agentSession: OpenAgentSession,
  ) => Effect.Effect<void>;
  readonly activateRun: (runId: RunId, run: ActiveAgentRun) => Effect.Effect<void>;
  readonly clearActiveRun: Effect.Effect<void>;
  readonly clearEnvironment: Effect.Effect<void>;
  readonly clearAgentSession: Effect.Effect<void>;
  readonly updateStatus: (active: boolean, activeRunId?: string) => Effect.Effect<void>;
}

export function makeSessionRuntime(
  status: MutableRef.MutableRef<SessionActorStatus>,
): SessionRuntime {
  const handles = MutableRef.make<SessionRuntimeHandles>({});
  const update = (f: (current: SessionRuntimeHandles) => SessionRuntimeHandles) =>
    Effect.sync(() => MutableRef.update(handles, f));

  return {
    get: () => MutableRef.get(handles),
    setEnvironment: (environment) => Effect.sync(() => MutableRef.set(handles, { environment })),
    setAgentSession: (agentSession) => update((current) => ({ ...current, agentSession })),
    setSession: (environment, agentSession) =>
      Effect.sync(() => MutableRef.set(handles, { environment, agentSession })),
    activateRun: (runId, run) =>
      update((current) => ({
        ...current,
        activeRun: { runId, run },
      })),
    clearActiveRun: update(({ activeRun: _, ...rest }) => rest),
    clearEnvironment: Effect.sync(() => MutableRef.set(handles, {})),
    clearAgentSession: update(({ agentSession: _, activeRun: __, ...rest }) => rest),
    updateStatus: (active, activeRunId) =>
      Effect.sync(() =>
        MutableRef.set(status, {
          active,
          ...(activeRunId === undefined ? {} : { activeRunId }),
        })
      ),
  };
}
