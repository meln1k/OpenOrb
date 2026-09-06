import { join } from "node:path";

import { assertEquals, assertStringIncludes } from "@std/assert";

const RUN_GONDOLIN_TESTS = Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") === "1";
const SCRIPT_PATH = new URL(
  "../../../../../images/guest/prepare-nested-kvm.sh",
  import.meta.url,
).pathname;

for (
  const [failedCommand, expectedWarning] of [
    ["modinfo", "could not locate KVM module"],
    ["gzip", "could not prepare compressed KVM module"],
    ["mv", "could not prepare compressed KVM module"],
    ["rm", "could not prepare compressed KVM module"],
    ["depmod", "could not refresh module dependencies"],
    ["modprobe", "could not load KVM module"],
  ] as const
) {
  Deno.test({
    name: `nested KVM preparation continues boot when ${failedCommand} fails`,
    ignore: !RUN_GONDOLIN_TESTS,
    async fn() {
      const fixtureDirectory = await Deno.makeTempDir();
      const binDirectory = join(fixtureDirectory, "bin");
      const moduleDirectory = join(fixtureDirectory, "modules");
      await Deno.mkdir(binDirectory);
      await Deno.mkdir(moduleDirectory);

      try {
        for (const module of ["irqbypass", "kvm", "kvm_amd"]) {
          await Deno.writeTextFile(join(moduleDirectory, `${module}.ko.gz`), module);
        }
        await writeCommand(binDirectory, "uname", "echo x86_64");
        await writeCommand(binDirectory, "grep", 'test "$2" = svm');
        await writeCommand(
          binDirectory,
          "modinfo",
          'test "$FAIL_COMMAND" != modinfo || exit 1\necho "$MODULE_DIRECTORY/$2.ko.gz"',
        );
        await writeCommand(
          binDirectory,
          "gzip",
          'test "$FAIL_COMMAND" != gzip || exit 1\n/bin/cat "$2"',
        );
        await writeCommand(
          binDirectory,
          "mv",
          'test "$FAIL_COMMAND" != mv || exit 1\n/bin/mv "$@"',
        );
        await writeCommand(
          binDirectory,
          "rm",
          'test "$FAIL_COMMAND" != rm || exit 1\n/bin/rm "$@"',
        );
        await writeCommand(
          binDirectory,
          "depmod",
          'test "$FAIL_COMMAND" != depmod',
        );
        await writeCommand(
          binDirectory,
          "modprobe",
          'test "$FAIL_COMMAND" != modprobe',
        );

        const command = new Deno.Command("/bin/sh", {
          args: ["-eu", "-c", `. '${SCRIPT_PATH}'\necho boot-continued`],
          env: {
            FAIL_COMMAND: failedCommand,
            MODULE_DIRECTORY: moduleDirectory,
            PATH: binDirectory,
          },
          stdout: "piped",
          stderr: "piped",
        });
        const output = await command.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        assertEquals(output.code, 0);
        assertStringIncludes(stdout, "boot-continued");
        assertStringIncludes(stderr, expectedWarning);
      } finally {
        await Deno.remove(fixtureDirectory, { recursive: true });
      }
    },
  });
}

async function writeCommand(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, name);
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
}
