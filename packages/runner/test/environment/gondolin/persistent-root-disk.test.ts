import { test } from "vite-plus/test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { hasErrorCode } from "../../../src/runtime/errors.ts";
import { assert, assertEquals, assertStringIncludes } from "@jsr/std__assert";
import { join } from "node:path";

import {
  assertPersistentRootDiskDetached,
  initializePersistentRootDisk,
  OPENORB_ROOT_DISK_SIZE,
  validatePersistentRootDisk,
} from "../../../src/environment/gondolin/persistent-root-disk.ts";

test("persistent root disks have 40 GiB virtual capacity", () => {
  assertEquals(OPENORB_ROOT_DISK_SIZE, "40G");
});

test("attachment validation never creates a missing persistent root disk", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const [, validationError] = await validatePersistentRootDisk(rootDiskPath);

    assert(validationError);
    assert(hasErrorCode(validationError.cause, "ENOENT"));
    await fs.lstat(rootDiskPath).then(
      () => assert(false, "attachment validation created the missing disk"),
      (cause) => assert(hasErrorCode(cause, "ENOENT")),
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("atomically publishes a private root overlay and preserves it on repeated startup", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "rootfs.ext4");
    await fs.writeFile(backingPath, "backing");
    let creations = 0;
    const createOverlay = async (candidatePath: string) => {
      creations++;
      await fs.writeFile(candidatePath, `overlay-${creations}`);
    };

    const [, creationError] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay,
    });
    assertEquals(creationError, undefined);
    assertEquals(await fs.readFile(rootDiskPath, "utf8"), "overlay-1");
    const info = await fs.lstat(rootDiskPath);
    assert(info.isFile() && !info.isSymbolicLink());
    assertEquals((info.mode ?? 0) & 0o777, 0o600);

    await fs.chmod(rootDiskPath, 0o644);
    const [, repeatedError] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay,
      inspectImage: (path) => {
        assertEquals(path, rootDiskPath);
        return Promise.resolve(
          JSON.stringify({
            format: "qcow2",
            "backing-filename": backingPath,
            "backing-filename-format": "raw",
          }),
        );
      },
    });
    assertEquals(repeatedError, undefined);
    assertEquals(creations, 1);
    assertEquals(await fs.readFile(rootDiskPath, "utf8"), "overlay-1");
    const reopenedInfo = await fs.lstat(rootDiskPath);
    assertEquals(reopenedInfo.ino, info.ino);
    assertEquals((reopenedInfo.mode ?? 0) & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("removes stale unpublished root overlays before creating a replacement", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "rootfs.ext4");
    const stalePath = `${rootDiskPath}.candidate-stale`;
    await fs.writeFile(backingPath, "backing");
    await fs.writeFile(stalePath, "stale");

    const [, error] = await initializePersistentRootDisk({
      path: rootDiskPath,
      backingPath,
      backingFormat: "raw",
      createOverlay: (candidatePath) => fs.writeFile(candidatePath, "replacement"),
    });

    assertEquals(error, undefined);
    assertEquals(await fs.readFile(rootDiskPath, "utf8"), "replacement");
    await fs.lstat(stalePath).then(
      () => assert(false, "stale candidate still exists"),
      (cause) => assert(hasErrorCode(cause, "ENOENT")),
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("rejects unsafe persistent root disk paths", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const backingPath = join(directory, "rootfs.ext4");
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await fs.writeFile(backingPath, "backing");
    await fs.symlink(backingPath, rootDiskPath);

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
    await fs.rm(directory, { recursive: true });
  }
});

test("backing validation rejects inconsistent metadata without changing existing disks", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const path = join(directory, "root-disk.qcow2");
    const backingPath = join(directory, "image-a.ext4");
    await fs.writeFile(path, "unchanged overlay", { mode: 0o644 });
    const before = await fs.stat(path);
    const valid = {
      format: "qcow2",
      "backing-filename": backingPath,
      "backing-filename-format": "raw",
    };
    for (const metadata of [
      { ...valid, "backing-filename": join(directory, "image-b.ext4") },
      { ...valid, "backing-filename": "image-a.ext4" },
      { ...valid, "backing-filename-format": "qcow2" },
      { ...valid, format: "raw" },
      { format: "qcow2" },
    ]) {
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
      assertEquals(await fs.readFile(path, "utf8"), "unchanged overlay");
      assertEquals((await fs.stat(path)).mode, before.mode);
      assertEquals((await fs.stat(path)).ino, before.ino);
    }
    const [, inspectionError] = await validatePersistentRootDisk(path, {
      backingPath,
      backingFormat: "raw",
      inspectImage: () => Promise.reject(new Error("inspection failed")),
    });
    assert(inspectionError);
    assertEquals(await fs.readFile(path, "utf8"), "unchanged overlay");
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test.skipIf(process.env.OPENORB_RUN_GONDOLIN_TESTS !== "1")(
  "real qcow2 backing validation accepts A and rejects a mismatched B runtime",
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
    try {
      const path = join(directory, "root-disk.qcow2");
      const imageA = join(directory, "image-a.ext4");
      const imageB = join(directory, "image-b.ext4");
      await fs.writeFile(imageA, new Uint8Array(4096).fill(1));
      await fs.writeFile(imageB, new Uint8Array(4096).fill(2));
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
      await fs.chmod(path, 0o644);
      const before = await fs.readFile(path);
      const beforeInfo = await fs.stat(path);
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
      assertEquals(await fs.readFile(path), before);
      assertEquals((await fs.stat(path)).mode, beforeInfo.mode);
      assertEquals((await fs.stat(path)).ino, beforeInfo.ino);
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  },
);

test("persistent root disk detachment waits for exclusive image access", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await fs.writeFile(rootDiskPath, "qcow2");
    let attempts = 0;

    const [, error] = await assertPersistentRootDiskDetached(rootDiskPath, {
      timeoutMs: 100,
      retryMs: 1,
      inspectImage: () => Promise.resolve(++attempts === 3),
    });

    assertEquals(error, undefined);
    assertEquals(attempts, 3);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("persistent root disk detachment fails closed while the image remains locked", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    const rootDiskPath = join(directory, "root-disk.qcow2");
    await fs.writeFile(rootDiskPath, "qcow2");

    const [, error] = await assertPersistentRootDiskDetached(rootDiskPath, {
      timeoutMs: 5,
      retryMs: 1,
      inspectImage: () => Promise.resolve(false),
    });

    assertEquals(error?.message, "The persistent root disk may still be attached to a VM.");
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
