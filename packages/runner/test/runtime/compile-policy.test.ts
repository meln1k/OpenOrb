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

Deno.test("source runner tasks use their intended development permissions", async () => {
  const runnerConfig = parse(
    denoConfigSchema,
    JSON.parse(await Deno.readTextFile(new URL("../../deno.json", import.meta.url))),
  );

  const devCommand = parse(string(), runnerConfig.tasks?.dev);
  assertMatch(devCommand, /^MSGPACKR_NATIVE_ACCELERATION_DISABLED=true /);
  assertMatch(devCommand, /--allow-read(?:\s|$)/);
  assertMatch(devCommand, /--allow-write(?:\s|$)/);
  assertMatch(devCommand, /--allow-ffi(?:\s|$)/);
  assertMatch(devCommand, /--allow-run=qemu-system-aarch64,qemu-system-x86_64,qemu-img(?:\s|$)/);
  assertNotMatch(devCommand, /--allow-all|-A(?:\s|$)/);
  assertEquals(devCommand.split(/\s+/).at(-1), "../../scripts/run-development-runner.ts");

  const startCommand = parse(string(), runnerConfig.tasks?.start);
  assertMatch(startCommand, /^MSGPACKR_NATIVE_ACCELERATION_DISABLED=true /);
  assertMatch(
    startCommand,
    /--allow-read=\.\.\/\.\.,\/lib,\/lib64,\/usr\/lib,\/usr\/lib64(?:\s|$)/,
  );
  assertMatch(startCommand, /--allow-write=\.\.\/\.\.\/\.openorb-runner-dev(?:\s|$)/);
  assertMatch(
    startCommand,
    /--allow-run=qemu-system-aarch64,qemu-system-x86_64,qemu-img(?:\s|$)/,
  );
  assertNotMatch(startCommand, /--allow-all|-A(?:\s|$)|--allow-ffi/);
  assertEquals(startCommand.split(/\s+/).at(-1), "../../scripts/run-development-runner.ts");
});

Deno.test("standalone compile tasks bake the approved least-privilege permissions", async () => {
  const rootConfig = parse(
    denoConfigSchema,
    JSON.parse(await Deno.readTextFile(new URL("../../../../deno.json", import.meta.url))),
  );

  const targets = [
    {
      task: "compile:runner:linux-x64",
      target: "x86_64-unknown-linux-gnu",
      output: "dist/openorb-runner-linux-x64",
      qemu: "/usr/bin/qemu-system-x86_64,/usr/bin/qemu-img",
    },
    {
      task: "compile:runner:linux-arm64",
      target: "aarch64-unknown-linux-gnu",
      output: "dist/openorb-runner-linux-arm64",
      qemu: "/usr/bin/qemu-system-aarch64,/usr/bin/qemu-img",
    },
  ];

  for (const expected of targets) {
    const task = rootConfig.tasks?.[expected.task];
    const directCommand = parseSafe(string(), task);
    const command = directCommand.success
      ? directCommand.value
      : parse(taskDefinitionSchema, task).command;
    assert(command);
    const arguments_ = command.split(/\s+/);
    assertMatch(command, new RegExp(`--target ${expected.target}`));
    assertMatch(command, new RegExp(`--output ${expected.output}`));
    assertMatch(command, /--allow-read=\.,\/lib,\/lib64,\/usr\/lib,\/usr\/lib64/);
    assertMatch(command, /--allow-write=\./);
    assertNotMatch(command, /--allow-(?:read|write)=[^\s]*\/dev\/kvm/);
    assertMatch(command, /--allow-net(?:\s|$)/);
    assertEquals(
      arguments_.filter((argument) =>
        argument === "--allow-env" || argument.startsWith("--allow-env=")
      ),
      ["--allow-env=PATH,PWD,NODE_V8_COVERAGE,TF_BUILD"],
    );
    assertMatch(
      command,
      /--allow-sys=cpus,gid,homedir,hostname,networkInterfaces,osRelease,statfs,systemMemoryInfo,uid/,
    );
    assertMatch(command, new RegExp(`--allow-run=${expected.qemu}`));
    assertNotMatch(command, /--allow-all|-A(?:\s|$)|--allow-ffi/);
    assertEquals(arguments_.at(-1), "packages/runner/src/standalone.ts");
  }

  const releaseTask = parse(taskDefinitionSchema, rootConfig.tasks?.["release:runner"]);
  assertEquals(releaseTask.dependencies, [
    "compile:runner:linux-x64",
    "compile:runner:linux-arm64",
  ]);
  assertMatch(
    releaseTask.command ?? "",
    /--allow-read=dist,packages\/runner\/systemd\/openorb-runner\.service/,
  );
});
