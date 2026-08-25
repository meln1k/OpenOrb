import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { UntarStream } from "@std/tar";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import {
  DEVELOPER_IMAGE_RELEASE,
  type DeveloperImageArchitecture,
  type DeveloperImageAssetRelease,
  type DeveloperImageRelease,
} from "./release.ts";
import { type DeveloperImageManifest, parseDeveloperImageManifest } from "./manifest.ts";

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
): Promise<Result<DeveloperImage, DeveloperImageError>> {
  const [configuration, configurationError] = trySync(
    () => {
      const release = options.release ?? DEVELOPER_IMAGE_RELEASE;
      const architecture = options.architecture ?? currentDeveloperImageArchitecture();
      validateReleaseId(release.id);
      const asset = release.assets[architecture];
      validateReleaseAsset(asset, architecture);
      const imagesDirectory = join(options.workingDirectory, "images");
      const releaseDirectory = join(imagesDirectory, release.id);
      return {
        release,
        architecture,
        asset,
        imagesDirectory,
        releaseDirectory,
        imageDirectory: join(releaseDirectory, architecture),
      };
    },
    (cause) => developerImageError("Developer image configuration is invalid", cause),
  );
  if (configurationError !== undefined) return err(configurationError);
  const { release, architecture, asset, imagesDirectory, releaseDirectory, imageDirectory } =
    configuration;

  const [imageExists, existenceError] = await pathExists(imageDirectory);
  if (existenceError !== undefined) return err(existenceError);
  if (imageExists) return await verifyDeveloperImage(imageDirectory, { architecture, release });

  const [, directoryError] = await tryAsync(
    (async () => {
      await ensureRealDirectory(imagesDirectory);
      await ensureRealDirectory(releaseDirectory);
    })(),
    (cause) => developerImageError("Developer image directories could not be prepared", cause),
  );
  if (directoryError !== undefined) return err(directoryError);
  const nonce = crypto.randomUUID();
  const archivePath = join(releaseDirectory, `.${architecture}.${nonce}.tar.gz`);
  const temporaryDirectory = join(releaseDirectory, `.${architecture}.${nonce}.installing`);

  const [installedImage, installError] = await installDeveloperImage(
    asset,
    archivePath,
    temporaryDirectory,
    imageDirectory,
    architecture,
    release,
    options.fetch ?? fetch,
  );
  if (installError !== undefined) {
    const [, cleanupError] = await cleanupInstallation(archivePath, temporaryDirectory);
    if (cleanupError !== undefined) return err(cleanupError);
    return err(installError);
  }
  const [, cleanupError] = await cleanupInstallation(archivePath, temporaryDirectory);
  if (cleanupError !== undefined) return err(cleanupError);
  return ok(installedImage);
}

async function installDeveloperImage(
  asset: DeveloperImageAssetRelease,
  archivePath: string,
  temporaryDirectory: string,
  imageDirectory: string,
  architecture: DeveloperImageArchitecture,
  release: DeveloperImageRelease,
  fetchImage: FetchImage,
): Promise<Result<DeveloperImage, DeveloperImageError>> {
  const [, installError] = await tryAsync(
    (async () => {
      await downloadArchive(asset, archivePath, fetchImage);
      await Deno.mkdir(temporaryDirectory, { mode: 0o700 });
      await extractArchive(archivePath, temporaryDirectory);
      return undefined;
    })(),
    (cause) =>
      developerImageError(
        `Unable to install OpenOrb developer image ${release.id} for ${architecture}: ${
          errorMessage(cause)
        }`,
        cause,
      ),
  );
  if (installError !== undefined) return err(installError);
  const [verified, verificationError] = await verifyDeveloperImage(temporaryDirectory, {
    architecture,
    release,
  });
  if (verificationError !== undefined) return err(verificationError);
  const [, renameError] = await tryAsync(
    Deno.rename(temporaryDirectory, imageDirectory),
    (cause) => developerImageError("Developer image installation could not be committed", cause),
  );
  if (renameError !== undefined) {
    const [concurrentInstallExists, concurrentExistenceError] = await pathExists(imageDirectory);
    if (concurrentExistenceError !== undefined) return err(concurrentExistenceError);
    if (!concurrentInstallExists) return err(renameError);
    return await verifyDeveloperImage(imageDirectory, { architecture, release });
  }
  return ok({ ...verified, path: resolve(imageDirectory) });
}

async function cleanupInstallation(
  archivePath: string,
  temporaryDirectory: string,
): Promise<Result<void, DeveloperImageError>> {
  const [, archiveCleanupError] = await removeIfPresent(archivePath);
  if (archiveCleanupError !== undefined) return err(archiveCleanupError);
  const [, directoryCleanupError] = await removeIfPresent(temporaryDirectory, true);
  if (directoryCleanupError !== undefined) return err(directoryCleanupError);
  return ok(undefined);
}

export async function verifyDeveloperImage(
  imageDirectory: string,
  options: VerifyDeveloperImageOptions = {},
): Promise<Result<DeveloperImage, DeveloperImageError>> {
  const release = options.release ?? DEVELOPER_IMAGE_RELEASE;
  const expectedPath = resolve(imageDirectory);
  return await tryAsync(
    verifyDeveloperImageValue(imageDirectory, options),
    (cause) =>
      cause instanceof Deno.errors.NotFound
        ? invalidImageError(release.id, expectedPath, "the image directory is missing")
        : developerImageError(`Developer image verification failed for ${imageDirectory}`, cause),
  );
}

async function verifyDeveloperImageValue(
  imageDirectory: string,
  options: VerifyDeveloperImageOptions,
): Promise<DeveloperImage> {
  const release = options.release ?? DEVELOPER_IMAGE_RELEASE;
  const architecture = options.architecture ?? currentDeveloperImageArchitecture();
  validateReleaseId(release.id);
  const asset = release.assets[architecture];
  validateReleaseAsset(asset, architecture);

  const expectedPath = resolve(imageDirectory);
  const directoryInfo = await Deno.lstat(expectedPath);
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
  const manifest = parseManifest(new TextDecoder().decode(manifestBytes));
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
): Promise<Result<DeveloperImageVmAssets, DeveloperImageError>> {
  const release = image[VERIFIED_DEVELOPER_IMAGE];
  const asset = release?.assets[image.architecture];
  if (
    !asset || release.id !== image.releaseId ||
    asset.gondolinBuildId !== image.gondolinBuildId
  ) {
    return err(
      new DeveloperImageError("The OpenOrb developer image handle is invalid.", undefined),
    );
  }

  const [verified, verificationError] = await verifyDeveloperImage(image.path, {
    architecture: image.architecture,
    release,
  });
  if (verificationError !== undefined) return err(verificationError);
  return ok({
    kernelPath: join(verified.path, "vmlinuz-virt"),
    initrdPath: join(verified.path, "initramfs.cpio.lz4"),
    rootfsPath: join(verified.path, "rootfs.ext4"),
  });
}

export function currentDeveloperImageArchitecture(
  architecture: string = Deno.build.arch,
): DeveloperImageArchitecture {
  if (architecture === "x86_64" || architecture === "x64" || architecture === "amd64") {
    return "x64";
  }
  if (architecture === "aarch64" || architecture === "arm64") return "arm64";
  throw new DeveloperImageError(
    `No OpenOrb developer image is available for host architecture "${architecture}".`,
    undefined,
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
    throw new DeveloperImageError(
      `download failed with HTTP ${response.status} ${response.statusText} from ${asset.url}`,
      undefined,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) !== asset.sizeBytes) {
    await response.body.cancel();
    throw new DeveloperImageError(
      `download size header is ${contentLength} bytes; expected ${asset.sizeBytes} bytes`,
      undefined,
    );
  }

  using file = await Deno.open(destination, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > asset.sizeBytes) {
      throw new DeveloperImageError(
        `download exceeded the pinned size of ${asset.sizeBytes} bytes from ${asset.url}`,
        undefined,
      );
    }
    hash.update(chunk);
    await writeAll(file, chunk);
  }
  await file.sync();

  if (received !== asset.sizeBytes) {
    throw new DeveloperImageError(
      `downloaded ${received} bytes; expected ${asset.sizeBytes} bytes`,
      undefined,
    );
  }
  const checksum = hash.digest("hex");
  if (checksum !== asset.sha256) {
    throw new DeveloperImageError(
      `download SHA-256 is ${checksum}; expected ${asset.sha256}`,
      undefined,
    );
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
      throw new DeveloperImageError(
        `image archive contains an invalid entry: ${entry.path}`,
        undefined,
      );
    }
    if (entry.header.typeflag !== "0" && entry.header.typeflag !== "\0") {
      await entry.readable.cancel();
      throw new DeveloperImageError(
        `image archive entry is not a regular file: ${entry.path}`,
        undefined,
      );
    }
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0) {
      await entry.readable.cancel();
      throw new DeveloperImageError(
        `image archive entry has an invalid size: ${entry.path}`,
        undefined,
      );
    }
    totalBytes += entry.header.size;
    if (totalBytes > MAX_UNCOMPRESSED_IMAGE_BYTES) {
      await entry.readable.cancel();
      throw new DeveloperImageError(
        "image archive expands beyond the 2 GiB safety limit",
        undefined,
      );
    }

    using output = await Deno.open(join(destination, entry.path), {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    let written = 0;
    for await (const chunk of entry.readable) {
      written += chunk.byteLength;
      if (written > entry.header.size) {
        throw new DeveloperImageError(
          `image archive entry exceeds its declared size: ${entry.path}`,
          undefined,
        );
      }
      await writeAll(output, chunk);
    }
    await output.sync();
    if (written !== entry.header.size) {
      throw new DeveloperImageError(
        `image archive entry ${entry.path} contains ${written} bytes; expected ${entry.header.size}`,
        undefined,
      );
    }
    seen.add(entry.path);
  }

  for (const expected of IMAGE_FILES) {
    if (!seen.has(expected)) {
      throw new DeveloperImageError(`image archive is missing ${expected}`, undefined);
    }
  }
}

function parseManifest(text: string): DeveloperImageManifest {
  return parseDeveloperImageManifest(JSON.parse(text));
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
  using file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1024 * 1024);
  while (true) {
    const bytesRead = await file.read(buffer);
    if (bytesRead === null) break;
    hash.update(buffer.subarray(0, bytesRead));
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
    throw new DeveloperImageError(
      `Invalid OpenOrb developer image release metadata for ${architecture}.`,
      undefined,
    );
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
    throw new DeveloperImageError(
      `Invalid OpenOrb developer image release ID: ${releaseId}.`,
      undefined,
    );
  }
}

function invalidImageError(releaseId: string, path: string, reason: string): DeveloperImageError {
  return new DeveloperImageError(
    `OpenOrb developer image ${releaseId} at ${path} is unavailable or incompatible: ${reason}. ` +
      "Remove that image directory and restart the runner to download a verified copy.",
    undefined,
  );
}

async function ensureRealDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || await Deno.realPath(path) !== resolve(path)) {
    throw new DeveloperImageError(
      `Runner image directory must be a real directory: ${path}`,
      undefined,
    );
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
}

async function pathExists(path: string): Promise<Result<boolean, DeveloperImageError>> {
  const [, inspectionError] = await tryAsync(
    Deno.lstat(path),
    (cause) => developerImageError(`Developer image path could not be inspected: ${path}`, cause),
  );
  if (inspectionError !== undefined) {
    if (inspectionError.cause instanceof Deno.errors.NotFound) return ok(false);
    return err(inspectionError);
  }
  return ok(true);
}

async function removeIfPresent(
  path: string,
  recursive = false,
): Promise<Result<void, DeveloperImageError>> {
  const [, removalError] = await tryAsync(
    Deno.remove(path, { recursive }),
    (cause) =>
      developerImageError(`Developer image temporary path could not be removed: ${path}`, cause),
  );
  if (removalError !== undefined) {
    if (removalError.cause instanceof Deno.errors.NotFound) return ok(undefined);
    return err(removalError);
  }
  return ok(undefined);
}

export class DeveloperImageError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "DeveloperImageError";
  }
}

function developerImageError(message: string, cause: unknown): DeveloperImageError {
  return cause instanceof DeveloperImageError
    ? cause
    : new DeveloperImageError(`${message}: ${errorMessage(cause)}`, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
