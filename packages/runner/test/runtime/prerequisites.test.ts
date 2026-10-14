import { test } from "vite-plus/test";
import { assertEquals, assertMatch, assertNotMatch } from "@jsr/std__assert";

import {
  type CheckPrerequisitesOptions,
  checkRunnerPrerequisites,
} from "../../src/runtime/prerequisites.ts";

const GIB = 1024 * 1024 * 1024;

test("reports a passing Linux host and probes the complete QEMU suite", async () => {
  const probes: Array<{ executable: string; args: string[] }> = [];
  let kvmExecutable = "";
  const report = await checkRunnerPrerequisites(
    linuxHost({
      gatewayUrl: "https://openorb.example.com",
      probeExecutable(executable, args) {
        probes.push({ executable, args });
        return Promise.resolve(`${executable} version 10.0.0\n`);
      },
      probeKvm(executable) {
        kvmExecutable = executable;
        return Promise.resolve();
      },
    }),
  );

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

test("checks QEMU without KVM on the temporary macOS harness", async () => {
  const probes: Array<{ executable: string; args: string[] }> = [];
  const report = await checkRunnerPrerequisites(
    linuxHost({
      platform: "darwin",
      architecture: "arm64",
      libc: undefined,
      glibcVersion: undefined,
      probeExecutable(executable, args) {
        probes.push({ executable, args });
        return Promise.resolve("QEMU emulator version 10.0.0\n");
      },
    }),
  );

  assertEquals(report.ok, true);
  assertEquals(probes, [
    { executable: "qemu-system-aarch64", args: ["--version"] },
    { executable: "qemu-img", args: ["--version"] },
  ]);
  assertEquals(report.kvm, undefined);
  assertMatch(report.warnings[0] ?? "", /temporary macOS development harness/);
});

test("keeps missing QEMU fatal while reporting KVM fallback as a warning", async () => {
  const report = await checkRunnerPrerequisites(
    linuxHost({
      probeExecutable(executable) {
        return executable === "qemu-system-x86_64"
          ? Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" }))
          : Promise.resolve("qemu-img version 10.0.0\n");
      },
      probeKvm: () =>
        Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    }),
  );

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /apt install qemu-system-x86/);
  assertNotMatch(report.errors.join("\n"), /\/dev\/kvm/);
  assertMatch(report.warnings.join("\n"), /\/dev\/kvm/);
  assertMatch(report.warnings.join("\n"), /QEMU TCG software emulation/);
});

test("accepts Linux without KVM and warns that software emulation is slower", async () => {
  const report = await checkRunnerPrerequisites(
    linuxHost({
      probeKvm: () =>
        Promise.reject(Object.assign(new Error("missing /dev/kvm"), { code: "ENOENT" })),
    }),
  );

  assertEquals(report.ok, true);
  assertEquals(report.kvm, undefined);
  assertEquals(report.errors, []);
  assertMatch(report.warnings.join("\n"), /runner will use slower QEMU TCG software emulation/);
  assertMatch(report.warnings.join("\n"), /missing \/dev\/kvm/);
});

test("accepts stable Node releases at or above the minimum", async () => {
  for (const nodeVersion of ["26.11.1", "26.11.2", "26.12.0", "27.0.0"]) {
    const report = await checkRunnerPrerequisites(linuxHost({ nodeVersion }));
    assertEquals(report.ok, true, nodeVersion);
  }
});

test("rejects older, prerelease, and malformed Node versions", async () => {
  for (const nodeVersion of [
    "25.99.0",
    "26.10.99",
    "26.11.0",
    "26.11.1-rc.1",
    "26.12.0-rc.1",
    "",
    "26.11",
    "invalid",
  ]) {
    const report = await checkRunnerPrerequisites(linuxHost({ nodeVersion }));
    assertEquals(report.ok, false, nodeVersion);
    assertMatch(report.errors.join("\n"), /requires stable Node 26\.11\.1 or newer/);
  }
});

test("requires the minimum Node release and glibc baseline", async () => {
  const report = await checkRunnerPrerequisites(
    linuxHost({
      nodeVersion: "26.11.0",
      glibcVersion: "2.27",
    }),
  );

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /Node 26\.11\.1 or newer/);
  assertMatch(report.errors.join("\n"), /Unsupported glibc 2\.27/);
  assertMatch(report.errors.join("\n"), /2\.28 or newer/);
});

test.skipIf(process.platform !== "linux")(
  "reports the glibc version provided by Node's host report",
  async () => {
    const host = process.report.getReport();
    if (
      !("header" in host) ||
      // oxlint-disable-next-line openorb/no-runtime-typeof -- Validate the host diagnostic report before comparing its optional libc field.
      typeof host.header !== "object" ||
      host.header === null ||
      !("glibcVersionRuntime" in host.header)
    )
      return;
    const report = await checkRunnerPrerequisites(
      linuxHost({
        libc: undefined,
        glibcVersion: undefined,
      }),
    );
    assertEquals(report.libc, "glibc");
    assertEquals(report.glibcVersion, host.header.glibcVersionRuntime);
  },
);

test("rejects musl Linux hosts with an actionable error", async () => {
  const report = await checkRunnerPrerequisites(
    linuxHost({
      architecture: "aarch64",
      libc: "musl",
      glibcVersion: undefined,
    }),
  );

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /musl/);
  assertMatch(report.errors.join("\n"), /glibc/);
  assertMatch(report.errors.join("\n"), /Alpine Linux is not supported/);
});

test("checks host resources, data-directory writes, and gateway health", async () => {
  const report = await checkRunnerPrerequisites(
    linuxHost({
      gatewayUrl: "https://wrong.example.com",
      getHardwareConcurrency: () => 0,
      getSystemMemoryInfo: () => ({ total: GIB, available: GIB / 2 }),
      probeDataDirectory: () =>
        Promise.reject(Object.assign(new Error("read only"), { code: "EACCES" })),
      fetch: () => Promise.resolve(Response.json({ service: "other", status: "ok" })),
    }),
  );

  assertEquals(report.ok, false);
  assertEquals(report.dataDirectory.writable, false);
  assertMatch(report.errors.join("\n"), /No usable host CPU/);
  assertMatch(report.errors.join("\n"), /smallest OpenOrb VM requires 2048 MiB/);
  assertMatch(report.errors.join("\n"), /owned by the runner service user with mode 0700/);
  assertMatch(report.errors.join("\n"), /gateway.*unreachable or unhealthy/i);
});

function linuxHost(overrides: CheckPrerequisitesOptions = {}): CheckPrerequisitesOptions {
  return {
    platform: "linux",
    architecture: "x86_64",
    kernelRelease: "6.1.0",
    nodeVersion: "26.11.1",
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
