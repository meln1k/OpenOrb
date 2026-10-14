import { readFile } from "node:fs/promises";
import { test, expect } from "vite-plus/test";

test("systemd confines runner writes, privileges and devices while allowing optional KVM", async () => {
  const unit = await readFile(
    new URL("../../systemd/openorb-runner.service", import.meta.url),
    "utf8",
  );
  for (const setting of [
    "User=openorb-runner",
    "Group=openorb-runner",
    "WorkingDirectory=/var/lib/openorb-runner",
    "StateDirectoryMode=0700",
    "UMask=0077",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ReadWritePaths=/var/lib/openorb-runner",
    "ProtectHome=true",
    "PrivateTmp=true",
    "DevicePolicy=closed",
    "DeviceAllow=/dev/kvm rw",
    "CapabilityBoundingSet=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ])
    expect(unit.split("\n")).toContain(setting);
  expect(unit).not.toMatch(/ConditionPathExists=\/dev\/kvm|enrollment-token|OPENORB.*TOKEN/);
  expect(unit).not.toMatch(/vm-cpu-count|vm-memory-mib|max-concurrent-sessions/);
  expect(unit).toContain("ExecStart=/usr/local/bin/openorb-runner");
});

for (const architecture of ["x64", "arm64"]) {
  test(`source ${architecture} override inherits OS isolation and runs Node directly`, async () => {
    const override = await readFile(
      new URL(`../../systemd/openorb-runner-source-${architecture}.conf`, import.meta.url),
      "utf8",
    );
    expect(override.split("\n")).toContain("ExecStart=");
    expect(override).toContain(
      "ExecStart=/usr/local/bin/node /opt/openorb/packages/runner/src/standalone.ts",
    );
    expect(override).not.toMatch(
      /deno|--allow-|enrollment-token|OPENORB.*TOKEN|ProtectSystem=false/,
    );
  });
}
