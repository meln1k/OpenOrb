import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import type { RunnerId } from "@openorb/protocol/runner-api";
import { Layer } from "effect";
import type { GuestImage } from "../environment/gondolin/guest-image/installer.ts";
import { gondolinAgentEnvironmentProviderLayer } from "../environment/gondolin/layer.ts";
import { environmentStoreLayer } from "../environment/session/store.ts";
import { environmentSupervisorLayer } from "../environment/session/supervisor.ts";
import { durableAgentHarnessLayer } from "../harness/durable/layer.ts";
import { sessionActorFactoryLayer } from "../session/actor/index.ts";
import { sessionArtifactStoreLayer } from "../session/artifact-store.ts";
import { sessionEventsLayer } from "../session/events.ts";
import { sessionJournalLayer } from "../session/persistent-actor/session-journal.ts";
import { runnerSessionStoreLayer } from "../session/store.ts";
import { sessionSupervisorLayer } from "../session/supervisor.ts";

export interface RunnerServicesOptions {
  readonly workingDirectory: string;
  readonly runnerId: RunnerId;
  readonly gatewayUrl: string;
  readonly runnerToken: string;
  readonly guestImage: GuestImage;
  readonly softwareEmulation: boolean;
  readonly vmCpuCount: number;
  readonly vmMemoryMiB: number;
}

/** Every service the runner RPC handlers need, over one Gondolin provider. */
export function runnerServicesLayer(options: RunnerServicesOptions) {
  const platformLive = Layer.merge(DenoFileSystem.layer, DenoPath.layer);
  const sessionJournalLive = sessionJournalLayer(options.workingDirectory).pipe(
    Layer.provideMerge(platformLive),
  );
  const sessionStoreLive = runnerSessionStoreLayer({
    workingDirectory: options.workingDirectory,
    runnerId: options.runnerId,
  }).pipe(Layer.provideMerge(sessionJournalLive));
  const sessionArtifactsLive = sessionArtifactStoreLayer({
    workingDirectory: options.workingDirectory,
  });
  const sessionEventsLive = sessionEventsLayer.pipe(
    Layer.provideMerge(Layer.merge(sessionStoreLive, sessionArtifactsLive)),
  );
  const environmentLive = gondolinAgentEnvironmentProviderLayer(
    options.guestImage,
    options.softwareEmulation,
  );
  const harnessLive = durableAgentHarnessLayer().pipe(
    Layer.provideMerge(Layer.merge(sessionEventsLive, sessionArtifactsLive)),
  );
  const sessionActorLive = sessionActorFactoryLayer().pipe(
    Layer.provideMerge(Layer.merge(harnessLive, environmentLive)),
  );
  const environmentSupervisorLive = environmentSupervisorLayer({
    runnerId: options.runnerId,
    cpuCount: options.vmCpuCount,
    memoryMiB: options.vmMemoryMiB,
    gatewayUrl: options.gatewayUrl,
    runnerToken: options.runnerToken,
  }).pipe(
    Layer.provide(environmentStoreLayer(options.workingDirectory)),
    Layer.provide(platformLive),
    Layer.provide(environmentLive),
  );
  return sessionSupervisorLayer({
    runnerId: options.runnerId,
    cpuCount: options.vmCpuCount,
    memoryMiB: options.vmMemoryMiB,
  }).pipe(
    Layer.provideMerge(sessionActorLive),
    Layer.provideMerge(environmentSupervisorLive),
  );
}
