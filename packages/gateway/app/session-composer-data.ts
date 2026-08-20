import type { Project } from "@/app/data/project-repository.ts";
import type { AppServices } from "@/app/middleware/services.ts";
import { MODEL_OPTIONS } from "@/app/model-provider-catalog.ts";

export interface SessionComposerRunner {
  id: string;
  name: string;
  vmCpuCount: number;
  vmMemoryMiB: number;
}

export interface SessionComposerData {
  projects: Project[];
  models: { id: string; name: string; providerId: string; providerName: string }[];
  runners: SessionComposerRunner[];
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
    runners: runners.flatMap((runner) => {
      const live = services.runnerConnections.getRunnerLiveState(userId, runner.id);
      return live && runner.revokedAt === null
        ? [{
          id: runner.id,
          name: runner.name,
          vmCpuCount: live.capacity.vmCpuCount,
          vmMemoryMiB: live.capacity.vmMemoryMiB,
        }]
        : [];
    }),
  };
}
