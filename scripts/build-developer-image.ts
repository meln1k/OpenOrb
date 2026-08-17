import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Architecture,
  type AssetManifest,
  buildAssets,
  parseBuildConfig,
  verifyAssets,
} from "@earendil-works/gondolin";
import { TarStream, type TarStreamInput } from "@std/tar";

export const DEVELOPER_IMAGE_RELEASE_ID = "mvp-1";
export const DEVELOPER_IMAGE_FILES = [
  "manifest.json",
  "vmlinuz-virt",
  "initramfs.cpio.lz4",
  "rootfs.ext4",
  "krun-kernel",
  "krun-empty-initrd",
] as const;

const REPRODUCIBLE_BUILD_TIME = "1970-01-01T00:00:00.000Z";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (import.meta.main) {
  const architecture = parseArchitecture(Deno.args[0]);
  const outputDirectory = join(
    repositoryRoot,
    "dist",
    "developer-image",
    DEVELOPER_IMAGE_RELEASE_ID,
    architecture,
  );
  const configPath = join(repositoryRoot, "images", "developer", `${architecture}.json`);
  const config = parseBuildConfig(await Deno.readTextFile(configPath));
  if (config.arch !== architecture) {
    throw new Error(
      `Developer image config ${configPath} targets ${config.arch}, expected ${architecture}.`,
    );
  }

  await Deno.remove(outputDirectory, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const result = await buildAssets(config, {
    outputDir: outputDirectory,
    configDir: dirname(configPath),
  });

  const manifest = await normalizeManifest(result.manifestPath);
  if (!verifyAssets(outputDirectory)) {
    throw new Error(`Gondolin rejected the built developer image at ${outputDirectory}.`);
  }

  const archiveName = developerImageArchiveName(architecture);
  const archivePath = join(repositoryRoot, "dist", "developer-image", archiveName);
  await createArchive(outputDirectory, archivePath);
  const archive = await inspectFile(archivePath);
  const manifestFile = await inspectFile(result.manifestPath);
  const metadata = {
    releaseId: DEVELOPER_IMAGE_RELEASE_ID,
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

export function developerImageArchiveName(architecture: Architecture): string {
  return `gondolin-image-openorb-developer-${DEVELOPER_IMAGE_RELEASE_ID}-${architecture}.tar.gz`;
}

function parseArchitecture(input: string | undefined): Architecture {
  if (input === "aarch64" || input === "x86_64") return input;
  throw new Error("Usage: deno task build:image <aarch64|x86_64>");
}

async function normalizeManifest(path: string): Promise<AssetManifest> {
  const manifest = JSON.parse(await Deno.readTextFile(path)) as AssetManifest;
  requiredBuildId(manifest);
  manifest.buildTime = REPRODUCIBLE_BUILD_TIME;
  await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function requiredBuildId(manifest: AssetManifest): string {
  if (!manifest.buildId) throw new Error("Built developer image manifest has no build ID.");
  return manifest.buildId;
}

async function createArchive(sourceDirectory: string, destination: string): Promise<void> {
  await Deno.mkdir(dirname(destination), { recursive: true });
  const output = await Deno.open(destination, {
    create: true,
    truncate: true,
    write: true,
    mode: 0o600,
  });
  const entries = ReadableStream.from<TarStreamInput>(archiveEntries(sourceDirectory));
  try {
    await entries
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream("gzip"))
      .pipeTo(output.writable);
  } catch (error) {
    await Deno.remove(destination).catch(() => undefined);
    throw error;
  }
}

async function* archiveEntries(sourceDirectory: string): AsyncGenerator<TarStreamInput> {
  for (const name of DEVELOPER_IMAGE_FILES) {
    const path = join(sourceDirectory, name);
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) {
      throw new Error(`Developer image asset must be a regular file: ${path}.`);
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
  const file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1024 * 1024);
  let sizeBytes = 0;
  try {
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      sizeBytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    file.close();
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}
