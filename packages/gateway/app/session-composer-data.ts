import type { Project } from "@/app/data/project-repository.ts";
import type { AppServices } from "@/app/middleware/services.ts";
import { MODEL_OPTIONS } from "@/app/model-provider-catalog.ts";
import { Effect } from "effect";

export interface SessionComposerData {
  projects: Project[];
  models: { id: string; name: string; providerId: string; providerName: string }[];
  hasConnectedRunner: boolean;
}

export async function loadSessionComposerData(
  userId: string,
  services: AppServices,
): Promise<SessionComposerData> {
  const [projects, providers, runners] = await Promise.all([
    services.store.listProjects(userId),
    services.store.listModelProviderCredentials(userId),
    services.store.listRunners(userId),
  ]);
  return {
    projects,
    models: MODEL_OPTIONS.filter((model) =>
      providers.some((provider) => provider.providerId === model.providerId)
    ),
    hasConnectedRunner: (await Promise.all(runners.map(async (runner) => {
      const live = await Effect.runPromise(
        services.runnerConnections.getRunnerLiveState(userId, runner.id),
      );
      return live !== null && runner.revokedAt === null;
    }))).some(Boolean),
  };
}
