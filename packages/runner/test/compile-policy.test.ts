import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import {
  array,
  object,
  optional,
  parse,
  parseSafe,
  record,
  string,
  union,
} from "@remix-run/data-schema";

const taskDefinitionSchema = object(
  {
    command: optional(string()),
    dependencies: optional(array(string())),
  },
  { unknownKeys: "error" },
);
const denoConfigSchema = object(
  {
    tasks: optional(record(string(), union([string(), taskDefinitionSchema]))),
  },
  { unknownKeys: "passthrough" },
);

Deno.test("standalone compile tasks bake the approved least-privilege permissions", async () => {
  const rootConfig = parse(
    denoConfigSchema,
    JSON.parse(await Deno.readTextFile(new URL("../../../deno.json", import.meta.url))),
  );

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
    const directCommand = parseSafe(string(), task);
    const command = directCommand.success
      ? directCommand.value
      : parse(taskDefinitionSchema, task).command;
    assert(command);
    assertMatch(command, new RegExp(`--target ${expected.target}`));
    assertMatch(command, new RegExp(`--output ${expected.output}`));
    assertMatch(command, /--allow-read=\./);
    assertMatch(command, /--allow-write=\./);
    assertMatch(command, /--allow-net(?:\s|$)/);
    assertMatch(command, /--allow-env=PATH,PWD,NODE_V8_COVERAGE,TF_BUILD/);
    assertMatch(
      command,
      /--allow-sys=gid,homedir,networkInterfaces,statfs,systemMemoryInfo,uid/,
    );
    assertMatch(command, new RegExp(`--allow-run=${expected.qemu}`));
    assertNotMatch(command, /--allow-all|-A(?:\s|$)|--allow-ffi/);
  }

  const releaseTask = parse(taskDefinitionSchema, rootConfig.tasks?.["release:runner"]);
  assertEquals(releaseTask.dependencies, [
    "compile:runner:linux-x64",
    "compile:runner:linux-arm64",
  ]);
});
