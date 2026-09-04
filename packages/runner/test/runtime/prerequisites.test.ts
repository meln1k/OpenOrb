import { assert, assertEquals, assertMatch } from "@std/assert";

import {
  checkCheckpointCandidateCapacity,
  type CheckPrerequisitesOptions,
  checkRunnerPrerequisites,
} from "@/src/runtime/prerequisites.ts";

const GIB = 1024 * 1024 * 1024;

Deno.test("reports a passing Linux host and probes the complete QEMU suite", async () => {
  const probes: Array<{ executable: string; args: string[] }> = [];
  let kvmExecutable = "";
  const report = await checkRunnerPrerequisites(linuxHost({
    gatewayUrl: "https://openorb.example.com",
    probeExecutable(executable, args) {
      probes.push({ executable, args });
      return Promise.resolve(`${executable} version 10.0.0\n`);
    },
    probeKvm(executable) {
      kvmExecutable = executable;
      return Promise.resolve();
    },
  }));

  assertEquals(report.ok, true);
  assertEquals(probes, [
    { executable: "qemu-system-x86_64", args: ["--version"] },
    { executable: "qemu-img", args: ["--version"] },
  ]);
  assertEquals(kvmExecutable, "qemu-system-x86_64");
  assertEquals(report.kernelRelease, "6.1.0");
  assertEquals(report.libc, "glibc");
  assertEquals(report.glibcVersion, "2.38");
  assertEquals(report.kvm, { device: "/dev/kvm", accessible: true });
  assertEquals(report.resources, {
    cpuCount: 8,
    memoryTotalMiB: 16 * 1024,
    memoryAvailableMiB: 8 * 1024,
    diskFreeMiB: 20 * 1024,
  });
  assertEquals(report.dataDirectory, { path: "/runner", writable: true });
  assertEquals(report.gateway, {
    url: "https://openorb.example.com",
    healthUrl: "https://openorb.example.com/healthz",
    status: 200,
  });
});

Deno.test("checks QEMU without KVM on the temporary macOS harness", async () => {
  const probes: Array<{ executable: string; args: string[] }> = [];
  const report = await checkRunnerPrerequisites(linuxHost({
    platform: "darwin",
    architecture: "arm64",
    libc: undefined,
    glibcVersion: undefined,
    probeExecutable(executable, args) {
      probes.push({ executable, args });
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  }));

  assertEquals(report.ok, true);
  assertEquals(probes, [
    { executable: "qemu-system-aarch64", args: ["--version"] },
    { executable: "qemu-img", args: ["--version"] },
  ]);
  assertEquals(report.kvm, undefined);
  assertMatch(report.warnings[0] ?? "", /temporary macOS development harness/);
});

Deno.test("reports actionable QEMU and KVM errors", async () => {
  const report = await checkRunnerPrerequisites(linuxHost({
    probeExecutable(executable) {
      return executable === "qemu-system-x86_64"
        ? Promise.reject(new Deno.errors.NotFound("not found"))
        : Promise.resolve("qemu-img version 10.0.0\n");
    },
    probeKvm: () => Promise.reject(new Deno.errors.PermissionDenied("permission denied")),
  }));

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /apt install qemu-system-x86/);
  assertMatch(report.errors.join("\n"), /\/dev\/kvm/);
  assertMatch(report.errors.join("\n"), /kvm group/);
});

Deno.test("requires the pinned Deno release and glibc baseline", async () => {
  const report = await checkRunnerPrerequisites(linuxHost({
    denoVersion: "2.9.4",
    glibcVersion: "2.26",
  }));

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /Deno 2\.9\.5 exactly/);
  assertMatch(report.errors.join("\n"), /Unsupported glibc 2\.26/);
  assertMatch(report.errors.join("\n"), /2\.27 or newer/);
});

Deno.test({
  name: "reports the glibc version provided by the host library",
  ignore: Deno.build.os !== "linux" || Deno.build.env !== "gnu",
  async fn() {
    const glibc = Deno.dlopen("libc.so.6", {
      gnu_get_libc_version: { parameters: [], result: "pointer" },
    });
    try {
      const pointer = glibc.symbols.gnu_get_libc_version();
      assert(pointer);
      const hostVersion = new Deno.UnsafePointerView(pointer).getCString();
      const report = await checkRunnerPrerequisites(linuxHost({
        libc: undefined,
        glibcVersion: undefined,
      }));

      assertEquals(report.libc, "glibc");
      assertEquals(report.glibcVersion, hostVersion);
    } finally {
      glibc.close();
    }
  },
});

Deno.test("rejects musl Linux hosts with an actionable error", async () => {
  const report = await checkRunnerPrerequisites(linuxHost({
    architecture: "aarch64",
    libc: "musl",
    glibcVersion: undefined,
  }));

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /musl/);
  assertMatch(report.errors.join("\n"), /glibc/);
  assertMatch(report.errors.join("\n"), /Alpine Linux is not supported/);
});

Deno.test("checks host resources, data-directory writes, and gateway health", async () => {
  const report = await checkRunnerPrerequisites(linuxHost({
    gatewayUrl: "https://wrong.example.com",
    getHardwareConcurrency: () => 0,
    getSystemMemoryInfo: () => ({ total: GIB, available: GIB / 2 }),
    probeDataDirectory: () => Promise.reject(new Deno.errors.PermissionDenied("read only")),
    fetch: () => Promise.resolve(Response.json({ service: "other", status: "ok" })),
  }));

  assertEquals(report.ok, false);
  assertEquals(report.dataDirectory.writable, false);
  assertMatch(report.errors.join("\n"), /No usable host CPU/);
  assertMatch(report.errors.join("\n"), /smallest OpenOrb VM requires 2048 MiB/);
  assertMatch(report.errors.join("\n"), /owned by the runner service user with mode 0700/);
  assertMatch(report.errors.join("\n"), /gateway.*unreachable or unhealthy/i);
});

Deno.test("requires free space for a full checkpoint candidate", async () => {
  const passing = await checkCheckpointCandidateCapacity({
    workingDirectory: "/runner",
    rootfsPath: "/runner/images/mvp-5/x64/rootfs.ext4",
    inspectFile: () => Promise.resolve({ size: 2560 * 1024 * 1024, isFile: true }),
    getFileSystemStats: () => Promise.resolve({ bavail: 4096n, bsize: 1024n * 1024n }),
  });
  assertEquals(passing, {
    ok: true,
    diskFreeMiB: 4096,
    candidateSizeMiB: 2560,
    errors: [],
  });

  const failing = await checkCheckpointCandidateCapacity({
    workingDirectory: "/runner",
    rootfsPath: "/runner/images/mvp-5/x64/rootfs.ext4",
    inspectFile: () => Promise.resolve({ size: 2560 * 1024 * 1024, isFile: true }),
    getFileSystemStats: () => Promise.resolve({ bavail: 2048n, bsize: 1024n * 1024n }),
  });
  assertEquals(failing.ok, false);
  assertMatch(failing.errors.join("\n"), /2048 MiB free/);
  assertMatch(failing.errors.join("\n"), /may require 2560 MiB/);
});

function linuxHost(overrides: CheckPrerequisitesOptions = {}): CheckPrerequisitesOptions {
  return {
    platform: "linux",
    architecture: "x86_64",
    kernelRelease: "6.1.0",
    denoVersion: "2.9.5",
    libc: "glibc",
    glibcVersion: "2.38",
    workingDirectory: "/runner",
    probeExecutable: (executable) => Promise.resolve(`${executable} version 10.0.0\n`),
    probeKvm: () => Promise.resolve(),
    probeDataDirectory: () => Promise.resolve(),
    getHardwareConcurrency: () => 8,
    getSystemMemoryInfo: () => ({ total: 16 * GIB, available: 8 * GIB }),
    getFileSystemStats: () => Promise.resolve({ bavail: 20n * 1024n, bsize: 1024n * 1024n }),
    fetch: () => Promise.resolve(Response.json({ service: "openorb-gateway", status: "ok" })),
    ...overrides,
  };
}
