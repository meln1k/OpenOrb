import {
  currentGuestImageArchitecture,
  ensureGuestImage,
  type GuestImage,
} from "@/src/environment/gondolin/guest-image/installer.ts";
import {
  GUEST_IMAGE_RELEASE,
  type GuestImageRelease,
} from "@/src/environment/gondolin/guest-image/release.ts";

interface LocalGuestImageMetadata {
  releaseId: string;
  gondolinBuildId: string;
  manifestSha256: string;
  sizeBytes: number;
  sha256: string;
}

export async function installLocalGuestImage(
  workingDirectory: string,
): Promise<GuestImage> {
  const architecture = currentGuestImageArchitecture();
  const releaseAsset = GUEST_IMAGE_RELEASE.assets[architecture];
  const sourceReleaseId = (
    await Deno.readTextFile(`${Deno.cwd()}/images/guest/openorb-image-release`)
  ).trim();
  const archivePath =
    `${Deno.cwd()}/dist/guest-image/gondolin-image-openorb-guest-${sourceReleaseId}-${releaseAsset.gondolinArchitecture}.tar.gz`;

  let metadata: LocalGuestImageMetadata;
  let archiveInfo: Deno.FileInfo;
  try {
    metadata = JSON.parse(await Deno.readTextFile(`${archivePath}.json`));
    archiveInfo = await Deno.lstat(archivePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `The local guest image is missing; run "deno task build:image ${releaseAsset.gondolinArchitecture}" first.`,
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
      const archive = await Deno.open(archivePath, { read: true });
      return new Response(archive.readable, {
        status: 200,
        headers: { "content-length": String(archiveInfo.size) },
      });
    },
  });
  if (imageError !== undefined) throw imageError;
  return image;
}
