import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";

interface TaskDefinition {
  command?: string;
  dependencies?: string[];
}

Deno.test("standalone compile tasks bake the approved least-privilege permissions", async () => {
  const rootConfig = JSON.parse(
    await Deno.readTextFile(new URL("../../../deno.json", import.meta.url)),
  ) as { tasks?: Record<string, string | TaskDefinition> };

  const targets = [
    {
      task: "compile:runner:linux-x64",
      target: "x86_64-unknown-linux-gnu",
      output: "dist/openorb-runner-linux-x64",
      qemu: "qemu-system-x86_64,qemu-img",
    },
    {
      task: "compile:runner:linux-arm64",
      target: "aarch64-unknown-linux-gnu",
      output: "dist/openorb-runner-linux-arm64",
      qemu: "qemu-system-aarch64,qemu-img",
    },
  ];

  for (const expected of targets) {
    const task = rootConfig.tasks?.[expected.task];
    const command = typeof task === "string" ? task : task?.command;
    assert(typeof command === "string");
    assertMatch(command, new RegExp(`--target ${expected.target}`));
    assertMatch(command, new RegExp(`--output ${expected.output}`));
    assertMatch(command, /--allow-read=\./);
    assertMatch(command, /--allow-write=\./);
    assertMatch(command, /--allow-net(?:\s|$)/);
    assertMatch(command, new RegExp(`--allow-run=${expected.qemu}`));
    assertNotMatch(command, /--allow-all|-A(?:\s|$)|--allow-ffi/);
  }

  const releaseTask = rootConfig.tasks?.["release:runner"];
  assert(typeof releaseTask === "object");
  assertEquals(releaseTask.dependencies, [
    "compile:runner:linux-x64",
    "compile:runner:linux-arm64",
  ]);
});
