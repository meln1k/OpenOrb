import type { WorkspaceId } from "@openorb/protocol/runner-api";

import type { Project } from "@/app/data/project-repository.ts";
import type { AppServices } from "@/app/middleware/services.ts";
import { MODEL_OPTIONS } from "@/app/model-provider-catalog.ts";
import { Effect } from "effect";

export interface SessionComposerData {
  projects: Project[];
  models: { id: string; name: string; providerId: string; providerName: string }[];
  hasConfiguredRunner: boolean;
  hasConnectedRunner: boolean;
}

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
    projects,
    models: MODEL_OPTIONS.filter((model) =>
      providers.some((provider) => provider.providerId === model.providerId)
    ),
    hasConfiguredRunner: runners.some((runner) => runner.revokedAt === null),
    hasConnectedRunner: (await Promise.all(runners.map(async (runner) => {
      const live = await Effect.runPromise(
        services.runnerConnections.getRunnerLiveState(workspaceId, runner.id),
      );
      return live !== null && runner.revokedAt === null;
    }))).some(Boolean),
  };
}
