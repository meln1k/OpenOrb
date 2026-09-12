import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";

import {
  assertPersistentRootDiskDetached,
  initializePersistentRootDisk,
  OPENORB_ROOT_DISK_SIZE,
  validatePersistentRootDisk,
} from "@/src/environment/gondolin/persistent-root-disk.ts";

Deno.test("persistent root disks have 40 GiB virtual capacity", () => {
  assertEquals(OPENORB_ROOT_DISK_SIZE, "40G");
});

Deno.test("attachment validation never creates a missing persistent root disk", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const [, validationError] = await validatePersistentRootDisk(rootDiskPath);

    assert(validationError);
    assert(validationError.cause instanceof Deno.errors.NotFound);
    await Deno.lstat(rootDiskPath).then(
      () => assert(false, "attachment validation created the missing disk"),
      (cause) => assert(cause instanceof Deno.errors.NotFound),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("atomically publishes a private root overlay and preserves it on repeated startup", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "rootfs.ext4");
    await Deno.writeTextFile(backingPath, "backing");
    let creations = 0;
    const createOverlay = async (candidatePath: string) => {
      creations++;
      await Deno.writeTextFile(candidatePath, `overlay-${creations}`);
    };

    const [, creationError] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay,
    });
    assertEquals(creationError, undefined);
    assertEquals(await Deno.readTextFile(rootDiskPath), "overlay-1");
    const info = await Deno.lstat(rootDiskPath);
    assert(info.isFile && !info.isSymlink);
    assertEquals((info.mode ?? 0) & 0o777, 0o600);

    await Deno.chmod(rootDiskPath, 0o644);
    const [, repeatedError] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay,
      inspectImage: (path) => {
        assertEquals(path, rootDiskPath);
        return Promise.resolve(JSON.stringify({
          format: "qcow2",
          "backing-filename": backingPath,
          "backing-filename-format": "raw",
        }));
      },
    });
    assertEquals(repeatedError, undefined);
    assertEquals(creations, 1);
    assertEquals(await Deno.readTextFile(rootDiskPath), "overlay-1");
    const reopenedInfo = await Deno.lstat(rootDiskPath);
    assertEquals(reopenedInfo.ino, info.ino);
    assertEquals((reopenedInfo.mode ?? 0) & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("removes stale unpublished root overlays before creating a replacement", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "rootfs.ext4");
    const stalePath = `${rootDiskPath}.candidate-stale`;
    await Deno.writeTextFile(backingPath, "backing");
    await Deno.writeTextFile(stalePath, "stale");

    const [, error] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay: (candidatePath) => Deno.writeTextFile(candidatePath, "replacement"),
    });

    assertEquals(error, undefined);
    assertEquals(await Deno.readTextFile(rootDiskPath), "replacement");
    await Deno.lstat(stalePath).then(
      () => assert(false, "stale candidate still exists"),
      (cause) => assert(cause instanceof Deno.errors.NotFound),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("rejects unsafe persistent root disk paths", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const backingPath = join(directory, "rootfs.ext4");
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await Deno.writeTextFile(backingPath, "backing");
    await Deno.symlink(backingPath, rootDiskPath);

    const [, symlinkError] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
    });
    assert(symlinkError);
    assertStringIncludes(symlinkError.message, "regular file");

    const [, relativeError] = await initializePersistentRootDisk({
      path: "root-disk.qcow2",
      backingPath,
      backingFormat: "raw",
    });
    assert(relativeError);
    assertStringIncludes(relativeError.message, "absolute");

    const [, backingError] = await initializePersistentRootDisk({
      path: backingPath,
      backingPath,
      backingFormat: "raw",
    });
    assert(backingError);
    assertStringIncludes(backingError.message, "backing image");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("backing validation rejects inconsistent metadata without changing existing disks", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "image-a.ext4");
    await Deno.writeTextFile(path, "unchanged overlay", { mode: 0o644 });
    const before = await Deno.stat(path);
    const valid = {
      format: "qcow2",
      "backing-filename": backingPath,
      "backing-filename-format": "raw",
    };
    for (
      const metadata of [
        { ...valid, "backing-filename": join(directory, "image-b.ext4") },
        { ...valid, "backing-filename": "image-a.ext4" },
        { ...valid, "backing-filename-format": "qcow2" },
        { ...valid, format: "raw" },
        { format: "qcow2" },
      ]
    ) {
      const options = {
        path,
        backingPath,
        backingFormat: "raw" as const,
        inspectImage: () => Promise.resolve(JSON.stringify(metadata)),
      };
      const [, validationError] = await validatePersistentRootDisk(path, options);
      assertStringIncludes(validationError?.message ?? "", "does not match");
      const [, initializationError] = await initializePersistentRootDisk(options);
      assertStringIncludes(initializationError?.message ?? "", "does not match");
      assertEquals(await Deno.readTextFile(path), "unchanged overlay");
      assertEquals((await Deno.stat(path)).mode, before.mode);
      assertEquals((await Deno.stat(path)).ino, before.ino);
    }
    const [, inspectionError] = await validatePersistentRootDisk(path, {
      backingPath,
      backingFormat: "raw",
      inspectImage: () => Promise.reject(new Error("inspection failed")),
    });
    assert(inspectionError);
    assertEquals(await Deno.readTextFile(path), "unchanged overlay");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "real qcow2 backing validation accepts A and rejects a mismatched B runtime",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const directory = await Deno.makeTempDir();
    try {
      const path = join(directory, "root-disk.qcow2");
      const imageA = join(directory, "image-a.ext4");
      const imageB = join(directory, "image-b.ext4");
      await Deno.writeFile(imageA, new Uint8Array(4096).fill(1));
      await Deno.writeFile(imageB, new Uint8Array(4096).fill(2));
      const [, creationError] = await initializePersistentRootDisk({
        path,
        backingPath: imageA,
        backingFormat: "raw",
      });
      assertEquals(creationError, undefined);
      const [, matchingError] = await validatePersistentRootDisk(path, {
        backingPath: imageA,
        backingFormat: "raw",
      });
      assertEquals(matchingError, undefined);
      const [, retryError] = await initializePersistentRootDisk({
        path,
        backingPath: imageA,
        backingFormat: "raw",
      });
      assertEquals(retryError, undefined);
      await Deno.chmod(path, 0o644);
      const before = await Deno.readFile(path);
      const beforeInfo = await Deno.stat(path);
      const [, mismatchError] = await validatePersistentRootDisk(path, {
        backingPath: imageB,
        backingFormat: "raw",
      });
      assertStringIncludes(mismatchError?.message ?? "", "does not match");
      const [, initializationError] = await initializePersistentRootDisk({
        path,
        backingPath: imageB,
        backingFormat: "raw",
      });
      assertStringIncludes(initializationError?.message ?? "", "does not match");
      assertEquals(await Deno.readFile(path), before);
      assertEquals((await Deno.stat(path)).mode, beforeInfo.mode);
      assertEquals((await Deno.stat(path)).ino, beforeInfo.ino);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test("persistent root disk detachment waits for exclusive image access", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await Deno.writeTextFile(rootDiskPath, "qcow2");
    let attempts = 0;

    const [, error] = await assertPersistentRootDiskDetached(rootDiskPath, {
      timeoutMs: 100,
      retryMs: 1,
      inspectImage: () => Promise.resolve(++attempts === 3),
    });

    assertEquals(error, undefined);
    assertEquals(attempts, 3);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent root disk detachment fails closed while the image remains locked", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await Deno.writeTextFile(rootDiskPath, "qcow2");

    const [, error] = await assertPersistentRootDiskDetached(rootDiskPath, {
      timeoutMs: 5,
      retryMs: 1,
      inspectImage: () => Promise.resolve(false),
    });

    assertEquals(error?.message, "The persistent root disk may still be attached to a VM.");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
