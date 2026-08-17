import {
  currentDeveloperImageArchitecture,
  type DeveloperImage,
  ensureDeveloperImage,
} from "@/src/developer-image.ts";
import {
  DEVELOPER_IMAGE_RELEASE,
  type DeveloperImageRelease,
} from "@/src/developer-image-release.ts";

interface LocalDeveloperImageMetadata {
  releaseId: string;
  gondolinBuildId: string;
  manifestSha256: string;
  sizeBytes: number;
  sha256: string;
}

export async function installLocalDeveloperImage(
  workingDirectory: string,
): Promise<DeveloperImage> {
  const architecture = currentDeveloperImageArchitecture();
  const releaseAsset = DEVELOPER_IMAGE_RELEASE.assets[architecture];
  const archivePath =
    `${Deno.cwd()}/dist/developer-image/gondolin-image-openorb-developer-${DEVELOPER_IMAGE_RELEASE.id}-${releaseAsset.gondolinArchitecture}.tar.gz`;

  let metadata: LocalDeveloperImageMetadata;
  let archiveInfo: Deno.FileInfo;
  try {
    metadata = JSON.parse(await Deno.readTextFile(`${archivePath}.json`));
    archiveInfo = await Deno.lstat(archivePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `The local developer image is missing; run "deno task build:image ${releaseAsset.gondolinArchitecture}" first.`,
      );
    }
    throw error;
  }

  const release: DeveloperImageRelease = {
    id: metadata.releaseId,
    assets: {
      ...DEVELOPER_IMAGE_RELEASE.assets,
      [architecture]: {
        ...releaseAsset,
        gondolinBuildId: metadata.gondolinBuildId,
        manifestSha256: metadata.manifestSha256,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
      },
    },
  };
  return await ensureDeveloperImage({
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
}
