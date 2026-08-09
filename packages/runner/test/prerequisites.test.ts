import { assertEquals, assertMatch } from "@std/assert";

import { checkRunnerPrerequisites } from "../src/prerequisites.ts";

Deno.test("checks QEMU without starting a VM", async () => {
  const probes: Array<{ executable: string; args: string[] }> = [];
  const report = await checkRunnerPrerequisites({
    platform: "darwin",
    architecture: "arm64",
    denoVersion: "2.9.5",
    probeExecutable(executable, args) {
      probes.push({ executable, args });
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  });

  assertEquals(report.ok, true);
  assertEquals(probes, [{ executable: "qemu-system-aarch64", args: ["--version"] }]);
  assertEquals(report.qemu?.version, "QEMU emulator version 10.0.0");
  assertMatch(report.warnings[0] ?? "", /temporary macOS development harness/);
});

Deno.test("reports an actionable error when QEMU is missing", async () => {
  const report = await checkRunnerPrerequisites({
    platform: "darwin",
    architecture: "arm64",
    denoVersion: "2.9.5",
    probeExecutable() {
      return Promise.reject(new Deno.errors.NotFound("not found"));
    },
  });

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /brew install qemu/);
  assertMatch(report.errors.join("\n"), /qemu-system-aarch64/);
});

Deno.test("requires the pinned Deno release", async () => {
  const report = await checkRunnerPrerequisites({
    platform: "linux",
    architecture: "x64",
    denoVersion: "2.9.4",
    libc: "glibc",
    probeExecutable() {
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  });

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /Deno 2\.9\.5 exactly/);
});

Deno.test("rejects musl Linux hosts with an actionable error", async () => {
  const report = await checkRunnerPrerequisites({
    platform: "linux",
    architecture: "x86_64",
    denoVersion: "2.9.5",
    libc: "musl",
    probeExecutable() {
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  });

  assertEquals(report.ok, false);
  assertMatch(report.errors.join("\n"), /musl/);
  assertMatch(report.errors.join("\n"), /glibc/);
});
