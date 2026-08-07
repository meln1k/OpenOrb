import assert from "node:assert/strict";
import test from "node:test";

import { checkRunnerPrerequisites } from "../src/prerequisites.ts";

test("checks QEMU without starting a VM", async () => {
  let probes: Array<{ executable: string; args: string[] }> = [];
  let report = await checkRunnerPrerequisites({
    platform: "darwin",
    architecture: "arm64",
    nodeVersion: "24.3.0",
    probeExecutable(executable, args) {
      probes.push({ executable, args });
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(probes, [{ executable: "qemu-system-aarch64", args: ["--version"] }]);
  assert.equal(report.qemu?.version, "QEMU emulator version 10.0.0");
  assert.match(report.warnings[0] ?? "", /temporary macOS development harness/);
});

test("reports an actionable error when QEMU is missing", async () => {
  let report = await checkRunnerPrerequisites({
    platform: "darwin",
    architecture: "arm64",
    nodeVersion: "24.3.0",
    probeExecutable() {
      return Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" }));
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /brew install qemu/);
  assert.match(report.errors.join("\n"), /qemu-system-aarch64/);
});

test("reports the repository Node.js requirement", async () => {
  let report = await checkRunnerPrerequisites({
    platform: "linux",
    architecture: "x64",
    nodeVersion: "23.6.0",
    probeExecutable() {
      return Promise.resolve("QEMU emulator version 10.0.0\n");
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /Node\.js 24\.3\.0 or newer/);
});
