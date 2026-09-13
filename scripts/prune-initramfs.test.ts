import { assertEquals, assertRejects } from "@std/assert";

import {
  REQUIRED_INITRAMFS_MODULES,
  resolveRequiredModulePaths,
} from "@/scripts/prune-initramfs.ts";

Deno.test("resolveRequiredModulePaths retains boot modules and their dependency closure", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  try {
    const modules = new Map<string, readonly string[]>([
      ["kernel/net/packet/af_packet.ko.gz", []],
      ["kernel/drivers/block/virtio_blk.ko.gz", []],
      ["kernel/drivers/char/hw_random/rng-core.ko.gz", []],
      [
        "kernel/drivers/char/hw_random/virtio-rng.ko.gz",
        ["kernel/drivers/char/hw_random/rng-core.ko.gz"],
      ],
      ["kernel/drivers/net/net_failover.ko.gz", ["kernel/net/core/failover.ko.gz"]],
      [
        "kernel/drivers/net/virtio_net.ko.gz",
        ["kernel/drivers/net/net_failover.ko.gz", "kernel/net/core/failover.ko.gz"],
      ],
      ["kernel/fs/ext4/ext4.ko.gz", [
        "kernel/fs/jbd2/jbd2.ko.gz",
        "kernel/fs/mbcache.ko.gz",
        "kernel/lib/crc/crc16.ko.gz",
      ]],
      ["kernel/fs/fuse/fuse.ko.gz", []],
      ["kernel/fs/jbd2/jbd2.ko.gz", []],
      ["kernel/fs/mbcache.ko.gz", []],
      ["kernel/lib/crc/crc16.ko.gz", []],
      ["kernel/net/core/failover.ko.gz", []],
      ["kernel/unrelated/unnecessary.ko.gz", []],
    ]);
    for (const modulePath of modules.keys()) {
      const path = `${temporaryDirectory}/${modulePath}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, modulePath);
    }
    await Deno.writeTextFile(
      `${temporaryDirectory}/modules.dep`,
      [...modules].map(([modulePath, dependencies]) => `${modulePath}: ${dependencies.join(" ")}`)
        .join("\n"),
    );
    await Deno.writeTextFile(
      `${temporaryDirectory}/modules.builtin`,
      [
        "kernel/drivers/char/virtio_console.ko",
        "kernel/drivers/virtio/virtio_mmio.ko",
        "kernel/drivers/virtio/virtio_pci.ko",
        "",
      ].join("\n"),
    );

    assertEquals(
      [...await resolveRequiredModulePaths(temporaryDirectory)].sort(),
      [...modules.keys()].filter((path) => !path.includes("unnecessary")).sort(),
    );
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});

Deno.test("resolveRequiredModulePaths rejects a missing boot module", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${temporaryDirectory}/modules.dep`, "");
    await Deno.writeTextFile(`${temporaryDirectory}/modules.builtin`, "");
    await assertRejects(
      () => resolveRequiredModulePaths(temporaryDirectory, REQUIRED_INITRAMFS_MODULES),
      Error,
      'Required kernel module "af_packet" was not found',
    );
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});
