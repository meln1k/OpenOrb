import { dirname, join } from "node:path";
import { Schema } from "effect";
import { type Result, tryAsync } from "@openorb/result";

import {
  ensureGuestImage,
  type EnsureGuestImageOptions,
  type GuestImage,
  GuestImageError,
} from "./installer.ts";
import { GUEST_IMAGE_RELEASES, type GuestImageRelease } from "./release.ts";

const Runtime = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  releaseId: Schema.String,
  architecture: Schema.Literals(["x64", "arm64"]),
  manifestSha256: Schema.String,
}));

export interface SessionRuntimeOptions {
  readonly releases?: readonly GuestImageRelease[];
  readonly fetch?: EnsureGuestImageOptions["fetch"];
}

/** Publish the runtime before creating a disk. Never assign a runtime to an existing legacy disk. */
export async function initializeSessionRuntime(
  rootDiskPath: string,
  defaultImage: GuestImage,
): Promise<Result<void, GuestImageError>> {
  return await tryAsync(
    (async () => {
      const path = join(dirname(rootDiskPath), "runtime.json");
      if (await exists(path)) return;
      if (await exists(rootDiskPath)) {
        throw new GuestImageError(
          "Cannot assign a runtime to an existing session disk.",
          undefined,
        );
      }
      const candidate = `${path}.${crypto.randomUUID()}.candidate`;
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => Deno.remove(candidate));
      await Deno.writeTextFile(
        candidate,
        JSON.stringify({
          version: 1,
          releaseId: defaultImage.releaseId,
          architecture: defaultImage.architecture,
          manifestSha256: defaultImage.manifestSha256,
        }),
        { mode: 0o600, createNew: true },
      );
      using file = await Deno.open(candidate, { read: true });
      await file.sync();
      const [, publishError] = await tryAsync(Deno.link(candidate, path), (cause) => cause);
      if (publishError !== undefined) {
        if (publishError instanceof Deno.errors.AlreadyExists) return;
        throw publishError;
      }
      using directory = await Deno.open(dirname(path), { read: true });
      await directory.sync();
    })(),
    (cause) => new GuestImageError("The session runtime could not be recorded.", cause),
  );
}

/** Resolve only trusted releases, never URLs or filesystem paths supplied by session metadata. */
export async function readSessionGuestImage(
  rootDiskPath: string,
  defaultImage: GuestImage,
  options: SessionRuntimeOptions = {},
): Promise<Result<GuestImage, GuestImageError>> {
  return await tryAsync(
    (async () => {
      const path = join(dirname(rootDiskPath), "runtime.json");
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink) {
        throw new GuestImageError("The session runtime must be a regular file.", undefined);
      }
      const runtime = Schema.decodeUnknownSync(Runtime)(await Deno.readTextFile(path));
      if (runtime.architecture !== defaultImage.architecture) {
        throw new GuestImageError(
          "The session runtime architecture does not match this runner.",
          undefined,
        );
      }
      if (
        runtime.releaseId === defaultImage.releaseId &&
        runtime.manifestSha256 === defaultImage.manifestSha256
      ) return defaultImage;
      const release = (options.releases ?? GUEST_IMAGE_RELEASES).find((entry) =>
        entry.id === runtime.releaseId &&
        entry.assets[runtime.architecture].manifestSha256 === runtime.manifestSha256
      );
      if (!release) {
        throw new GuestImageError(`Unsupported session runtime: ${runtime.releaseId}.`, undefined);
      }
      // Installed images always live at <workingDirectory>/images/<release>/<architecture>.
      const [image, error] = await ensureGuestImage({
        workingDirectory: dirname(dirname(dirname(defaultImage.path))),
        architecture: runtime.architecture,
        release,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (error !== undefined) throw error;
      return image;
    })(),
    (cause) => new GuestImageError("The session's pinned guest image is unavailable.", cause),
  );
}

async function exists(path: string): Promise<boolean> {
  const [, error] = await tryAsync(Deno.lstat(path), (cause) => cause);
  if (error !== undefined) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  return true;
}
