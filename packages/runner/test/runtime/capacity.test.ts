import { assertEquals, assertRejects } from "@std/assert";

import { createRunnerCapacityReporter } from "@/src/runtime/capacity.ts";

Deno.test("reports detected host capacity and current disk space without a session limit", async () => {
  let activeSessions = 2;
  let inspectedPath = "";
  const getCapacity = createRunnerCapacityReporter({
    path: "/var/lib/openorb-runner",
    getActiveSessions: () => activeSessions,
    getHardwareConcurrency: () => 12,
    getSystemMemoryInfo: () => ({ total: 24 * 1024 * 1024 * 1024 }),
    getFileSystemStats(path) {
      inspectedPath = path;
      return Promise.resolve({ bavail: 5_000_000n, bsize: 4096n });
    },
  });

  assertEquals(await getCapacity(), {
    activeSessions: 2,
    vmCpuCount: 12,
    vmMemoryMiB: 24 * 1024,
    diskFreeMiB: 19_531,
  });
  assertEquals(inspectedPath, "/var/lib/openorb-runner");

  activeSessions = 3;
  assertEquals((await getCapacity()).activeSessions, 3);
});

Deno.test("explicit runner VM capacity overrides host detection", async () => {
  const getCapacity = createRunnerCapacityReporter({
    path: "/runner",
    vmCpuCount: 2,
    vmMemoryMiB: 4096,
    getHardwareConcurrency: () => {
      throw new Error("CPU detection should not run");
    },
    getSystemMemoryInfo: () => {
      throw new Error("Memory detection should not run");
    },
    getFileSystemStats: () => Promise.resolve({ bavail: 1024n, bsize: 1024n }),
  });

  assertEquals(await getCapacity(), {
    activeSessions: 0,
    vmCpuCount: 2,
    vmMemoryMiB: 4096,
    diskFreeMiB: 1,
  });
});

Deno.test("rejects invalid runtime active-session counts", async () => {
  const getCapacity = createRunnerCapacityReporter({
    path: "/runner",
    vmCpuCount: 2,
    vmMemoryMiB: 4096,
    getActiveSessions: () => -1,
    getFileSystemStats: () => Promise.resolve({ bavail: 1024n, bsize: 1024n }),
  });

  await assertRejects(() => getCapacity(), Error, "Active session count");
});
