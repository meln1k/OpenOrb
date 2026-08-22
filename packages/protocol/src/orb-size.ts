import { literal, union } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";

export const ORB_SIZES = ["tiny", "small", "medium", "large", "xxlarge"] as const;
export const DEFAULT_ORB_SIZE = "medium" as const;

export const orbSizeSchema = union([
  literal("tiny" as const),
  literal("small" as const),
  literal("medium" as const),
  literal("large" as const),
  literal("xxlarge" as const),
]);

export type OrbSize = InferOutput<typeof orbSizeSchema>;

export interface OrbSizeResources {
  readonly cpuCount: number;
  readonly memoryMiB: number;
}

export const ORB_SIZE_RESOURCES = {
  tiny: { cpuCount: 1, memoryMiB: 2 * 1024 },
  small: { cpuCount: 2, memoryMiB: 4 * 1024 },
  medium: { cpuCount: 4, memoryMiB: 8 * 1024 },
  large: { cpuCount: 8, memoryMiB: 16 * 1024 },
  xxlarge: { cpuCount: 16, memoryMiB: 32 * 1024 },
} as const satisfies Readonly<Record<OrbSize, OrbSizeResources>>;

export function orbSizeResources(orbSize: OrbSize): OrbSizeResources {
  return ORB_SIZE_RESOURCES[orbSize];
}
