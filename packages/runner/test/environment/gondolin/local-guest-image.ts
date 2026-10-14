import * as fs from "node:fs/promises";
import { closeSync, openSync, type Stats } from "node:fs";
import { hasErrorCode } from "../../../src/runtime/errors.ts";
import {
  currentGuestImageArchitecture,
  ensureGuestImage,
  type GuestImage,
} from "../../../src/environment/gondolin/guest-image/installer.ts";
import {
  GUEST_IMAGE_RELEASE,
  type GuestImageRelease,
} from "../../../src/environment/gondolin/guest-image/release.ts";
import type { GondolinAgentEnvironmentConfig } from "../../../src/environment/gondolin/layer.ts";

interface LocalGuestImageMetadata {
  releaseId: string;
  gondolinBuildId: string;
  manifestSha256: string;
  sizeBytes: number;
  sha256: string;
}

let softwareEmulation: boolean | undefined;

export function gondolinTestEnvironmentOptions(): Pick<
  GondolinAgentEnvironmentConfig,
  "softwareEmulation"
> {
  if (softwareEmulation === undefined) {
    softwareEmulation = process.platform === "linux" && !canAccessKvm();
  }
  return softwareEmulation ? { softwareEmulation: true } : {};
}

function canAccessKvm(): boolean {
  try {
    const device = openSync("/dev/kvm", "r+");
    closeSync(device);
    return true;
  } catch {
    return false;
  }
}

export async function installLocalGuestImage(workingDirectory: string): Promise<GuestImage> {
  const architecture = currentGuestImageArchitecture();
  const releaseAsset = GUEST_IMAGE_RELEASE.assets[architecture];
  const sourceReleaseId = (
    await fs.readFile(`${process.cwd()}/images/guest/openorb-image-release`, "utf8")
  ).trim();
  const archivePath = `${process.cwd()}/dist/guest-image/gondolin-image-openorb-guest-${sourceReleaseId}-${releaseAsset.gondolinArchitecture}.tar.gz`;

  let metadata: LocalGuestImageMetadata;
  let archiveInfo: Stats;
  try {
    metadata = JSON.parse(await fs.readFile(`${archivePath}.json`, "utf8"));
    archiveInfo = await fs.lstat(archivePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `The local guest image is missing; run "npm run build:image -- ${releaseAsset.gondolinArchitecture}" first.`,
      );
    }
    throw error;
  }
  if (metadata.releaseId !== sourceReleaseId) {
    throw new Error(
      `The local guest image release is ${metadata.releaseId}; expected ${sourceReleaseId}.`,
    );
  }

  const release: GuestImageRelease = {
    id: metadata.releaseId,
    assets: {
      ...GUEST_IMAGE_RELEASE.assets,
      [architecture]: {
        ...releaseAsset,
        gondolinBuildId: metadata.gondolinBuildId,
        manifestSha256: metadata.manifestSha256,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
      },
    },
  };
  const [image, imageError] = await ensureGuestImage({
    workingDirectory,
    architecture,
    release,
    async fetch() {
      const archive = await fs.open(archivePath, "r");
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          try {
            const buffer = new Uint8Array(1024 * 1024);
            const { bytesRead } = await archive.read(buffer);
            if (bytesRead === 0) {
              await archive.close();
              controller.close();
            } else controller.enqueue(buffer.subarray(0, bytesRead));
          } catch (error) {
            await archive.close();
            controller.error(error);
          }
        },
        cancel: () => archive.close(),
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-length": String(archiveInfo.size) },
      });
    },
  });
  if (imageError !== undefined) throw imageError;
  return image;
}
