import { join } from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { execute } from "../../../src/runtime/process.ts";

import { assertEquals, assertStringIncludes } from "@jsr/std__assert";

const RUN_GONDOLIN_TESTS = process.env.OPENORB_RUN_GONDOLIN_TESTS === "1";
const SCRIPT_PATH = new URL("../../../../../images/guest/prepare-nested-kvm.sh", import.meta.url)
  .pathname;

for (const [failedCommand, expectedWarning] of [
  ["modinfo", "could not locate KVM module"],
  ["gzip", "could not prepare compressed KVM module"],
  ["mv", "could not prepare compressed KVM module"],
  ["rm", "could not prepare compressed KVM module"],
  ["depmod", "could not refresh module dependencies"],
  ["modprobe", "could not load KVM module"],
] as const) {
  test.skipIf(!RUN_GONDOLIN_TESTS)(
    `nested KVM preparation continues boot when ${failedCommand} fails`,
    async () => {
      const fixtureDirectory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
      const binDirectory = join(fixtureDirectory, "bin");
      const moduleDirectory = join(fixtureDirectory, "modules");
      await fs.mkdir(binDirectory);
      await fs.mkdir(moduleDirectory);

      try {
        for (const module of ["irqbypass", "kvm", "kvm_amd"]) {
          await fs.writeFile(join(moduleDirectory, `${module}.ko.gz`), module);
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
        await writeCommand(binDirectory, "depmod", 'test "$FAIL_COMMAND" != depmod');
        await writeCommand(binDirectory, "modprobe", 'test "$FAIL_COMMAND" != modprobe');

        const output = await execute("/bin/sh", {
          args: ["-eu", "-c", `. '${SCRIPT_PATH}'\necho boot-continued`],
          env: {
            FAIL_COMMAND: failedCommand,
            MODULE_DIRECTORY: moduleDirectory,
            PATH: binDirectory,
          },
          stdout: "piped",
          stderr: "piped",
        });
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        assertEquals(output.code, 0);
        assertStringIncludes(stdout, "boot-continued");
        assertStringIncludes(stderr, expectedWarning);
      } finally {
        await fs.rm(fixtureDirectory, { recursive: true });
      }
    },
  );
}

async function writeCommand(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, name);
  await fs.writeFile(path, `#!/bin/sh\n${body}\n`);
  await fs.chmod(path, 0o755);
}
