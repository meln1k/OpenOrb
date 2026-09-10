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
