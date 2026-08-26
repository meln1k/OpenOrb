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

const guestImageManifestSchema = object(
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

export function parseGuestImageManifest(input: unknown) {
  return parse(guestImageManifestSchema, input);
}

export type GuestImageManifest = ReturnType<typeof parseGuestImageManifest>;
