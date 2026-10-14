import { createHash } from "node:crypto";
import { join } from "node:path";

import { test } from "vite-plus/test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { hasErrorCode } from "../../../src/runtime/errors.ts";
import { assertEquals, assertMatch, assertRejects } from "@jsr/std__assert";
import { TarStream, type TarStreamInput } from "@jsr/std__tar";
import type { Result } from "@openorb/result";

import {
  currentGuestImageArchitecture,
  ensureGuestImage,
  prepareGuestImageForVm,
} from "../../../src/environment/gondolin/guest-image/installer.ts";
import type { GuestImageRelease } from "../../../src/environment/gondolin/guest-image/release.ts";
import {
  initializeSessionRuntime,
  readSessionGuestImage,
} from "../../../src/environment/gondolin/guest-image/session-runtime.ts";

const BUILD_ID = "0cc0ad9d-c995-58cb-8382-a9037aa2d4cc";
const ASSET_CONTENTS = {
  "vmlinuz-virt": new TextEncoder().encode("kernel"),
  "initramfs.cpio.lz4": new TextEncoder().encode("initramfs"),
  "rootfs.ext4": new TextEncoder().encode("rootfs"),
  "krun-kernel": new TextEncoder().encode("krun-kernel"),
  "krun-empty-initrd": new Uint8Array(),
} as const;

test("installs and reuses a verified guest image atomically", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  let downloads = 0;
  const fetchImage = () => {
    downloads++;
    return Promise.resolve(responseFor(fixture.archive));
  };

  try {
    const first = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: fetchImage,
      }),
    );
    const second = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: fetchImage,
      }),
    );

    assertEquals(downloads, 1);
    assertEquals(first.path, join(workingDirectory, "images", "test-1", "x64"));
    assertEquals(second, first);
    assertEquals(first.gondolinBuildId, BUILD_ID);
    assertEquals(
      (await fs.readdir(join(workingDirectory, "images", "test-1"), { withFileTypes: true })).map(
        (entry) => entry.name,
      ),
      ["x64"],
    );
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

for (const { name, response } of [
  {
    name: "wrong declared size",
    response: (archive: Uint8Array) =>
      responseFor(archive, { "content-length": String(archive.byteLength + 1) }),
  },
  {
    name: "truncated body",
    response: (archive: Uint8Array) => responseFor(archive.subarray(0, archive.byteLength - 1)),
  },
  {
    name: "corrupt body",
    response: (archive: Uint8Array) => {
      const corrupt = archive.slice();
      const lastIndex = corrupt.byteLength - 1;
      corrupt[lastIndex] = (corrupt[lastIndex] ?? 0) ^ 0xff;
      return responseFor(corrupt);
    },
  },
]) {
  test(`rejects an image archive with ${name} without a partial install`, async () => {
    const fixture = await createImageFixture();
    const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
    try {
      const error = failure(
        await ensureGuestImage({
          workingDirectory,
          architecture: "x64",
          release: fixture.release,
          fetch: () => Promise.resolve(response(fixture.archive)),
        }),
      );
      assertMatch(
        error.message,
        new RegExp(
          name === "wrong declared size"
            ? "download size header"
            : name === "truncated body"
              ? "downloaded"
              : "download SHA-256",
        ),
      );
      assertEquals(await releaseDirectoryEntries(workingDirectory), []);
    } finally {
      await fs.rm(workingDirectory, { recursive: true });
    }
  });
}

test("reports an unavailable image download without a partial install", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const error = failure(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      }),
    );
    assertMatch(error.message, /download failed with HTTP 404/);
    assertMatch(error.message, /https:\/\/example\.test\/guest-image\.tar\.gz/);
    assertEquals(await releaseDirectoryEntries(workingDirectory), []);
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

for (const hostileEntry of [
  fileEntry("../escape", new TextEncoder().encode("escape")),
  fileEntry("/absolute-escape", new TextEncoder().encode("escape")),
  fileEntry("unexpected", new TextEncoder().encode("unexpected")),
  {
    type: "symlink" as const,
    path: "rootfs.ext4",
    linkname: "/etc/passwd",
  },
]) {
  test(`rejects hostile archive entry ${hostileEntry.path}`, async () => {
    const omit = hostileEntry.path === "rootfs.ext4" ? "rootfs.ext4" : undefined;
    const fixture = await createImageFixture({ extraEntries: [hostileEntry], omit });
    const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
    try {
      const error = failure(
        await ensureGuestImage({
          workingDirectory,
          architecture: "x64",
          release: fixture.release,
          fetch: () => Promise.resolve(responseFor(fixture.archive)),
        }),
      );
      assertMatch(error.message, /invalid entry/);
      assertEquals(await releaseDirectoryEntries(workingDirectory), []);
      if (hostileEntry.path === "../escape") {
        await assertRejects(
          () => fs.lstat(join(workingDirectory, "images", "test-1", "escape")),
          Error,
          "ENOENT",
        );
      }
    } finally {
      await fs.rm(workingDirectory, { recursive: true });
    }
  });
}

for (const { name, buildId, architecture, expected } of [
  {
    name: "wrong Gondolin build ID",
    buildId: "f4e0ee3a-4bb8-5233-89bf-0fd54a5e4efa",
    architecture: "x86_64" as const,
    expected: "manifest identity is incompatible",
  },
  {
    name: "wrong guest architecture",
    buildId: BUILD_ID,
    architecture: "aarch64" as const,
    expected: "manifest identity is incompatible",
  },
]) {
  test(`rejects ${name} without a partial install`, async () => {
    const fixture = await createImageFixture({ buildId, architecture });
    const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
    try {
      const error = failure(
        await ensureGuestImage({
          workingDirectory,
          architecture: "x64",
          release: fixture.release,
          fetch: () => Promise.resolve(responseFor(fixture.archive)),
        }),
      );
      assertMatch(error.message, new RegExp(expected));
      assertEquals(await releaseDirectoryEntries(workingDirectory), []);
    } finally {
      await fs.rm(workingDirectory, { recursive: true });
    }
  });
}

test("fails clearly instead of replacing a corrupt cached image", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const image = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(responseFor(fixture.archive)),
      }),
    );
    await fs.writeFile(join(image.path, "rootfs.ext4"), "corrupt");

    const error = failure(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => {
          throw new Error("must not redownload over an existing image");
        },
      }),
    );
    assertMatch(error.message, /asset checksum does not match/);
    assertMatch(error.message, /Remove that image directory and restart the runner/);
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

test("rejects a changed asset even when its manifest checksum is rewritten", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const image = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(responseFor(fixture.archive)),
      }),
    );
    const changedRootfs = new TextEncoder().encode("changed rootfs");
    await fs.writeFile(join(image.path, "rootfs.ext4"), changedRootfs);
    const manifestPath = join(image.path, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.checksums.rootfs = sha256(changedRootfs);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const error = failure(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => {
          throw new Error("must not redownload over an existing image");
        },
      }),
    );
    assertMatch(error.message, /manifest\.json SHA-256 does not match release metadata/);
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

test("reverifies a guest image immediately before VM use", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const image = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(responseFor(fixture.archive)),
      }),
    );
    assertEquals(success(await prepareGuestImageForVm(image)), {
      kernelPath: join(image.path, "vmlinuz-virt"),
      initrdPath: join(image.path, "initramfs.cpio.lz4"),
      rootfsPath: join(image.path, "rootfs.ext4"),
    });

    await fs.writeFile(join(image.path, "vmlinuz-virt"), "changed kernel");
    const error = failure(await prepareGuestImageForVm(image));
    assertMatch(error.message, /asset checksum does not match manifest\.json/);
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

test("maps supported host architecture names", () => {
  assertEquals(currentGuestImageArchitecture("x86_64"), "x64");
  assertEquals(currentGuestImageArchitecture("amd64"), "x64");
  assertEquals(currentGuestImageArchitecture("aarch64"), "arm64");
  assertEquals(currentGuestImageArchitecture("arm64"), "arm64");
});

test("sessions retain their runtime across default image upgrades and recover missing assets", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  const newRelease = { ...fixture.release, id: "test-2" };
  const fetchImage = () => Promise.resolve(responseFor(fixture.archive));
  try {
    const oldImage = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: fetchImage,
      }),
    );
    const oldSession = join(workingDirectory, "old-session");
    await fs.mkdir(oldSession);
    const oldDisk = join(oldSession, "root-disk.qcow2");
    success(await initializeSessionRuntime(oldDisk, oldImage));
    await fs.writeFile(oldDisk, "preserved disk");
    const originalPin = await fs.readFile(join(oldSession, "runtime.json"), "utf8");
    assertEquals(JSON.parse(originalPin), {
      version: 1,
      releaseId: "test-1",
      architecture: "x64",
      manifestSha256: fixture.release.assets.x64.manifestSha256,
    });
    const newImage = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: newRelease,
        fetch: fetchImage,
      }),
    );
    success(await initializeSessionRuntime(oldDisk, newImage));
    const options = { releases: [fixture.release, newRelease], fetch: fetchImage };
    const restored = success(
      await readSessionGuestImage(oldDisk, newImage, {
        ...options,
        fetch: () => {
          throw new Error("Retained images must not be downloaded.");
        },
      }),
    );
    assertEquals(restored.path, oldImage.path);
    assertEquals(success(await prepareGuestImageForVm(restored)), {
      kernelPath: join(oldImage.path, "vmlinuz-virt"),
      initrdPath: join(oldImage.path, "initramfs.cpio.lz4"),
      rootfsPath: join(oldImage.path, "rootfs.ext4"),
    });
    const newSession = join(workingDirectory, "new-session");
    await fs.mkdir(newSession);
    const newDisk = join(newSession, "root-disk.qcow2");
    success(await initializeSessionRuntime(newDisk, newImage));
    assertEquals(success(await readSessionGuestImage(newDisk, newImage)).path, newImage.path);
    await fs.rm(oldImage.path, { recursive: true });
    assertEquals(
      success(await readSessionGuestImage(oldDisk, newImage, options)).path,
      oldImage.path,
    );
    assertEquals(await fs.readFile(oldDisk, "utf8"), "preserved disk");
    assertEquals(await fs.readFile(join(oldSession, "runtime.json"), "utf8"), originalPin);
    assertEquals((await fs.stat(join(oldSession, "runtime.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

test("missing or invalid session runtime never falls back to the default image", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const image = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(responseFor(fixture.archive)),
      }),
    );
    const disk = join(workingDirectory, "root-disk.qcow2");
    failure(await readSessionGuestImage(disk, image));
    await fs.writeFile(disk, "legacy disk");
    failure(await initializeSessionRuntime(disk, image));
    await assertRejects(
      () => fs.readFile(join(workingDirectory, "runtime.json"), "utf8"),
      Error,
      "ENOENT",
    );
    const pin = {
      version: 1,
      releaseId: image.releaseId,
      architecture: "x64",
      manifestSha256: image.manifestSha256,
    };
    for (const invalid of [
      "{broken",
      JSON.stringify({ ...pin, releaseId: "../../untrusted" }),
      JSON.stringify({ ...pin, architecture: "arm64" }),
      JSON.stringify({ ...pin, manifestSha256: "0".repeat(64) }),
      JSON.stringify({ ...pin, version: 2 }),
    ]) {
      await fs.writeFile(join(workingDirectory, "runtime.json"), invalid);
      failure(await readSessionGuestImage(disk, image));
      success(await initializeSessionRuntime(disk, image));
      assertEquals(await fs.readFile(join(workingDirectory, "runtime.json"), "utf8"), invalid);
      assertEquals(await fs.readFile(disk, "utf8"), "legacy disk");
    }
  } finally {
    await fs.rm(workingDirectory, { recursive: true });
  }
});

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  if (error !== undefined) throw error;
  // SAFETY: The Result success variant always contains T when the error slot is undefined.
  return value as T;
}

function failure<T, E>(result: Result<T, E>): E {
  const [, error] = result;
  if (error === undefined) throw new Error("Expected operation to fail.");
  return error;
}

interface ImageFixtureOptions {
  buildId?: string;
  architecture?: "aarch64" | "x86_64";
  extraEntries?: TarStreamInput[];
  omit?: keyof typeof ASSET_CONTENTS | undefined;
}

async function createImageFixture(options: ImageFixtureOptions = {}) {
  const buildId = options.buildId ?? BUILD_ID;
  const architecture = options.architecture ?? "x86_64";
  const checksums = {
    kernel: sha256(ASSET_CONTENTS["vmlinuz-virt"]),
    initramfs: sha256(ASSET_CONTENTS["initramfs.cpio.lz4"]),
    rootfs: sha256(ASSET_CONTENTS["rootfs.ext4"]),
    krunKernel: sha256(ASSET_CONTENTS["krun-kernel"]),
    krunInitrd: sha256(ASSET_CONTENTS["krun-empty-initrd"]),
  };
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      buildId,
      config: { arch: architecture },
      buildTime: "1970-01-01T00:00:00.000Z",
      assets: {
        kernel: "vmlinuz-virt",
        initramfs: "initramfs.cpio.lz4",
        rootfs: "rootfs.ext4",
        krunKernel: "krun-kernel",
        krunInitrd: "krun-empty-initrd",
      },
      checksums,
      runtimeDefaults: { rootfsMode: "cow" },
    }),
  );
  const manifestSha256 = sha256(manifest);
  const entries: TarStreamInput[] = [fileEntry("manifest.json", manifest)];
  for (const [path, contents] of Object.entries(ASSET_CONTENTS)) {
    if (path !== options.omit) entries.push(fileEntry(path, contents));
  }
  entries.push(...(options.extraEntries ?? []));
  const archive = await createArchive(entries);
  return {
    archive,
    release: releaseFor(archive, BUILD_ID, manifestSha256),
  };
}

async function createArchive(entries: TarStreamInput[]): Promise<Uint8Array> {
  const readable = new ReadableStream<TarStreamInput>({
    start(controller) {
      for (const entry of entries) controller.enqueue(entry);
      controller.close();
    },
  })
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

function fileEntry(path: string, contents: Uint8Array): TarStreamInput {
  return {
    type: "file",
    path,
    size: contents.byteLength,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(contents);
        controller.close();
      },
    }),
  };
}

function releaseFor(
  archive: Uint8Array,
  buildId: string,
  manifestSha256: string,
): GuestImageRelease {
  const asset = {
    gondolinArchitecture: "x86_64" as const,
    gondolinBuildId: buildId,
    manifestSha256,
    url: "https://example.test/guest-image.tar.gz",
    sizeBytes: archive.byteLength,
    sha256: sha256(archive),
  };
  return {
    id: "test-1",
    assets: {
      x64: asset,
      arm64: { ...asset, gondolinArchitecture: "aarch64" },
    },
  };
}

function responseFor(archive: Uint8Array, headers?: HeadersInit): Response {
  const body = new ArrayBuffer(archive.byteLength);
  new Uint8Array(body).set(archive);
  return new Response(body, {
    status: 200,
    ...(headers === undefined ? {} : { headers }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function releaseDirectoryEntries(workingDirectory: string): Promise<string[]> {
  const directory = join(workingDirectory, "images", "test-1");
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}
