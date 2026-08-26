import { createHash } from "node:crypto";
import { join } from "node:path";

import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { TarStream, type TarStreamInput } from "@std/tar";
import type { Result } from "@openorb/result";

import {
  currentGuestImageArchitecture,
  ensureGuestImage,
  prepareGuestImageForVm,
} from "@/src/environment/gondolin/guest-image/installer.ts";
import type { GuestImageRelease } from "@/src/environment/gondolin/guest-image/release.ts";

const BUILD_ID = "0cc0ad9d-c995-58cb-8382-a9037aa2d4cc";
const ASSET_CONTENTS = {
  "vmlinuz-virt": new TextEncoder().encode("kernel"),
  "initramfs.cpio.lz4": new TextEncoder().encode("initramfs"),
  "rootfs.ext4": new TextEncoder().encode("rootfs"),
  "krun-kernel": new TextEncoder().encode("krun-kernel"),
  "krun-empty-initrd": new Uint8Array(),
} as const;

Deno.test("installs and reuses a verified guest image atomically", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await Deno.makeTempDir();
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
      (await Array.fromAsync(Deno.readDir(join(workingDirectory, "images", "test-1"))))
        .map((entry) => entry.name),
      ["x64"],
    );
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

for (
  const { name, response } of [
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
  ]
) {
  Deno.test(`rejects an image archive with ${name} without a partial install`, async () => {
    const fixture = await createImageFixture();
    const workingDirectory = await Deno.makeTempDir();
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
      await Deno.remove(workingDirectory, { recursive: true });
    }
  });
}

Deno.test("reports an unavailable image download without a partial install", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await Deno.makeTempDir();
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
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

for (
  const hostileEntry of [
    fileEntry("../escape", new TextEncoder().encode("escape")),
    fileEntry("/absolute-escape", new TextEncoder().encode("escape")),
    fileEntry("unexpected", new TextEncoder().encode("unexpected")),
    {
      type: "symlink" as const,
      path: "rootfs.ext4",
      linkname: "/etc/passwd",
    },
  ]
) {
  Deno.test(`rejects hostile archive entry ${hostileEntry.path}`, async () => {
    const omit = hostileEntry.path === "rootfs.ext4" ? "rootfs.ext4" : undefined;
    const fixture = await createImageFixture({ extraEntries: [hostileEntry], omit });
    const workingDirectory = await Deno.makeTempDir();
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
          () => Deno.lstat(join(workingDirectory, "images", "test-1", "escape")),
          Deno.errors.NotFound,
        );
      }
    } finally {
      await Deno.remove(workingDirectory, { recursive: true });
    }
  });
}

for (
  const { name, buildId, architecture, expected } of [
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
  ]
) {
  Deno.test(`rejects ${name} without a partial install`, async () => {
    const fixture = await createImageFixture({ buildId, architecture });
    const workingDirectory = await Deno.makeTempDir();
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
      await Deno.remove(workingDirectory, { recursive: true });
    }
  });
}

Deno.test("fails clearly instead of replacing a corrupt cached image", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await Deno.makeTempDir();
  try {
    const image = success(
      await ensureGuestImage({
        workingDirectory,
        architecture: "x64",
        release: fixture.release,
        fetch: () => Promise.resolve(responseFor(fixture.archive)),
      }),
    );
    await Deno.writeTextFile(join(image.path, "rootfs.ext4"), "corrupt");

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
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("rejects a changed asset even when its manifest checksum is rewritten", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await Deno.makeTempDir();
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
    await Deno.writeFile(join(image.path, "rootfs.ext4"), changedRootfs);
    const manifestPath = join(image.path, "manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.checksums.rootfs = sha256(changedRootfs);
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

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
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("reverifies a guest image immediately before VM use", async () => {
  const fixture = await createImageFixture();
  const workingDirectory = await Deno.makeTempDir();
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

    await Deno.writeTextFile(join(image.path, "vmlinuz-virt"), "changed kernel");
    const error = failure(await prepareGuestImageForVm(image));
    assertMatch(error.message, /asset checksum does not match manifest\.json/);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("maps supported host architecture names", () => {
  assertEquals(currentGuestImageArchitecture("x86_64"), "x64");
  assertEquals(currentGuestImageArchitecture("amd64"), "x64");
  assertEquals(currentGuestImageArchitecture("aarch64"), "arm64");
  assertEquals(currentGuestImageArchitecture("arm64"), "arm64");
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
  const manifest = new TextEncoder().encode(JSON.stringify({
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
  }));
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
  const readable = ReadableStream.from(entries)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

function fileEntry(path: string, contents: Uint8Array): TarStreamInput {
  return {
    type: "file",
    path,
    size: contents.byteLength,
    readable: ReadableStream.from([contents]),
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
    return (await Array.fromAsync(Deno.readDir(directory))).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}
