import { number, object, optional, parse, string } from "@remix-run/data-schema";

const manifestAssetFilesSchema = object(
  {
    kernel: string(),
    initramfs: string(),
    rootfs: string(),
    krunKernel: optional(string()),
    krunInitrd: optional(string()),
  },
  { unknownKeys: "error" },
);

const developerImageManifestSchema = object(
  {
    version: number(),
    buildId: optional(string()),
    config: object({ arch: string() }, { unknownKeys: "passthrough" }),
    runtimeDefaults: optional(
      object({ rootfsMode: optional(string()) }, { unknownKeys: "passthrough" }),
    ),
    buildTime: string(),
    assets: manifestAssetFilesSchema,
    checksums: manifestAssetFilesSchema,
  },
  { unknownKeys: "passthrough" },
);

export function parseDeveloperImageManifest(input: unknown) {
  return parse(developerImageManifestSchema, input);
}

export type DeveloperImageManifest = ReturnType<typeof parseDeveloperImageManifest>;
