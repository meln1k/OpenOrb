import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Architecture,
  buildAssets,
  type OciRootfsConfig,
  parseBuildConfig,
  verifyAssets,
} from "@earendil-works/gondolin";
import { TarStream, type TarStreamInput } from "@std/tar";
import { err, ok, type Result, tryAsync } from "@openorb/result";

import {
  type GuestImageManifest,
  parseGuestImageManifest,
} from "@/packages/runner/src/environment/gondolin/guest-image/manifest.ts";

export const GUEST_IMAGE_RELEASE_ID = "mvp-5";
export const GUEST_IMAGE_FILES = [
  "manifest.json",
  "vmlinuz-virt",
  "initramfs.cpio.lz4",
  "rootfs.ext4",
  "krun-kernel",
  "krun-empty-initrd",
] as const;

const REPRODUCIBLE_BUILD_TIME = "1970-01-01T00:00:00.000Z";
const AGENT_BROWSER_VERSION = "0.35.0";
const AGENT_BROWSER_LICENSE_SHA256 =
  "014bb31e83d5c2e76aea1cc6e82217346ab41362f32cb355ad0f5c10aa0aeaff";
const AGENT_BROWSER_SOURCE_SHA256 =
  "ea4331fae4ddbc1d787908011347234d5ddb88ec920dec7c7240801a9687d04a";
const BUN_VERSION = "1.3.10";
const BUN_LICENSE_SHA256 = "7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb";
const CHROMIUM_VERSION = "151.0.7922.71-1~deb13u1";
const COREPACK_VERSION = "0.20.0";
const COREPACK_SHA256 = "3fa310217f641e51dc8d7f707ded3c75261d2745e9601b190d7c16901e11624b";
const NODE_VERSION = "26.5.1";
const PNPM_VERSION = "11.1.3";
const PNPM_SHA256 = "740302fe768aaf1ba680c5213bd08983f219e0bcf0c96c0c6d7be393b8620c98";
const WEBSOCAT_VERSION = "1.14.1";
const WEBSOCAT_LICENSE_SHA256 = "6591a6a5ce89cb8c5ff2f9d95f1a43725ee7ea45d76a502337e022add93e36f6";
const YARN_VERSION = "1.22.19";
const YARN_SHA256 = "732620bac8b1690d507274f025f3c6cfdc3627a84d9642e38a07452cc00e0f2e";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEBIAN_ROOTFS_BUILDS = {
  x86_64: {
    agentBrowserAsset: "agent-browser-linux-x64",
    agentBrowserSha256: "b7a28c3a43a7008dd02585e2e60c391c08983f7a099149caed63c9f13f57b752",
    baseImage:
      "docker.io/library/debian@sha256:38a76d01668772e381ad2826d876627c89e7133e2f8a0f5d567306798b0f2a16",
    bunAsset: "bun-linux-x64-baseline.zip",
    bunSha256: "41201a8c5ee74a9dcbb1ce25a1104f1f929838b57a845aa78d98379b0ce7cde2",
    image: "localhost/openorb-guest-debian:x86_64",
    nodeAsset: "node-v26.5.1-linux-x64.tar.xz",
    nodeSha256: "cc7b3484ade63bd203a9d304f21ec37a3b622b988d7bdecf1dc4d68fc44a91b7",
    platform: "linux/amd64",
    websocatAsset: "websocat.x86_64-unknown-linux-musl",
    websocatSha256: "66f8dd3a0394761556339117f8bb5123bddefd44e087af2a72ec22b0bd08d514",
  },
  aarch64: {
    agentBrowserAsset: "agent-browser-linux-arm64",
    agentBrowserSha256: "92cd7d0897837ac648b9a6ab1965c69c5920e0f54df57e4295cdb1143b0541c8",
    baseImage:
      "docker.io/library/debian@sha256:c94f5ddd41327aa2d4a7cfba7889056c02936182fd76a513fec6160c97181fc0",
    bunAsset: "bun-linux-aarch64.zip",
    bunSha256: "fa5ecb25cafa8e8f5c87a0f833719d46dd0af0a86c7837d806531212d55636d3",
    image: "localhost/openorb-guest-debian:aarch64",
    nodeAsset: "node-v26.5.1-linux-arm64.tar.xz",
    nodeSha256: "0b6b0cc2a1eecbe736f9918de8b5a6c9a48d286b88bec1298a3c1e3376182ea8",
    platform: "linux/arm64",
    websocatAsset: "websocat.aarch64-unknown-linux-musl",
    websocatSha256: "711a69576a2ff473fb01a90ffafb571c2ed019e55479d7ae71b12c2eadeb7011",
  },
} satisfies Record<
  Architecture,
  {
    agentBrowserAsset: string;
    agentBrowserSha256: string;
    baseImage: string;
    bunAsset: string;
    bunSha256: string;
    image: string;
    nodeAsset: string;
    nodeSha256: string;
    platform: string;
    websocatAsset: string;
    websocatSha256: string;
  }
>;

class GuestImageBuildError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GuestImageBuildError";
  }
}

if (import.meta.main) {
  const architecture = parseArchitecture(Deno.args[0]);
  const outputDirectory = join(
    repositoryRoot,
    "dist",
    "guest-image",
    GUEST_IMAGE_RELEASE_ID,
    architecture,
  );
  const configPath = join(repositoryRoot, "images", "guest", `${architecture}.json`);
  const config = parseBuildConfig(await Deno.readTextFile(configPath));
  if (config.arch !== architecture) {
    throw new Error(
      `Guest image config ${configPath} targets ${config.arch}, expected ${architecture}.`,
    );
  }
  await buildGuestRootfsImage(architecture, config.oci);

  const [, removeError] = await tryAsync(
    Deno.remove(outputDirectory, { recursive: true }),
    (cause) =>
      new GuestImageBuildError(
        `The previous guest image output could not be removed: ${outputDirectory}.`,
        cause,
      ),
  );
  if (removeError && !(removeError.cause instanceof Deno.errors.NotFound)) throw removeError;
  const result = await buildAssets(config, {
    outputDir: outputDirectory,
    configDir: dirname(configPath),
  });

  const manifest = await normalizeManifest(result.manifestPath);
  if (!verifyAssets(outputDirectory)) {
    throw new Error(`Gondolin rejected the built guest image at ${outputDirectory}.`);
  }

  const archiveName = guestImageArchiveName(architecture);
  const archivePath = join(repositoryRoot, "dist", "guest-image", archiveName);
  const [, archiveError] = await createArchive(outputDirectory, archivePath);
  if (archiveError !== undefined) throw archiveError;
  const archive = await inspectFile(archivePath);
  const manifestFile = await inspectFile(result.manifestPath);
  const metadata = {
    releaseId: GUEST_IMAGE_RELEASE_ID,
    architecture,
    gondolinBuildId: requiredBuildId(manifest),
    manifestSha256: manifestFile.sha256,
    archive: basename(archivePath),
    sizeBytes: archive.sizeBytes,
    sha256: archive.sha256,
  };
  await Deno.writeTextFile(`${archivePath}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata));
}

export function guestImageArchiveName(architecture: Architecture): string {
  return `gondolin-image-openorb-guest-${GUEST_IMAGE_RELEASE_ID}-${architecture}.tar.gz`;
}

function parseArchitecture(input: string | undefined): Architecture {
  if (input === "aarch64" || input === "x86_64") return input;
  throw new Error("Usage: deno task build:image <aarch64|x86_64>");
}

async function buildGuestRootfsImage(
  architecture: Architecture,
  oci: OciRootfsConfig | undefined,
): Promise<void> {
  const build = DEBIAN_ROOTFS_BUILDS[architecture];
  if (
    oci?.image !== build.image || oci.platform !== build.platform || oci.runtime !== "podman" ||
    oci.pullPolicy !== "never"
  ) {
    throw new Error(
      `Guest image config must use the pinned local Debian OCI image for ${architecture}.`,
    );
  }

  const containerfile = join(
    repositoryRoot,
    "images",
    "guest",
    "debian-rootfs.Containerfile",
  );
  const status = await new Deno.Command("podman", {
    args: [
      "--cgroup-manager=cgroupfs",
      "--events-backend=file",
      "build",
      "--format=oci",
      "--network=host",
      "--pull=always",
      "--timestamp=0",
      `--platform=${build.platform}`,
      `--build-arg=AGENT_BROWSER_ASSET=${build.agentBrowserAsset}`,
      `--build-arg=AGENT_BROWSER_LICENSE_SHA256=${AGENT_BROWSER_LICENSE_SHA256}`,
      `--build-arg=AGENT_BROWSER_SHA256=${build.agentBrowserSha256}`,
      `--build-arg=AGENT_BROWSER_SOURCE_SHA256=${AGENT_BROWSER_SOURCE_SHA256}`,
      `--build-arg=AGENT_BROWSER_VERSION=${AGENT_BROWSER_VERSION}`,
      `--build-arg=BUN_ASSET=${build.bunAsset}`,
      `--build-arg=BUN_LICENSE_SHA256=${BUN_LICENSE_SHA256}`,
      `--build-arg=BUN_SHA256=${build.bunSha256}`,
      `--build-arg=BUN_VERSION=${BUN_VERSION}`,
      `--build-arg=CHROMIUM_VERSION=${CHROMIUM_VERSION}`,
      `--build-arg=COREPACK_SHA256=${COREPACK_SHA256}`,
      `--build-arg=COREPACK_VERSION=${COREPACK_VERSION}`,
      `--build-arg=DEBIAN_BASE_IMAGE=${build.baseImage}`,
      `--build-arg=NODE_ASSET=${build.nodeAsset}`,
      `--build-arg=NODE_SHA256=${build.nodeSha256}`,
      `--build-arg=NODE_VERSION=${NODE_VERSION}`,
      `--build-arg=PNPM_SHA256=${PNPM_SHA256}`,
      `--build-arg=PNPM_VERSION=${PNPM_VERSION}`,
      `--build-arg=WEBSOCAT_ASSET=${build.websocatAsset}`,
      `--build-arg=WEBSOCAT_LICENSE_SHA256=${WEBSOCAT_LICENSE_SHA256}`,
      `--build-arg=WEBSOCAT_SHA256=${build.websocatSha256}`,
      `--build-arg=WEBSOCAT_VERSION=${WEBSOCAT_VERSION}`,
      `--build-arg=YARN_SHA256=${YARN_SHA256}`,
      `--build-arg=YARN_VERSION=${YARN_VERSION}`,
      `--tag=${build.image}`,
      `--file=${containerfile}`,
      dirname(containerfile),
    ],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(
      `The Debian OCI rootfs build failed for ${architecture} with status ${status.code}.`,
    );
  }
}

async function normalizeManifest(path: string): Promise<GuestImageManifest> {
  const manifest = parseGuestImageManifest(
    JSON.parse(await Deno.readTextFile(path)),
  );
  requiredBuildId(manifest);
  manifest.buildTime = REPRODUCIBLE_BUILD_TIME;
  await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function requiredBuildId(manifest: GuestImageManifest): string {
  if (!manifest.buildId) throw new Error("Built guest image manifest has no build ID.");
  return manifest.buildId;
}

async function createArchive(
  sourceDirectory: string,
  destination: string,
): Promise<Result<void, GuestImageBuildError>> {
  const [, archiveError] = await tryAsync(
    (async () => {
      await Deno.mkdir(dirname(destination), { recursive: true });
      const output = await Deno.open(destination, {
        create: true,
        truncate: true,
        write: true,
        mode: 0o600,
      });
      const entries = ReadableStream.from<TarStreamInput>(archiveEntries(sourceDirectory));
      await entries
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(output.writable);
    })(),
    (cause) =>
      new GuestImageBuildError(
        `The guest image archive could not be created: ${destination}.`,
        cause,
      ),
  );
  if (!archiveError) return ok(undefined);
  await tryAsync(Deno.remove(destination), () => undefined);
  return err(archiveError);
}

async function* archiveEntries(sourceDirectory: string): AsyncGenerator<TarStreamInput> {
  for (const name of GUEST_IMAGE_FILES) {
    const path = join(sourceDirectory, name);
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) {
      throw new Error(`Guest image asset must be a regular file: ${path}.`);
    }
    yield {
      type: "file",
      path: name,
      size: info.size,
      readable: (await Deno.open(path, { read: true })).readable,
      options: { mode: 0o644, uid: 0, gid: 0, mtime: 0 },
    };
  }
}

async function inspectFile(path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  using file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1024 * 1024);
  let sizeBytes = 0;
  while (true) {
    const bytesRead = await file.read(buffer);
    if (bytesRead === null) break;
    sizeBytes += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}
