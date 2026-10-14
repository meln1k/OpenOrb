import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { RunnerId } from "@openorb/protocol/runner-api";
import { Layer } from "effect";
import type { GuestImage } from "../environment/gondolin/guest-image/installer.ts";
import { gondolinAgentEnvironmentProviderLayer } from "../environment/gondolin/layer.ts";
import { environmentStoreLayer } from "../environment/session/store.ts";
import { environmentSupervisorLayer } from "../environment/session/supervisor.ts";

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
  const platformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  return environmentSupervisorLayer({
    runnerId: options.runnerId,
    cpuCount: options.vmCpuCount,
    memoryMiB: options.vmMemoryMiB,
    gatewayUrl: options.gatewayUrl,
    runnerToken: options.runnerToken,
  }).pipe(
    Layer.provide(environmentStoreLayer(options.workingDirectory)),
    Layer.provide(platformLive),
    Layer.provide(
      gondolinAgentEnvironmentProviderLayer(options.guestImage, options.softwareEmulation),
    ),
  );
}
