import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { UntarStream } from "@std/tar";

import {
  DEVELOPER_IMAGE_RELEASE,
  type DeveloperImageArchitecture,
  type DeveloperImageAssetRelease,
  type DeveloperImageRelease,
} from "@/src/developer-image-release.ts";
import {
  type DeveloperImageManifest,
  parseDeveloperImageManifest,
} from "@/src/developer-image-manifest.ts";

const VERIFIED_DEVELOPER_IMAGE = Symbol("verified OpenOrb developer image");
const IMAGE_FILES = new Set([
  "manifest.json",
  "vmlinuz-virt",
  "initramfs.cpio.lz4",
  "rootfs.ext4",
  "krun-kernel",
  "krun-empty-initrd",
]);
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_UNCOMPRESSED_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_ASSETS = {
  kernel: "vmlinuz-virt",
  initramfs: "initramfs.cpio.lz4",
  rootfs: "rootfs.ext4",
  krunKernel: "krun-kernel",
  krunInitrd: "krun-empty-initrd",
} as const;
const MANIFEST_ASSET_NAMES = [
  "kernel",
  "initramfs",
  "rootfs",
  "krunKernel",
  "krunInitrd",
] as const;

export interface DeveloperImage {
  readonly path: string;
  readonly releaseId: string;
  readonly architecture: DeveloperImageArchitecture;
  readonly gondolinBuildId: string;
  readonly [VERIFIED_DEVELOPER_IMAGE]: DeveloperImageRelease;
}

export interface DeveloperImageVmAssets {
  readonly kernelPath: string;
  readonly initrdPath: string;
  readonly rootfsPath: string;
}

interface FetchImage {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface EnsureDeveloperImageOptions {
  workingDirectory: string;
  architecture?: DeveloperImageArchitecture;
  release?: DeveloperImageRelease;
  fetch?: FetchImage;
}

export interface VerifyDeveloperImageOptions {
  architecture?: DeveloperImageArchitecture;
  release?: DeveloperImageRelease;
}

export async function ensureDeveloperImage(
  options: EnsureDeveloperImageOptions,
): Promise<DeveloperImage> {
  const release = options.release ?? DEVELOPER_IMAGE_RELEASE;
  const architecture = options.architecture ?? currentDeveloperImageArchitecture();
  validateReleaseId(release.id);
  const asset = release.assets[architecture];
  validateReleaseAsset(asset, architecture);

  const imagesDirectory = join(options.workingDirectory, "images");
  const releaseDirectory = join(imagesDirectory, release.id);
  const imageDirectory = join(releaseDirectory, architecture);
  if (await pathExists(imageDirectory)) {
    return await verifyDeveloperImage(imageDirectory, { architecture, release });
  }

  await ensureRealDirectory(imagesDirectory);
  await ensureRealDirectory(releaseDirectory);
  const nonce = crypto.randomUUID();
  const archivePath = join(releaseDirectory, `.${architecture}.${nonce}.tar.gz`);
  const temporaryDirectory = join(releaseDirectory, `.${architecture}.${nonce}.installing`);

  try {
    await downloadArchive(asset, archivePath, options.fetch ?? fetch);
    await Deno.mkdir(temporaryDirectory, { mode: 0o700 });
    await extractArchive(archivePath, temporaryDirectory);
    const verified = await verifyDeveloperImage(temporaryDirectory, { architecture, release });
    try {
      await Deno.rename(temporaryDirectory, imageDirectory);
    } catch (error) {
      if (await pathExists(imageDirectory)) {
        return await verifyDeveloperImage(imageDirectory, { architecture, release });
      }
      throw error;
    }
    return { ...verified, path: resolve(imageDirectory) };
  } catch (error) {
    throw new Error(
      `Unable to install OpenOrb developer image ${release.id} for ${architecture}: ${
        errorMessage(error)
      }`,
    );
  } finally {
    await removeIfPresent(archivePath);
    await removeIfPresent(temporaryDirectory, true);
  }
}

export async function verifyDeveloperImage(
  imageDirectory: string,
  options: VerifyDeveloperImageOptions = {},
): Promise<DeveloperImage> {
  const release = options.release ?? DEVELOPER_IMAGE_RELEASE;
  const architecture = options.architecture ?? currentDeveloperImageArchitecture();
  validateReleaseId(release.id);
  const asset = release.assets[architecture];
  validateReleaseAsset(asset, architecture);

  const expectedPath = resolve(imageDirectory);
  let directoryInfo: Deno.FileInfo;
  try {
    directoryInfo = await Deno.lstat(expectedPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw invalidImageError(release.id, expectedPath, "the image directory is missing");
    }
    throw error;
  }
  if (!directoryInfo.isDirectory || directoryInfo.isSymlink) {
    throw invalidImageError(release.id, expectedPath, "the image path is not a real directory");
  }
  const realPath = await Deno.realPath(expectedPath);
  if (realPath !== expectedPath) {
    throw invalidImageError(release.id, expectedPath, `the image resolves through ${realPath}`);
  }

  const found = new Set<string>();
  for await (const entry of Deno.readDir(realPath)) {
    if (!IMAGE_FILES.has(entry.name)) {
      throw invalidImageError(release.id, realPath, `unexpected asset ${entry.name}`);
    }
    if (!entry.isFile || entry.isSymlink) {
      throw invalidImageError(release.id, realPath, `asset ${entry.name} is not a regular file`);
    }
    found.add(entry.name);
  }
  for (const expected of IMAGE_FILES) {
    if (!found.has(expected)) {
      throw invalidImageError(release.id, realPath, `required asset ${expected} is missing`);
    }
  }

  const manifestPath = join(realPath, "manifest.json");
  const manifestInfo = await Deno.lstat(manifestPath);
  if (manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw invalidImageError(release.id, realPath, "manifest.json is too large");
  }
  const manifestBytes = await Deno.readFile(manifestPath);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw invalidImageError(release.id, realPath, "manifest.json is too large");
  }
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestSha256 !== asset.manifestSha256) {
    throw invalidImageError(
      release.id,
      realPath,
      "manifest.json SHA-256 does not match release metadata",
    );
  }
  const manifest = parseManifest(
    new TextDecoder().decode(manifestBytes),
    realPath,
    release.id,
  );
  validateManifest(manifest, asset, realPath, release.id);
  if (!await verifyManifestChecksums(realPath, manifest)) {
    throw invalidImageError(release.id, realPath, "an asset checksum does not match manifest.json");
  }

  return {
    path: realPath,
    releaseId: release.id,
    architecture,
    gondolinBuildId: asset.gondolinBuildId,
    [VERIFIED_DEVELOPER_IMAGE]: pinRelease(release),
  };
}

export async function prepareDeveloperImageForVm(
  image: DeveloperImage,
): Promise<DeveloperImageVmAssets> {
  const release = image[VERIFIED_DEVELOPER_IMAGE];
  const asset = release?.assets[image.architecture];
  if (
    !asset || release.id !== image.releaseId ||
    asset.gondolinBuildId !== image.gondolinBuildId
  ) {
    throw new Error("The OpenOrb developer image handle is invalid.");
  }

  const verified = await verifyDeveloperImage(image.path, {
    architecture: image.architecture,
    release,
  });
  return {
    kernelPath: join(verified.path, "vmlinuz-virt"),
    initrdPath: join(verified.path, "initramfs.cpio.lz4"),
    rootfsPath: join(verified.path, "rootfs.ext4"),
  };
}

export function currentDeveloperImageArchitecture(
  architecture: string = Deno.build.arch,
): DeveloperImageArchitecture {
  if (architecture === "x86_64" || architecture === "x64" || architecture === "amd64") {
    return "x64";
  }
  if (architecture === "aarch64" || architecture === "arm64") return "arm64";
  throw new Error(
    `No OpenOrb developer image is available for host architecture "${architecture}".`,
  );
}

async function downloadArchive(
  asset: DeveloperImageAssetRelease,
  destination: string,
  fetchImage: FetchImage,
): Promise<void> {
  const response = await fetchImage(asset.url, {
    headers: { "user-agent": "openorb-runner/developer-image" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `download failed with HTTP ${response.status} ${response.statusText} from ${asset.url}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) !== asset.sizeBytes) {
    await response.body.cancel();
    throw new Error(
      `download size header is ${contentLength} bytes; expected ${asset.sizeBytes} bytes`,
    );
  }

  const file = await Deno.open(destination, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > asset.sizeBytes) {
        throw new Error(
          `download exceeded the pinned size of ${asset.sizeBytes} bytes from ${asset.url}`,
        );
      }
      hash.update(chunk);
      await writeAll(file, chunk);
    }
    await file.sync();
  } finally {
    file.close();
  }

  if (received !== asset.sizeBytes) {
    throw new Error(`downloaded ${received} bytes; expected ${asset.sizeBytes} bytes`);
  }
  const checksum = hash.digest("hex");
  if (checksum !== asset.sha256) {
    throw new Error(`download SHA-256 is ${checksum}; expected ${asset.sha256}`);
  }
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const source = await Deno.open(archivePath, { read: true });
  const seen = new Set<string>();
  let totalBytes = 0;
  const entries = source.readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());

  for await (const entry of entries) {
    if (!IMAGE_FILES.has(entry.path) || seen.has(entry.path) || !entry.readable) {
      await entry.readable?.cancel();
      throw new Error(`image archive contains an invalid entry: ${entry.path}`);
    }
    if (entry.header.typeflag !== "0" && entry.header.typeflag !== "\0") {
      await entry.readable.cancel();
      throw new Error(`image archive entry is not a regular file: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0) {
      await entry.readable.cancel();
      throw new Error(`image archive entry has an invalid size: ${entry.path}`);
    }
    totalBytes += entry.header.size;
    if (totalBytes > MAX_UNCOMPRESSED_IMAGE_BYTES) {
      await entry.readable.cancel();
      throw new Error("image archive expands beyond the 2 GiB safety limit");
    }

    const output = await Deno.open(join(destination, entry.path), {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    let written = 0;
    try {
      for await (const chunk of entry.readable) {
        written += chunk.byteLength;
        if (written > entry.header.size) {
          throw new Error(`image archive entry exceeds its declared size: ${entry.path}`);
        }
        await writeAll(output, chunk);
      }
      await output.sync();
    } finally {
      output.close();
    }
    if (written !== entry.header.size) {
      throw new Error(
        `image archive entry ${entry.path} contains ${written} bytes; expected ${entry.header.size}`,
      );
    }
    seen.add(entry.path);
  }

  for (const expected of IMAGE_FILES) {
    if (!seen.has(expected)) throw new Error(`image archive is missing ${expected}`);
  }
}

function parseManifest(
  text: string,
  imagePath: string,
  releaseId: string,
): DeveloperImageManifest {
  try {
    return parseDeveloperImageManifest(JSON.parse(text));
  } catch {
    throw invalidImageError(releaseId, imagePath, "manifest.json is not valid JSON");
  }
}

function validateManifest(
  manifest: DeveloperImageManifest,
  asset: DeveloperImageAssetRelease,
  imagePath: string,
  releaseId: string,
): void {
  if (
    manifest.version !== 1 || manifest.buildId !== asset.gondolinBuildId ||
    manifest.config?.arch !== asset.gondolinArchitecture ||
    manifest.runtimeDefaults?.rootfsMode !== "cow"
  ) {
    throw invalidImageError(
      releaseId,
      imagePath,
      `manifest identity is incompatible with ${asset.gondolinBuildId} (${asset.gondolinArchitecture})`,
    );
  }
  for (const name of MANIFEST_ASSET_NAMES) {
    if (manifest.assets[name] !== MANIFEST_ASSETS[name]) {
      throw invalidImageError(releaseId, imagePath, `manifest has an invalid ${name} asset`);
    }
    if (!SHA256_PATTERN.test(manifest.checksums[name] ?? "")) {
      throw invalidImageError(releaseId, imagePath, `manifest has an invalid ${name} checksum`);
    }
  }
}

async function verifyManifestChecksums(
  imagePath: string,
  manifest: DeveloperImageManifest,
): Promise<boolean> {
  for (const name of MANIFEST_ASSET_NAMES) {
    if (await fileSha256(join(imagePath, MANIFEST_ASSETS[name])) !== manifest.checksums[name]) {
      return false;
    }
  }
  return true;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1024 * 1024);
  try {
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

function validateReleaseAsset(
  asset: DeveloperImageAssetRelease,
  architecture: DeveloperImageArchitecture,
): void {
  const expectedGondolinArchitecture = architecture === "x64" ? "x86_64" : "aarch64";
  if (
    asset.gondolinArchitecture !== expectedGondolinArchitecture ||
    !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 ||
    !SHA256_PATTERN.test(asset.manifestSha256) ||
    !SHA256_PATTERN.test(asset.sha256) || new URL(asset.url).protocol !== "https:"
  ) {
    throw new Error(`Invalid OpenOrb developer image release metadata for ${architecture}.`);
  }
}

function pinRelease(release: DeveloperImageRelease): DeveloperImageRelease {
  const pinned: DeveloperImageRelease = {
    id: release.id,
    assets: {
      arm64: { ...release.assets.arm64 },
      x64: { ...release.assets.x64 },
    },
  };
  Object.freeze(pinned.assets.arm64);
  Object.freeze(pinned.assets.x64);
  Object.freeze(pinned.assets);
  return Object.freeze(pinned);
}

function validateReleaseId(releaseId: string): void {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Invalid OpenOrb developer image release ID: ${releaseId}.`);
  }
}

function invalidImageError(releaseId: string, path: string, reason: string): Error {
  return new Error(
    `OpenOrb developer image ${releaseId} at ${path} is unavailable or incompatible: ${reason}. ` +
      "Remove that image directory and restart the runner to download a verified copy.",
  );
}

async function ensureRealDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || await Deno.realPath(path) !== resolve(path)) {
    throw new Error(`Runner image directory must be a real directory: ${path}`);
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeIfPresent(path: string, recursive = false): Promise<void> {
  try {
    await Deno.remove(path, { recursive });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
