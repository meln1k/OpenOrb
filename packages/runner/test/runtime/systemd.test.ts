import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";

const unitUrl = new URL("../../systemd/openorb-runner.service", import.meta.url);
const sourceOverrides = [
  {
    architecture: "x64",
    url: new URL("../../systemd/openorb-runner-source-x64.conf", import.meta.url),
    qemu: "/usr/bin/qemu-system-x86_64,/usr/bin/qemu-img",
    otherQemu: "qemu-system-aarch64",
  },
  {
    architecture: "arm64",
    url: new URL("../../systemd/openorb-runner-source-arm64.conf", import.meta.url),
    qemu: "/usr/bin/qemu-system-aarch64,/usr/bin/qemu-img",
    otherQemu: "qemu-system-x86_64",
  },
] as const;

Deno.test("systemd unit isolates the runner while preserving KVM access", async () => {
  const unit = await Deno.readTextFile(unitUrl);

  assertMatch(unit, /^User=openorb-runner$/m);
  assertMatch(unit, /^Group=openorb-runner$/m);
  assertMatch(unit, /^SupplementaryGroups=kvm$/m);
  assertMatch(unit, /^WorkingDirectory=\/var\/lib\/openorb-runner$/m);
  assertMatch(unit, /^StateDirectory=openorb-runner$/m);
  assertMatch(unit, /^StateDirectoryMode=0700$/m);
  assertMatch(unit, /^UMask=0077$/m);
  assertMatch(unit, /^NoNewPrivileges=true$/m);
  assertMatch(unit, /^ProtectSystem=strict$/m);
  assertMatch(unit, /^ReadWritePaths=\/var\/lib\/openorb-runner$/m);
  assertMatch(unit, /^PrivateDevices=false$/m);
  assertMatch(unit, /^DevicePolicy=closed$/m);
  assertMatch(unit, /^DeviceAllow=\/dev\/kvm rw$/m);
  assertMatch(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assertMatch(unit, /^CapabilityBoundingSet=$/m);
});

Deno.test("systemd unit stores no enrollment secret and applies no resource ceiling", async () => {
  const unit = await Deno.readTextFile(unitUrl);
  const execStart = unit.match(/^ExecStart=(.+)$/m)?.[1];

  assertEquals(execStart, "/usr/local/bin/openorb-runner");
  assertNotMatch(unit, /enrollment-token|OPENORB.*TOKEN|--data-dir/);
  assertNotMatch(unit, /vm-cpu-count|vm-memory-mib|max-concurrent-sessions/);
});

for (const sourceOverride of sourceOverrides) {
  Deno.test(`source ${sourceOverride.architecture} override runs pinned Deno directly`, async () => {
    const override = await Deno.readTextFile(sourceOverride.url);
    const execStarts = [...override.matchAll(/^ExecStart=(.*)$/gm)].map((match) => match[1]);

    assertEquals(execStarts.length, 2);
    assertEquals(execStarts[0], "");
    assertMatch(execStarts[1] ?? "", /^\/usr\/local\/bin\/deno run /);
    assertMatch(execStarts[1] ?? "", /--cached-only --frozen/);
    assertMatch(execStarts[1] ?? "", /--config=\/opt\/openorb\/deno\.json/);
    assertMatch(execStarts[1] ?? "", /--lock=\/opt\/openorb\/deno\.lock/);
    assertMatch(
      execStarts[1] ?? "",
      /--allow-read=\/opt\/openorb,\/var\/cache\/openorb-runner\/deno,\/var\/lib\/openorb-runner,\/lib,\/lib64,\/usr\/lib,\/usr\/lib64/,
    );
    assertMatch(execStarts[1] ?? "", /--allow-write=\/var\/lib\/openorb-runner/);
    assertMatch(execStarts[1] ?? "", new RegExp(`--allow-run=${sourceOverride.qemu}`));
    assertMatch(
      execStarts[1] ?? "",
      /\/opt\/openorb\/packages\/runner\/src\/standalone\.ts$/,
    );
    assertMatch(override, /^Environment=DENO_DIR=\/var\/cache\/openorb-runner\/deno$/m);
    assertNotMatch(override, new RegExp(sourceOverride.otherQemu));
    assertNotMatch(override, /--allow-all|-A(?:\s|$)|--allow-ffi|\/dev\/kvm/);
    assertNotMatch(override, /enrollment-token|OPENORB.*TOKEN|--data-dir/);
  });
}
