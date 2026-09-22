import type { SessionThinkingLevel } from "@openorb/protocol";
import type { WorkspaceId } from "@openorb/protocol/runner-api";

import type { AppServices } from "@/app/middleware/services.ts";
import { MODEL_OPTIONS } from "@/app/model-provider-catalog.ts";
import { Effect } from "effect";

export type SessionComposerData = {
  projects: {
    id: string;
    name: string;
    defaultRef: string;
  }[];
  models: {
    id: string;
    name: string;
    providerId: string;
    providerName: string;
    thinkingLevels: SessionThinkingLevel[];
  }[];
  hasConfiguredRunner: boolean;
  hasConnectedRunner: boolean;
};

export async function loadSessionComposerData(
  workspaceId: WorkspaceId,
  services: AppServices,
): Promise<SessionComposerData> {
  const [projects, providers, runners] = await Promise.all([
    services.store.listProjects(workspaceId),
    services.store.listModelProviderCredentials(workspaceId),
    services.store.listRunners(workspaceId),
  ]);
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      defaultRef: project.defaultRef,
    })),
    models: MODEL_OPTIONS.filter((model) =>
      providers.some((provider) => provider.providerId === model.providerId)
    ).map((model) => ({
      id: model.id,
      name: model.name,
      providerId: model.providerId,
      providerName: model.providerName,
      thinkingLevels: [...model.thinkingLevels],
    })),
    hasConfiguredRunner: runners.some((runner) => runner.revokedAt === null),
    hasConnectedRunner: (await Promise.all(runners.map(async (runner) => {
      const live = await Effect.runPromise(
        services.runnerConnections.getRunnerLiveState(workspaceId, runner.id),
      );
      return live !== null && runner.revokedAt === null;
    }))).some(Boolean),
  };
}
