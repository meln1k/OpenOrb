import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Logger, Schema, Scope } from "effect";

import {
  createGondolinAgentEnvironment,
  createOpenOrbGondolinSandboxOptions,
  OPENORB_GUEST_MARKER,
} from "@/src/environment/gondolin/layer.ts";
import { resolveAgentPath } from "@/src/environment/agent-environment.ts";
import { createOpenOrbPiSession } from "@/src/harness/pi/session.ts";
import { createPiTools } from "@/src/harness/pi/tools.ts";
import {
  gondolinTestEnvironmentOptions,
  installLocalGuestImage,
} from "@/test/environment/gondolin/local-guest-image.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const CONVERSATION_PROJECTION = {
  activate: () => Effect.succeed({ update() {}, dispose() {} }),
};
// SAFETY: The custom edit executor does not inspect Pi's extension context.
const TOOL_CONTEXT = {} as ExtensionContext;

Deno.test("Linux Gondolin VMs expose host CPU virtualization through KVM", () => {
  const options = createOpenOrbGondolinSandboxOptions("/guest-image");

  assertEquals(options.imagePath, "/guest-image");
  if (Deno.build.os === "linux") {
    assertEquals(options.vmm, "qemu");
    assertEquals(options.accel, "kvm");
    assertEquals(options.cpu, "host");
  } else if (Deno.build.os === "darwin") {
    assertEquals(options.accel, "hvf");
    assertEquals(options.cpu, undefined);
  }
});

Deno.test("Linux Gondolin VMs can explicitly use QEMU software emulation", () => {
  const options = createOpenOrbGondolinSandboxOptions("/guest-image", true);

  assertEquals(options.imagePath, "/guest-image");
  if (Deno.build.os === "linux") {
    assertEquals(options.vmm, "qemu");
    assertEquals(options.accel, "tcg");
    assertEquals(options.cpu, undefined);
  }
});

Deno.test("agent path mapping anchors relative paths and preserves guest absolute paths", () => {
  assertEquals(resolveAgentPath(""), "/workspace");
  assertEquals(resolveAgentPath("file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentPath("nested/../file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentPath("/workspace/file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentPath("/workspace"), "/workspace");
  assertEquals(resolveAgentPath("@nested/file.txt"), "/workspace/nested/file.txt");
  assertEquals(
    resolveAgentPath("file:///workspace/nested/file.txt"),
    "/workspace/nested/file.txt",
  );

  const guestPathCases = [
    ["../outside", "/outside"],
    ["../../outside", "/outside"],
    ["/outside", "/outside"],
    ["/workspace/../../outside", "/outside"],
    ["/workspace-adjacent/file", "/workspace-adjacent/file"],
    ["file:///outside", "/outside"],
    ["@file:///outside", "/outside"],
  ] as const;
  for (const [input, expected] of guestPathCases) {
    assertEquals(resolveAgentPath(input), expected);
  }
  assertThrows(
    () => resolveAgentPath("~/outside"),
    Error,
    "Agent paths must use an absolute guest path instead of ~.",
  );
  assertThrows(
    () => resolveAgentPath("inside\0outside"),
    Error,
    "Agent paths must not contain NUL bytes.",
  );
});

Deno.test({
  name: "an output observer failure drains the command and retains the healthy VM",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const workspacePath = `${temporaryDirectory}/workspace`;
    await Deno.mkdir(workspacePath);
    const opened = await openRuntime({
      workspacePath,
      guestImage: await installLocalGuestImage(temporaryDirectory),
      sessionLabel: "openorb output observer failure test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
    });
    const runtime = opened.runtime;

    try {
      let observerCalls = 0;
      const observerError = await Effect.runPromise(Effect.flip(
        runtime.run(
          [
            "/bin/sh",
            "-lc",
            "printf first; sleep 0.1; printf second; printf retained > /tmp/openorb-retained-vm",
          ],
          {
            onOutput() {
              observerCalls++;
              return Effect.fail("event persistence failed");
            },
          },
        ),
      ));
      assertStringIncludes(String(observerError.cause), "event persistence failed");
      assertEquals(observerCalls, 1);

      let output = "";
      const result = await Effect.runPromise(
        runtime.run(["/bin/cat", "/tmp/openorb-retained-vm"], {
          onOutput: (chunk) => Effect.sync(() => output += chunk.text),
        }),
      );
      assertEquals(result.exitCode, 0);
      assertEquals(output, "retained");
    } finally {
      await opened.close();
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "shell timeouts bound retained output descriptors and preserve the VM",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const workspacePath = `${temporaryDirectory}/workspace`;
    await Deno.mkdir(workspacePath);
    const opened = await openRuntime({
      workspacePath,
      guestImage: await installLocalGuestImage(temporaryDirectory),
      sessionLabel: `openorb session ${SESSION_ID}`,
      sessionId: SESSION_ID,
      cpuCount: 2,
      memoryMiB: 2 * 1024,
    });
    const runtime = opened.runtime;
    const shellOptions = { cwd: "/workspace", onOutput: () => Effect.void };
    try {
      const largeChunkSize = 128 * 1024;
      let foregroundOutput = "";
      assertEquals(
        (await withWatchdog(
          Effect.runPromise(runtime.runShell(
            `python3 -c 'import os,time; os.write(1,b"A"*${largeChunkSize}); time.sleep(0.2); os.write(2,b"B"*${largeChunkSize}); time.sleep(0.2); os.write(1,b"C"*${largeChunkSize})'`,
            {
              cwd: "/workspace",
              onOutput: (data) =>
                Effect.sync(() => foregroundOutput += new TextDecoder().decode(data)),
            },
          )),
          10_000,
          "Large foreground output did not settle",
        )).exitCode,
        0,
      );
      assertEquals(
        foregroundOutput,
        "A".repeat(largeChunkSize) + "B".repeat(largeChunkSize) +
          "C".repeat(largeChunkSize),
      );

      assertEquals(
        (await Effect.runPromise(runtime.runShell(
          "printf retained >/opt/timeout-root; printf retained >/tmp/timeout-tmp",
          shellOptions,
        ))).exitCode,
        0,
      );
      const bootId = await Effect.runPromise(runtime.readFile("/proc/sys/kernel/random/boot_id"));
      for (
        const command of [
          "sleep 2; touch /workspace/timeout-late",
          "trap '' TERM; sleep 2; touch /workspace/timeout-late",
        ]
      ) {
        const result = await Effect.runPromise(runtime.runShell(command, {
          ...shellOptions,
          timeoutSeconds: 0.1,
        }));
        assert([124, 137].includes(result.exitCode));
        assertEquals(
          await Effect.runPromise(runtime.readFile("/proc/sys/kernel/random/boot_id")),
          bootId,
        );
        for (const path of ["/opt/timeout-root", "/tmp/timeout-tmp"]) {
          assertEquals(
            new TextDecoder().decode(await Effect.runPromise(runtime.readFile(path))),
            "retained",
          );
        }
      }
      for (const exitCode of [0, 7, 124, 137]) {
        assertEquals(
          (await Effect.runPromise(runtime.runShell(`exit ${exitCode}`, {
            ...shellOptions,
            timeoutSeconds: 1,
          }))).exitCode,
          exitCode,
        );
      }

      let retainedOutput = "";
      const retainedError = await assertRejects(
        () =>
          withWatchdog(
            Effect.runPromise(runtime.runShell(
              [
                'cd /workspace && export PATH="$HOME/.deno/bin:$PATH" &&',
                "nohup bash -c 'exec -a openorb-and-list-child sleep 300' >/tmp/openorb-and-list.log 2>&1 &",
                'echo "started pid $!"',
                'printf %s "$!" >/tmp/openorb-and-list.pid',
                "sleep 0.2",
                "tail -30 /tmp/openorb-and-list.log",
              ].join("\n"),
              {
                cwd: "/workspace",
                timeoutSeconds: 0.5,
                onOutput: (data) =>
                  Effect.sync(() => retainedOutput += new TextDecoder().decode(data)),
              },
            )),
            8_000,
            "Retained output descriptors exceeded the host watchdog",
          ),
        Error,
        "Stopped waiting after 2.5 seconds",
      );
      assertStringIncludes(retainedError.message, "The VM was preserved");
      assertStringIncludes(retainedOutput, "started pid ");

      let detachedOutput = "";
      assertEquals(
        (await withWatchdog(
          Effect.runPromise(runtime.runShell(
            [
              "cd /workspace || exit 1",
              "nohup bash -c 'exec -a openorb-detached-child sleep 300' </dev/null >/tmp/openorb-detached.log 2>&1 &",
              'echo "$!"',
              'printf %s "$!" >/tmp/openorb-detached.pid',
            ].join("\n"),
            {
              cwd: "/workspace",
              timeoutSeconds: 5,
              onOutput: (data) =>
                Effect.sync(() => detachedOutput += new TextDecoder().decode(data)),
            },
          )),
          8_000,
          "Correctly detached shell did not settle promptly",
        )).exitCode,
        0,
      );
      assert(/^\d+$/.test(detachedOutput.trim()), "Detached shell did not print its child PID");

      for (
        const [pidFile, processName] of [
          ["/tmp/openorb-and-list.pid", "openorb-and-list-child"],
          ["/tmp/openorb-detached.pid", "openorb-detached-child"],
        ]
      ) {
        assertEquals(
          (await Effect.runPromise(runtime.runShell(
            [
              `pid=$(cat ${pidFile})`,
              'kill -0 "$pid"',
              `tr '\\0' ' ' </proc/$pid/cmdline | grep -q ${processName}`,
            ].join("\n"),
            shellOptions,
          ))).exitCode,
          0,
        );
      }
      assertEquals(
        (await Effect.runPromise(runtime.runShell(
          "kill $(cat /tmp/openorb-and-list.pid) $(cat /tmp/openorb-detached.pid)",
          shellOptions,
        ))).exitCode,
        0,
      );

      let timeoutOutput = "";
      const timeoutError = await assertRejects(
        () =>
          withWatchdog(
            Effect.runPromise(runtime.runShell(
              [
                'setsid python3 -I -c $\'import os, signal, time\\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\\nopen("/tmp/openorb-timeout-output.ready", "w").close()\\nwhile True:\\n os.write(1, b"timeout-chunk")\\n time.sleep(0.02)\' &',
                'printf %s "$!" >/tmp/openorb-timeout-output.pid',
                "while test ! -e /tmp/openorb-timeout-output.ready; do sleep 0.01; done",
              ].join("\n"),
              {
                cwd: "/workspace",
                timeoutSeconds: 1,
                onOutput: (data) =>
                  Effect.sync(() => timeoutOutput += new TextDecoder().decode(data)),
              },
            )),
            8_000,
            "Host fallback did not bound continuing post-exit output",
          ),
        Error,
        "Stopped waiting after 3 seconds",
      );
      assertStringIncludes(timeoutError.message, "The VM was preserved");
      assertStringIncludes(timeoutOutput, "timeout-chunk");
      assertEquals(
        (await withWatchdog(
          Effect.runPromise(runtime.runShell(
            "kill -KILL $(cat /tmp/openorb-timeout-output.pid)",
            shellOptions,
          )),
          8_000,
          "The VM did not accept cleanup after the host fallback",
        )).exitCode,
        0,
      );
      assertEquals(
        await Effect.runPromise(runtime.readFile("/proc/sys/kernel/random/boot_id")),
        bootId,
      );
      for (const path of ["/opt/timeout-root", "/tmp/timeout-tmp"]) {
        assertEquals(
          new TextDecoder().decode(await Effect.runPromise(runtime.readFile(path))),
          "retained",
        );
      }

      const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
      const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
      const controller = new AbortController();
      await assertRejects(
        () =>
          withWatchdog(
            Effect.runPromise(
              runtime.runShell(
                [
                  "bash -c 'while test ! -s /tmp/openorb-abort-output.pid; do sleep 0.01; done; exec -a openorb-abort-output sh -c \"while :; do printf abort-chunk; sleep 0.05; done\"' &",
                  'printf %s "$!" >/tmp/openorb-abort-output.pid',
                ].join("\n"),
                {
                  cwd: "/workspace",
                  signal: controller.signal,
                  onOutput: () => Effect.sync(() => controller.abort()),
                },
              ).pipe(Effect.provide(Logger.layer([logger]))),
            ),
            8_000,
            "Abort did not settle continuing post-exit output",
          ),
        Error,
        "Command aborted",
      );
      assertEquals(
        (await withWatchdog(
          Effect.runPromise(runtime.runShell(
            "kill -KILL $(cat /tmp/openorb-abort-output.pid)",
            shellOptions,
          )),
          8_000,
          "The VM did not accept cleanup after Abort",
        )).exitCode,
        0,
      );
      const recovered = await Effect.runPromise(
        runtime.run(["/bin/true"]).pipe(Effect.provide(Logger.layer([logger]))),
      );
      assertEquals(recovered.exitCode, 0);
      assertEquals(logs.filter((entry) => String(entry.message).startsWith("gondolin.vm.")), []);
      const directAbort = new AbortController();
      await assertRejects(
        () =>
          Effect.runPromise(runtime.run([
            "/bin/bash",
            "-lc",
            "printf ready; sleep 30",
          ], {
            signal: directAbort.signal,
            onOutput: () => Effect.sync(() => directAbort.abort()),
          })),
        Error,
        "Command aborted",
      );
      await assertRejects(
        () =>
          Effect.runPromise(runtime.runShell("printf output", {
            cwd: "/workspace",
            onOutput: () => Effect.fail("observer failed"),
          })),
        Error,
        "Guest shell command execution failed",
      );
      // Invalid cwd fails at the exec boundary rather than returning a command exit status.
      await assertRejects(
        () =>
          Effect.runPromise(runtime.run(["/bin/true"], {
            cwd: "invalid\0cwd",
          })),
        Error,
        "Guest command execution failed",
      );
      await assertRejects(
        () =>
          Effect.runPromise(runtime.runShell("true", {
            ...shellOptions,
            cwd: "invalid\0cwd",
          })),
        Error,
        "Guest shell command execution failed",
      );
      assertEquals(
        await Effect.runPromise(runtime.readFile("/proc/sys/kernel/random/boot_id")),
        bootId,
      );
      for (const path of ["/opt/timeout-root", "/tmp/timeout-tmp"]) {
        assertEquals(
          new TextDecoder().decode(await Effect.runPromise(runtime.readFile(path))),
          "retained",
        );
      }
      assertEquals((await Effect.runPromise(runtime.run(["/bin/true"]))).exitCode, 0);
    } finally {
      await opened.close();
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "disk checkpoints preserve root and workspace state but not tmpfs or processes",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const workspacePath = `${temporaryDirectory}/workspace`;
    const firstCheckpointPath = `${temporaryDirectory}/checkpoint-first.qcow2`;
    const secondCheckpointPath = `${temporaryDirectory}/checkpoint-second.qcow2`;
    await Deno.mkdir(workspacePath);
    const guestImage = await installLocalGuestImage(temporaryDirectory);
    const runtimeOptions = {
      workspacePath,
      guestImage,
      sessionLabel: "openorb checkpoint cycle test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
      ...gondolinTestEnvironmentOptions(),
    };
    let opened = await openRuntime(runtimeOptions);

    try {
      const prepared = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          "printf root-one >/opt/openorb-checkpoint-root",
          "printf workspace-one >/workspace/openorb-checkpoint-workspace",
          "printf temporary >/tmp/openorb-checkpoint-tmp",
          "printf root-tmpfs >/root/openorb-checkpoint-root-tmpfs",
          "printf log-tmpfs >/var/log/openorb-checkpoint-log",
          "bash -c 'exec -a openorb-checkpoint-process sleep 300' >/dev/null 2>&1 &",
          "printf %s $! >/workspace/openorb-checkpoint-pid",
        ].join("\n"),
      ]));
      assertEquals(prepared.exitCode, 0);
      const editBeforeCheckpoint = createPiTools(opened.runtime).find((tool) =>
        tool.name === "edit"
      );
      assert(editBeforeCheckpoint);
      await editBeforeCheckpoint.execute(
        "edit-before-checkpoint",
        {
          path: "/opt/openorb-checkpoint-root",
          edits: [{ oldText: "root-one", newText: "root-before-resume" }],
        },
        undefined,
        undefined,
        TOOL_CONTEXT,
      );
      const firstCheckpoint = await Effect.runPromise(
        opened.runtime.checkpoint(firstCheckpointPath),
      );
      assertEquals(firstCheckpoint.path, firstCheckpointPath);
      assertEquals(firstCheckpoint.guestAssetBuildId, guestImage.gondolinBuildId);
      assert(firstCheckpoint.compatibleVmm.length > 0);
      await Effect.runPromise(Effect.flip(opened.runtime.run(["/bin/true"])));
      await opened.close();

      await assertRejects(
        () =>
          Effect.runPromise(Effect.scoped(createGondolinAgentEnvironment({
            ...runtimeOptions,
            resumeCheckpoint: {
              ...firstCheckpoint,
              guestAssetBuildId: crypto.randomUUID(),
            },
          }))),
        Error,
        "checkpoint could not be resumed",
      );

      opened = await openRuntime({ ...runtimeOptions, resumeCheckpoint: firstCheckpoint });
      const resumed = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          'test "$(cat /opt/openorb-checkpoint-root)" = root-before-resume',
          'test "$(cat /workspace/openorb-checkpoint-workspace)" = workspace-one',
          "test ! -e /tmp/openorb-checkpoint-tmp",
          "test ! -e /root/openorb-checkpoint-root-tmpfs",
          "test ! -e /var/log/openorb-checkpoint-log",
          "pid=$(cat /workspace/openorb-checkpoint-pid)",
          "test ! -r /proc/$pid/cmdline || ! tr '\\0' ' ' </proc/$pid/cmdline | grep -q openorb-checkpoint-process",
        ].join("\n"),
      ]));
      assertEquals(resumed.exitCode, 0);
      const editAfterCheckpoint = createPiTools(opened.runtime).find((tool) =>
        tool.name === "edit"
      );
      assert(editAfterCheckpoint);
      await editAfterCheckpoint.execute(
        "edit-after-checkpoint",
        {
          path: "/opt/openorb-checkpoint-root",
          edits: [{ oldText: "root-before-resume", newText: "root-after-resume" }],
        },
        undefined,
        undefined,
        TOOL_CONTEXT,
      );
      assertEquals(
        new TextDecoder().decode(
          await Effect.runPromise(opened.runtime.readFile("/opt/openorb-checkpoint-root")),
        ),
        "root-after-resume",
      );

      const updated = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          "printf root-two >/opt/openorb-checkpoint-root",
          "printf workspace-two >/workspace/openorb-checkpoint-workspace",
          "printf temporary-two >/tmp/openorb-checkpoint-tmp",
        ].join("\n"),
      ]));
      assertEquals(updated.exitCode, 0);
      const secondCheckpoint = await Effect.runPromise(
        opened.runtime.checkpoint(secondCheckpointPath),
      );
      await opened.close();

      opened = await openRuntime({ ...runtimeOptions, resumeCheckpoint: secondCheckpoint });
      const resumedAgain = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          'test "$(cat /opt/openorb-checkpoint-root)" = root-two',
          'test "$(cat /workspace/openorb-checkpoint-workspace)" = workspace-two',
          "test ! -e /tmp/openorb-checkpoint-tmp",
        ].join("\n"),
      ]));
      assertEquals(resumedAgain.exitCode, 0);
    } finally {
      await opened.close();
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "real Pi tools execute only in Gondolin and recover after cancellation",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const workspacePath = `${temporaryDirectory}/workspace`;
    const hostSecretPath = `${temporaryDirectory}/host-secret`;
    const hostProcessMarker = `${temporaryDirectory}/host-process-marker`;
    const originalHostMarker = Deno.env.get("OPENORB_HOST_PROCESS_MARKER");
    await Deno.mkdir(workspacePath);
    await Deno.writeTextFile(hostSecretPath, "runner-host-secret");
    await Deno.symlink(hostSecretPath, `${workspacePath}/absolute-escape`);
    await Deno.symlink("../host-secret", `${workspacePath}/relative-escape`);
    Deno.env.set("OPENORB_HOST_PROCESS_MARKER", hostProcessMarker);

    const guestImage = await installLocalGuestImage(temporaryDirectory);
    const opened = await openRuntime({
      workspacePath,
      guestImage,
      sessionLabel: "openorb Gondolin integration test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
    });
    const runtime = opened.runtime;
    const softwareEmulation = gondolinTestEnvironmentOptions().softwareEmulation === true;
    const piSessionFile = `${temporaryDirectory}/pi-session.jsonl`;
    await Deno.writeTextFile(piSessionFile, "");
    const pi = await Effect.runPromise(Effect.scoped(createOpenOrbPiSession({
      sessionId: SESSION_ID,
      runnerSessionFile: piSessionFile,
      runnerAgentDirectory: `${temporaryDirectory}/pi-agent`,
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
      branchName: "openorb/gondolin-environment-test",
      modelRuntime: {
        model: "opencode-go/deepseek-v4-flash",
        thinkingLevel: "high",
        credential: { type: "api_key", value: "test-model-provider-key" },
      },
      tools: createPiTools(runtime),
      conversationProjection: CONVERSATION_PROJECTION,
    })));

    try {
      assertEquals(
        pi.session.getAllTools().map((tool) => tool.name).sort(),
        ["bash", "edit", "read", "write"],
      );
      const tools = new Map(pi.session.agent.state.tools.map((tool) => [tool.name, tool]));
      const read = tools.get("read");
      const write = tools.get("write");
      const edit = tools.get("edit");
      const bash = tools.get("bash");
      assert(read && write && edit && bash);
      assert(
        createPiTools(runtime).find((tool) => tool.name === "edit")?.renderCall,
        "edit must override Pi's host-reading fallback renderer",
      );

      const imageProbe = await bash.execute("guest-image", {
        command: [
          "set -eu",
          'test "$(cat /etc/openorb-image-release)" = mvp-6',
          ". /etc/os-release",
          'test "$ID" = debian && test "$VERSION_ID" = 13',
          "test -x /usr/sbin/modprobe",
          ...(softwareEmulation ? [] : [
            'nested_kvm_module=; if grep -qw svm /proc/cpuinfo; then nested_kvm_module=kvm_amd; elif grep -qw vmx /proc/cpuinfo; then nested_kvm_module=kvm_intel; fi; if [ "$(uname -m)" = x86_64 ]; then test -n "$nested_kvm_module"; modprobe "$nested_kvm_module"; test -c /dev/kvm; fi',
            "if test -c /dev/kvm; then python3 -c 'import fcntl, os; fd = os.open(\"/dev/kvm\", os.O_RDWR); assert fcntl.ioctl(fd, 0xAE00) == 12'; fi",
          ]),
          'for command in agent-browser apt-get autoconf automake bash bun bunx bzip2 certutil corepack curl dpkg-buildpackage ffmpeg file find fzf g++ gcc gh git hg ip jq less lsof magick make modprobe node npm npx openssl patch perl ping pip pip3 pkg-config pnpm pnpx python python3 rg sed socat ssh svn tar time tmux unzip vim websocat wget xz yarn yarnpkg zstd sha256sum timeout; do command -v "$command" >/dev/null; done',
          "test -s /etc/ssl/certs/ca-certificates.crt",
          'for command in chromium chromium-browser google-chrome; do ! command -v "$command" >/dev/null; done',
          "test ! -e /root/.agent-browser/browsers",
          "agent-browser --version",
          "agent-browser --help >/dev/null",
          "agent-browser skills get core >/dev/null",
          "agent-browser close >/dev/null 2>&1 || true",
          "set +e",
          "timeout 10s agent-browser --session custom-browser-smoke --executable-path /bin/false open about:blank >/tmp/custom-browser 2>&1",
          "custom_browser_status=$?",
          "set -e",
          'test "$custom_browser_status" -ne 124',
          "agent-browser --session custom-browser-smoke close >/dev/null 2>&1 || true",
          "test ! -e /root/.agent-browser/browsers",
          "git --version",
          "gh --version",
          "set +e",
          "timeout 10s gh auth status </dev/null >/tmp/gh-auth-status 2>&1",
          "gh_status=$?",
          "set -e",
          'test "$gh_status" -ne 0 && test "$gh_status" -ne 124',
          'for command in apk deno go cargo rustc java javac dotnet ruby php lua R docker podman buildah nerdctl qemu-system-x86_64 qemu-img firecracker sqlite3 psql mysql mariadb redis-cli mongosh duckdb sshd; do ! command -v "$command" >/dev/null; done',
          'test -z "$(find /var/cache/apt/archives /var/lib/apt/lists -type f -print -quit 2>/dev/null)"',
          "test ! -e /root/.npm",
          "test ! -e /sbin/openrc",
          "test ! -x /usr/lib/systemd/systemd",
          "test ! -e /usr/sbin/sshd",
          "printf image-ok",
        ].join("\n"),
        timeout: 600,
      });
      assertStringIncludes(
        imageProbe.content[0]?.type === "text" ? imageProbe.content[0].text : "",
        "git version",
      );
      assertStringIncludes(
        imageProbe.content[0]?.type === "text" ? imageProbe.content[0].text : "",
        "gh version",
      );
      assertStringIncludes(
        imageProbe.content[0]?.type === "text" ? imageProbe.content[0].text : "",
        "agent-browser 0.35.0",
      );
      assertStringIncludes(
        imageProbe.content[0]?.type === "text" ? imageProbe.content[0].text : "",
        "image-ok",
      );

      const browserProbe = await bash.execute("guest-image-browser", {
        command: [
          "set -eu",
          "browser_session=openorb-image-smoke",
          'cleanup() { agent-browser --session "$browser_session" close >/dev/null 2>&1 || true; }',
          "trap cleanup EXIT",
          'timeout 360s agent-browser --session "$browser_session" open https://example.com',
          'case "$(uname -m)" in x86_64) test -n "$(find /root/.agent-browser/browsers -type f -name chrome -perm /111 -print -quit)" ;; aarch64) command -v chromium >/dev/null ;; *) exit 1 ;; esac',
          'test "$(timeout 30s agent-browser --session "$browser_session" get title)" = "Example Domain"',
          'test "$(timeout 30s agent-browser --session "$browser_session" eval "1+1")" = 2',
          'timeout 30s agent-browser --session "$browser_session" eval \'document.body.textContent="browser-ok"; "ok"\' >/dev/null',
          'test "$(timeout 30s agent-browser --session "$browser_session" get text body)" = browser-ok',
          'timeout 60s agent-browser --session "$browser_session" screenshot /tmp/openorb-image-smoke.png >/dev/null',
          "test -s /tmp/openorb-image-smoke.png",
          "file /tmp/openorb-image-smoke.png | rg 'PNG image data'",
          "printf browser-ok",
        ].join("\n"),
        timeout: 420,
      });
      assertStringIncludes(
        browserProbe.content[0]?.type === "text" ? browserProbe.content[0].text : "",
        "browser-ok",
      );

      await write.execute("write", { path: "nested/message.txt", content: "before\n" });
      assertEquals(await Deno.readTextFile(`${workspacePath}/nested/message.txt`), "before\n");

      const readResult = await read.execute("read", { path: "nested/message.txt" });
      assertEquals(readResult.content, [{ type: "text", text: "before\n" }]);
      const fileUrlReadResult = await read.execute("read-file-url", {
        path: "file:///workspace/nested/message.txt",
      });
      assertEquals(fileUrlReadResult.content, [{ type: "text", text: "before\n" }]);

      await write.execute("write-index", { path: "index.html", content: "before\n" });
      await edit.execute("edit", {
        path: "index.html",
        edits: [{ oldText: "before", newText: "after" }],
      });
      assertEquals(await Deno.readTextFile(`${workspacePath}/index.html`), "after\n");

      // Host-shaped absolute paths remain in the guest namespace. The existing runner-host
      // file must neither satisfy the initial read nor receive the subsequent guest mutations.
      await assertRejects(() => read.execute("read-host-shaped-guest", { path: hostSecretPath }));
      await write.execute("write-host-shaped-guest", {
        path: hostSecretPath,
        content: "guest before\n",
      });
      await edit.execute("edit-host-shaped-guest", {
        path: hostSecretPath,
        edits: [{ oldText: "before", newText: "after" }],
      });
      const guestAbsoluteRead = await read.execute("read-host-shaped-guest", {
        path: hostSecretPath,
      });
      assertEquals(guestAbsoluteRead.content, [{ type: "text", text: "guest after\n" }]);

      await write.execute("write-traversal-guest", {
        path: "../../openorb-guest-root.txt",
        content: "guest root\n",
      });
      const traversalRead = await read.execute("read-traversal-guest", {
        path: "/openorb-guest-root.txt",
      });
      assertEquals(traversalRead.content, [{ type: "text", text: "guest root\n" }]);

      for (const symlink of ["absolute-escape", "relative-escape"]) {
        await assertRejects(() => read.execute("read-link", { path: symlink }));
        await assertRejects(
          () => write.execute("write-link", { path: symlink, content: "changed" }),
        );
        await assertRejects(
          () =>
            edit.execute("edit-link", {
              path: symlink,
              edits: [{ oldText: "runner", newText: "guest" }],
            }),
        );
      }
      assertEquals(await Deno.readTextFile(hostSecretPath), "runner-host-secret");

      const updates: string[] = [];
      const markerResult = await bash.execute(
        "bash-marker",
        {
          command:
            `if [ -n "\${OPENORB_HOST_PROCESS_MARKER:-}" ]; then printf host > "\$OPENORB_HOST_PROCESS_MARKER"; fi\n` +
            `printf guest > guest-process-marker\n` +
            `printf first; sleep 0.2; printf second; sleep 0.2; printf ":\$${OPENORB_GUEST_MARKER}"`,
          timeout: 10,
        },
        undefined,
        (update) => {
          const text = update.content.find((content) => content.type === "text")?.text;
          if (text) updates.push(text);
        },
      );
      const markerOutput = markerResult.content.find((content) => content.type === "text")?.text ??
        "";
      assertStringIncludes(markerOutput, "firstsecond:1");
      assert(updates.some((update) => update.includes("first")), "Bash output did not stream");
      assertEquals(await Deno.readTextFile(`${workspacePath}/guest-process-marker`), "guest");
      await assertRejects(() => Deno.stat(hostProcessMarker), Deno.errors.NotFound);

      const linkError = await assertRejects(
        () => bash.execute("bash-link", { command: "cat relative-escape", timeout: 10 }),
        Error,
      );
      assert(!linkError.message.includes("runner-host-secret"));

      await assertRejects(
        () =>
          bash.execute("bash-timeout", {
            command: "sleep 1; printf too-late > timed-out-marker",
            timeout: 0.1,
          }),
        Error,
        "Command exited with code 124",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await assertRejects(
        () => Deno.stat(`${workspacePath}/timed-out-marker`),
        Deno.errors.NotFound,
      );
      const afterTimeout = await bash.execute("bash-after-timeout", {
        command: "printf recovered",
        timeout: 10,
      });
      assertStringIncludes(
        afterTimeout.content[0]?.type === "text" ? afterTimeout.content[0].text : "",
        "recovered",
      );

      const abortController = new AbortController();
      const abortPromise = bash.execute(
        "bash-abort",
        { command: "sleep 1; printf too-late > aborted-marker", timeout: 10 },
        abortController.signal,
      );
      setTimeout(() => abortController.abort(), 100);
      await assertRejects(() => abortPromise, Error, "Command aborted");
      // Abort abandons the wait; descendants are allowed to finish in the retained VM.
      const afterAbort = await bash.execute("bash-after-abort", {
        command: "printf reusable",
        timeout: 10,
      });
      assertStringIncludes(
        afterAbort.content[0]?.type === "text" ? afterAbort.content[0].text : "",
        "reusable",
      );
    } finally {
      pi.session.dispose();
      await opened.close();
      if (originalHostMarker === undefined) Deno.env.delete("OPENORB_HOST_PROCESS_MARKER");
      else Deno.env.set("OPENORB_HOST_PROCESS_MARKER", originalHostMarker);
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

async function openRuntime(
  options: Parameters<typeof createGondolinAgentEnvironment>[0],
) {
  const scope = await Effect.runPromise(Scope.make());
  const runtime = await Effect.runPromise(
    createGondolinAgentEnvironment({
      ...options,
      ...gondolinTestEnvironmentOptions(),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    runtime,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

async function withWatchdog<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
