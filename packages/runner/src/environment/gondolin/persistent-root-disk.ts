import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { type Result, tryAsync } from "@openorb/result";
import { Schema } from "effect";

export const OPENORB_ROOT_DISK_SIZE = "40G";
const ROOT_DISK_DETACH_TIMEOUT_MS = 15_000;
const ROOT_DISK_DETACH_RETRY_MS = 100;
const ImageInfo = Schema.fromJsonString(Schema.Struct({
  format: Schema.String,
  "backing-filename": Schema.optionalKey(Schema.String),
  "backing-filename-format": Schema.optionalKey(Schema.String),
}));

export interface PersistentRootDiskDetachmentOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly inspectImage?: (path: string) => Promise<boolean>;
}

interface PersistentRootDiskBacking {
  readonly backingPath: string;
  readonly backingFormat: "raw" | "qcow2";
  readonly inspectImage?: (path: string) => Promise<string>;
}

interface PersistentRootDiskOptions extends PersistentRootDiskBacking {
  readonly path: string;
  readonly createOverlay?: (
    candidatePath: string,
    backingPath: string,
    backingFormat: "raw" | "qcow2",
  ) => Promise<void>;
}

export class PersistentRootDiskError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message, { cause });
    this.name = "PersistentRootDiskError";
  }
}

/**
 * Publish a durable, caller-owned qcow2 overlay without ever replacing an
 * existing session disk. Candidate files are kept beside the target so the
 * hard-link publication boundary is atomic.
 */
export async function initializePersistentRootDisk(
  options: PersistentRootDiskOptions,
): Promise<Result<void, PersistentRootDiskError>> {
  return await tryAsync(
    initializePersistentRootDiskValue(options),
    (cause) =>
      cause instanceof PersistentRootDiskError
        ? cause
        : new PersistentRootDiskError("The persistent root disk could not be prepared.", cause),
  );
}

async function initializePersistentRootDiskValue(
  options: PersistentRootDiskOptions,
): Promise<void> {
  if (!isAbsolute(options.path) || !isAbsolute(options.backingPath)) {
    throw new PersistentRootDiskError("Persistent root disk paths must be absolute.");
  }
  const rootDiskPath = resolve(options.path);
  const backingPath = resolve(options.backingPath);
  if (rootDiskPath === backingPath) {
    throw new PersistentRootDiskError(
      "The persistent root disk cannot replace its backing image.",
    );
  }

  const directoryPath = dirname(rootDiskPath);
  await assertRealDirectory(directoryPath);
  await cleanupCandidates(directoryPath, basename(rootDiskPath));
  if (await assertRegularFileIfPresent(rootDiskPath)) {
    await assertBackingImage(rootDiskPath, options);
    await Deno.chmod(rootDiskPath, 0o600);
    return;
  }

  const candidatePath = `${rootDiskPath}.candidate-${crypto.randomUUID()}`;
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    const [, cleanupError] = await tryAsync(Deno.remove(candidatePath), (cause) => cause);
    if (cleanupError !== undefined) {
      if (cleanupError instanceof Deno.errors.NotFound) return;
      throw cleanupError;
    }
  });
  await (options.createOverlay ?? createQcow2Overlay)(
    candidatePath,
    backingPath,
    options.backingFormat,
  );
  await assertRegularFile(candidatePath);
  await Deno.chmod(candidatePath, 0o600);
  await syncFile(candidatePath);
  const [, publicationError] = await tryAsync(
    Deno.link(candidatePath, rootDiskPath),
    (cause) => cause,
  );
  if (publicationError !== undefined) {
    if (!(publicationError instanceof Deno.errors.AlreadyExists)) throw publicationError;
    await assertRegularFile(rootDiskPath);
    await assertBackingImage(rootDiskPath, options);
    return;
  }
  await syncDirectory(directoryPath);
}

export async function validatePersistentRootDisk(
  path: string,
  backing?: PersistentRootDiskBacking,
): Promise<Result<void, PersistentRootDiskError>> {
  return await tryAsync(
    (async () => {
      if (!isAbsolute(path)) {
        throw new PersistentRootDiskError("The persistent root disk path must be absolute.");
      }
      await assertRegularFile(resolve(path));
      if (backing !== undefined) await assertBackingImage(resolve(path), backing);
    })(),
    (cause) =>
      cause instanceof PersistentRootDiskError
        ? cause
        : new PersistentRootDiskError("The persistent root disk is unavailable.", cause),
  );
}

async function assertBackingImage(path: string, backing: PersistentRootDiskBacking): Promise<void> {
  if (!isAbsolute(backing.backingPath)) {
    throw new PersistentRootDiskError("The expected backing image path must be absolute.");
  }
  const json = await (backing.inspectImage ?? readImageInfo)(path);
  const info = Schema.decodeUnknownSync(ImageInfo)(json);
  if (
    info.format !== "qcow2" ||
    info["backing-filename"] !== resolve(backing.backingPath) ||
    info["backing-filename-format"] !== backing.backingFormat
  ) {
    throw new PersistentRootDiskError(
      "The persistent root disk does not match its pinned backing image.",
    );
  }
}

async function readImageInfo(path: string): Promise<string> {
  const output = await new Deno.Command("qemu-img", {
    args: ["info", "--output=json", path],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) {
    throw new PersistentRootDiskError(
      `qemu-img could not inspect the persistent root disk (status ${output.code}).`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

export async function assertPersistentRootDiskDetached(
  path: string,
  options: PersistentRootDiskDetachmentOptions = {},
): Promise<Result<void, PersistentRootDiskError>> {
  return await tryAsync(
    (async () => {
      const [, validationError] = await validatePersistentRootDisk(path);
      if (validationError !== undefined) {
        if (validationError.cause instanceof Deno.errors.NotFound) return;
        throw validationError;
      }
      const resolvedPath = resolve(path);
      const inspectImage = options.inspectImage ?? inspectQcow2Image;
      const timeoutMs = options.timeoutMs ?? ROOT_DISK_DETACH_TIMEOUT_MS;
      const retryMs = options.retryMs ?? ROOT_DISK_DETACH_RETRY_MS;
      const deadline = Date.now() + timeoutMs;
      do {
        if (await inspectImage(resolvedPath)) return;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      } while (Date.now() < deadline);
      throw new PersistentRootDiskError(
        "The persistent root disk may still be attached to a VM.",
      );
    })(),
    (cause) =>
      cause instanceof PersistentRootDiskError ? cause : new PersistentRootDiskError(
        "The persistent root disk attachment state could not be confirmed.",
        cause,
      ),
  );
}

async function inspectQcow2Image(path: string): Promise<boolean> {
  const output = await new Deno.Command("qemu-img", {
    args: ["info", "--output=json", path],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}

async function createQcow2Overlay(
  candidatePath: string,
  backingPath: string,
  backingFormat: "raw" | "qcow2",
): Promise<void> {
  const output = await new Deno.Command("qemu-img", {
    args: [
      "create",
      "-f",
      "qcow2",
      "-F",
      backingFormat,
      "-b",
      backingPath,
      candidatePath,
      OPENORB_ROOT_DISK_SIZE,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!output.success) {
    throw new PersistentRootDiskError(
      `qemu-img could not create the persistent root disk (status ${output.code}).`,
    );
  }
}

async function cleanupCandidates(directoryPath: string, rootDiskFile: string): Promise<void> {
  const prefix = `${rootDiskFile}.candidate-`;
  let removed = false;
  for await (const entry of Deno.readDir(directoryPath)) {
    if (!entry.name.startsWith(prefix)) continue;
    await Deno.remove(join(directoryPath, entry.name), { recursive: entry.isDirectory });
    removed = true;
  }
  if (removed) await syncDirectory(directoryPath);
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new PersistentRootDiskError(
      "The persistent root disk directory must be a real directory.",
    );
  }
}

async function assertRegularFileIfPresent(path: string): Promise<boolean> {
  const [, inspectionError] = await tryAsync(assertRegularFile(path), (cause) => cause);
  if (inspectionError !== undefined) {
    if (inspectionError instanceof Deno.errors.NotFound) return false;
    throw inspectionError;
  }
  return true;
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new PersistentRootDiskError("The persistent root disk must be a regular file.");
  }
}

async function syncFile(path: string): Promise<void> {
  using file = await Deno.open(path, { read: true });
  await file.sync();
}

async function syncDirectory(path: string): Promise<void> {
  using directory = await Deno.open(path, { read: true });
  await directory.sync();
}
