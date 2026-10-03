import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Logger, Schema, Scope } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createGuestExecutionEnv } from "../../../src/harness/durable/environment.ts";

import {
  createOpenOrbGondolinSandboxOptions,
  makeGondolinAgentEnvironmentProvider,
  MAX_GUEST_FILE_BYTES,
  OPENORB_GUEST_MARKER,
} from "@/src/environment/gondolin/layer.ts";
import { resolveAgentPath } from "@/src/environment/agent-environment.ts";
import { durableTestOptions, guestTools } from "./durable-test-helpers.ts";
import {
  gondolinTestEnvironmentOptions,
  installLocalGuestImage,
} from "@/test/environment/gondolin/local-guest-image.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);

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
    const rootDiskPath = `${temporaryDirectory}/root-disk.qcow2`;
    const opened = await openRuntime({
      rootDiskPath,
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

      assertEquals(
        (await Effect.runPromise(runtime.run([
          "/usr/bin/truncate",
          "-s",
          String(MAX_GUEST_FILE_BYTES + 1),
          "/tmp/openorb-oversized-read",
        ]))).exitCode,
        0,
      );
      for (
        const [path, message] of [
          ["/dev/zero", "Guest file could not be read"],
          ["/tmp/openorb-oversized-read", "Guest file exceeds the 16777216-byte read limit."],
        ] as const
      ) {
        await assertRejects(
          () =>
            withWatchdog(
              Effect.runPromise(runtime.readFile(path)),
              5_000,
              `Guest read of ${path} did not settle`,
            ),
          Error,
          message,
        );
      }
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
    const rootDiskPath = `${temporaryDirectory}/root-disk.qcow2`;
    const opened = await openRuntime({
      rootDiskPath,
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
  name: "the stable root disk survives explicit stop, scope close, and VM reopen",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const rootDiskPath = `${temporaryDirectory}/root-disk.qcow2`;
    const runtimeOptions = {
      rootDiskPath,
      guestImage: await installLocalGuestImage(temporaryDirectory),
      sessionLabel: "openorb persistent root disk test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
      ...gondolinTestEnvironmentOptions(),
    };
    let opened = await openRuntime(runtimeOptions);

    try {
      let filesystemSizeOutput = "";
      const filesystemSize = await Effect.runPromise(opened.runtime.run([
        "/usr/bin/stat",
        "-f",
        "-c",
        "%b %S",
        "/",
      ], {
        onOutput: (chunk) => Effect.sync(() => filesystemSizeOutput += chunk.text),
      }));
      assertEquals(filesystemSize.exitCode, 0);
      const [blockCount = Number.NaN, blockSize = Number.NaN] = filesystemSizeOutput.trim()
        .split(/\s+/)
        .map(Number);
      assert(
        Number.isSafeInteger(blockCount) && Number.isSafeInteger(blockSize) &&
          blockCount * blockSize >= 39 * 1024 ** 3,
        `Expected at least 39 GiB of root filesystem capacity, got ${filesystemSizeOutput.trim()}`,
      );

      const written = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          "printf persistent-root >/opt/persistent-root",
          "printf persistent-workspace >/workspace/persistent-workspace",
          "printf temporary >/tmp/persistent-tmpfs",
          "printf root-tmpfs >/root/persistent-tmpfs",
          "printf log-tmpfs >/var/log/persistent-tmpfs",
          "bash -c 'exec -a openorb-persistent-process sleep 300' >/dev/null 2>&1 &",
          "printf %s $! >/workspace/persistent-process-pid",
          "sync -f /opt/persistent-root",
          "sync -f /workspace/persistent-workspace",
        ].join("\n"),
      ]));
      assertEquals(written.exitCode, 0);
      const rootDiskBeforeStop = await Deno.lstat(rootDiskPath);
      assert(rootDiskBeforeStop.isFile && !rootDiskBeforeStop.isSymlink);

      await Effect.runPromise(opened.runtime.stop);
      await Effect.runPromise(opened.runtime.stop);
      await assertRejects(
        () => Effect.runPromise(opened.runtime.run(["/bin/true"])),
        Error,
        "agent environment is closed",
      );
      await opened.close();
      assertEquals((await Deno.lstat(rootDiskPath)).ino, rootDiskBeforeStop.ino);

      opened = await openRuntime(runtimeOptions);
      assertEquals((await Deno.lstat(rootDiskPath)).ino, rootDiskBeforeStop.ino);
      assertEquals(
        new TextDecoder().decode(
          await Effect.runPromise(opened.runtime.readFile("/opt/persistent-root")),
        ),
        "persistent-root",
      );
      assertEquals(
        new TextDecoder().decode(
          await Effect.runPromise(opened.runtime.readFile("persistent-workspace")),
        ),
        "persistent-workspace",
      );
      const reopened = await Effect.runPromise(opened.runtime.run([
        "/bin/bash",
        "-lc",
        [
          "set -eu",
          "test ! -e /tmp/persistent-tmpfs",
          "test ! -e /root/persistent-tmpfs",
          "test ! -e /var/log/persistent-tmpfs",
          "pid=$(cat /workspace/persistent-process-pid)",
          "test ! -r /proc/$pid/cmdline || ! tr '\\0' ' ' </proc/$pid/cmdline | grep -q openorb-persistent-process",
        ].join("\n"),
      ]));
      assertEquals(reopened.exitCode, 0);
      await opened.close();
      await assertRejects(
        () => Effect.runPromise(opened.runtime.run(["/bin/true"])),
        Error,
        "agent environment is closed",
      );
    } finally {
      await opened.close();
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "Durable tools execute only in Gondolin and recover after cancellation",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const temporaryDirectory = await Deno.makeTempDir();
    const rootDiskPath = `${temporaryDirectory}/root-disk.qcow2`;
    const hostSecretPath = `${temporaryDirectory}/host-secret`;
    const hostProcessMarker = `${temporaryDirectory}/host-process-marker`;
    const originalHostMarker = Deno.env.get("OPENORB_HOST_PROCESS_MARKER");
    await Deno.writeTextFile(hostSecretPath, "runner-host-secret");
    Deno.env.set("OPENORB_HOST_PROCESS_MARKER", hostProcessMarker);

    const guestImage = await installLocalGuestImage(temporaryDirectory);
    const opened = await openRuntime({
      rootDiskPath,
      guestImage,
      sessionLabel: "openorb Gondolin integration test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
    });
    const runtime = opened.runtime;
    const softwareEmulation = gondolinTestEnvironmentOptions().softwareEmulation === true;
    const { tools, execute } = guestTools(durableTestOptions(runtime, temporaryDirectory));

    try {
      assertEquals(
        tools.map((tool) => tool.name).sort(),
        ["bash", "edit", "environment", "publish_media", "read", "readImage", "write"],
      );

      const imageProbe = await execute("bash", {
        command: [
          "set -eu",
          'test "$(cat /etc/openorb-image-release)" = release-1',
          ". /etc/os-release",
          'test "$ID" = debian && test "$VERSION_ID" = 13',
          "test -x /usr/sbin/modprobe",
          ...(softwareEmulation ? [] : [
            'nested_kvm_module=; if grep -qw svm /proc/cpuinfo; then nested_kvm_module=kvm_amd; elif grep -qw vmx /proc/cpuinfo; then nested_kvm_module=kvm_intel; fi; if [ "$(uname -m)" = x86_64 ]; then test -n "$nested_kvm_module"; modprobe "$nested_kvm_module"; test -c /dev/kvm; fi',
            "if test -c /dev/kvm; then python3 -c 'import fcntl, os; fd = os.open(\"/dev/kvm\", os.O_RDWR); assert fcntl.ioctl(fd, 0xAE00) == 12'; fi",
          ]),
          'for command in agent-browser apt-get autoconf automake bash bun bunx bzip2 certutil corepack curl dpkg-buildpackage ffmpeg file find fzf g++ gcc gh git hg ip jq less lsof magick make modprobe node npm npx openssl patch perl ping pip pip3 pkg-config pnpm pnpx python python3 resize2fs rg sed socat ssh svn tar time tmux unzip vim websocat wget xz yarn yarnpkg zstd sha256sum timeout; do command -v "$command" >/dev/null; done',
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
      assertStringIncludes(imageProbe.output, "git version");
      assertStringIncludes(imageProbe.output, "gh version");
      assertStringIncludes(imageProbe.output, "agent-browser 0.35.0");
      assertStringIncludes(imageProbe.output, "image-ok");

      const browserProbe = await execute("bash", {
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
      assertStringIncludes(browserProbe.output, "browser-ok");
      const screenshot = await execute("readImage", { path: "/tmp/openorb-image-smoke.png" });
      const image = screenshot.result.content?.find((content) => content.type === "image");
      assert(image && image.mimeType === "image/png");
      assertEquals(
        Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)),
        await Effect.runPromise(runtime.readFile("/tmp/openorb-image-smoke.png")),
      );

      await execute("write", { path: "nested/message.txt", content: "before\n" });
      assertEquals(
        new TextDecoder().decode(await Effect.runPromise(runtime.readFile("nested/message.txt"))),
        "before\n",
      );

      const readResult = await execute("read", { path: "nested/message.txt" });
      assertEquals(readResult.text, "before\n");
      const fileUrlReadResult = await execute("read", {
        path: "file:///workspace/nested/message.txt",
      });
      assertEquals(fileUrlReadResult.text, "before\n");

      await execute("write", { path: "index.html", content: "before\n" });
      await execute("edit", {
        path: "index.html",
        edits: [{ oldText: "before", newText: "after" }],
      });
      assertEquals(
        new TextDecoder().decode(await Effect.runPromise(runtime.readFile("index.html"))),
        "after\n",
      );

      // Host-shaped absolute paths remain in the guest namespace. The existing runner-host
      // file must neither satisfy the initial read nor receive the subsequent guest mutations.
      await assertRejects(() => execute("read", { path: hostSecretPath }));
      await execute("write", {
        path: hostSecretPath,
        content: "guest before\n",
      });
      await execute("edit", {
        path: hostSecretPath,
        edits: [{ oldText: "before", newText: "after" }],
      });
      const guestAbsoluteRead = await execute("read", {
        path: hostSecretPath,
      });
      assertEquals(guestAbsoluteRead.text, "guest after\n");

      await execute("write", {
        path: "../../openorb-guest-root.txt",
        content: "guest root\n",
      });
      const traversalRead = await execute("read", {
        path: "/openorb-guest-root.txt",
      });
      assertEquals(traversalRead.text, "guest root\n");

      for (
        const [symlink, target] of [
          ["absolute-guest-link", hostSecretPath],
          ["relative-guest-link", `..${hostSecretPath}`],
        ] as const
      ) {
        assertEquals(
          (await Effect.runPromise(runtime.run([
            "/bin/ln",
            "-s",
            target,
            `/workspace/${symlink}`,
          ]))).exitCode,
          0,
        );
      }

      for (const symlink of ["absolute-guest-link", "relative-guest-link"]) {
        await execute("write", {
          path: hostSecretPath,
          content: "guest before\n",
        });
        assertEquals(
          (await execute("read", { path: symlink })).text,
          "guest before\n",
        );
        await execute("write", {
          path: symlink,
          content: `${symlink} before\n`,
        });
        await execute("edit", {
          path: symlink,
          edits: [{ oldText: "before", newText: "after" }],
        });
        assertEquals(
          (await execute("read", { path: hostSecretPath })).text,
          `${symlink} after\n`,
        );
      }
      assertEquals(await Deno.readTextFile(hostSecretPath), "runner-host-secret");

      const updates: string[] = [];
      const markerResult = await execute(
        "bash",
        {
          command:
            `if [ -n "\${OPENORB_HOST_PROCESS_MARKER:-}" ]; then printf host > "\$OPENORB_HOST_PROCESS_MARKER"; fi\n` +
            `printf guest > guest-process-marker\n` +
            `printf first; sleep 0.2; printf second; sleep 0.2; printf ":\$${OPENORB_GUEST_MARKER}"`,
          timeout: 10,
        },
        { onOutput: (text) => updates.push(text) },
      );
      assertStringIncludes(markerResult.output, "firstsecond:1");
      assert(updates.some((update) => update.includes("first")), "Bash output did not stream");
      assertEquals(
        new TextDecoder().decode(
          await Effect.runPromise(runtime.readFile("guest-process-marker")),
        ),
        "guest",
      );
      await assertRejects(() => Deno.stat(hostProcessMarker), Deno.errors.NotFound);

      const linkResult = await execute(
        "bash",
        { command: "cat relative-guest-link", timeout: 10 },
      );
      assertStringIncludes(linkResult.output, "relative-guest-link after");
      assertEquals(await Deno.readTextFile(hostSecretPath), "runner-host-secret");

      // Gondolin owns command deadlines after readiness, including its bounded host wait.
      const timedOut = await withWatchdog(
        execute(
          "bash",
          {
            command: "sleep 1; printf too-late > timed-out-marker",
            timeout: 0.1,
          },
          { expectError: true },
        ),
        5_000,
        "Durable bash timeout did not settle",
      );
      assert(
        timedOut.diagnostics.some((entry) =>
          entry.message === "Command exited with code 124" ||
          entry.message === "Command exited with code 137"
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await Effect.runPromise(
        Effect.flip(runtime.access("timed-out-marker")),
      );
      const afterTimeout = await execute("bash", {
        command: "printf recovered",
        timeout: 10,
      });
      assertStringIncludes(afterTimeout.output, "recovered");

      const abortController = new AbortController();
      const abortPromise = execute(
        "bash",
        { command: "sleep 1; printf too-late > aborted-marker", timeout: 10 },
        { signal: abortController.signal },
      );
      const abortTimer = setTimeout(() => abortController.abort(), 100);
      try {
        const error = await assertRejects(
          () => withWatchdog(abortPromise, 5_000, "Durable bash cancellation did not settle"),
          Error,
        );
        assert(!(error instanceof AssertionError));
        assert(!error.message.includes("Durable bash cancellation did not settle"));
      } finally {
        clearTimeout(abortTimer);
      }
      assert(abortController.signal.aborted);
      // Abort abandons the wait; descendants are allowed to finish in the retained VM.
      const afterAbort = await execute("bash", {
        command: "printf reusable",
        timeout: 10,
      });
      assertStringIncludes(afterAbort.output, "reusable");
    } finally {
      await opened.close();
      if (originalHostMarker === undefined) Deno.env.delete("OPENORB_HOST_PROCESS_MARKER");
      else Deno.env.set("OPENORB_HOST_PROCESS_MARKER", originalHostMarker);
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "Durable filesystem capabilities operate entirely inside Gondolin",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const directory = await Deno.makeTempDir();
    const hostFile = `${directory}/host-only`;
    await Deno.writeTextFile(hostFile, "untouched");
    const guestImage = await installLocalGuestImage(directory);
    const opened = await openRuntime({
      rootDiskPath: `${directory}/root-disk.qcow2`,
      guestImage,
      sessionLabel: "Durable filesystem integration",
      cpuCount: 2,
      memoryMiB: 1024,
    });
    const env = createGuestExecutionEnv(opened.runtime, "filesystem-integration");
    try {
      const root = "/workspace/durable-filesystem";
      const path = `${root}/nested/quo'te😀.bin`;
      const bytes = new Uint8Array([99, 0, 255, 13, 10, 88]);
      getOrThrow(await env.writeFile(path, bytes.subarray(1, 5), context));
      assertEquals(
        getOrThrow(await env.readBinaryFile(path, context)),
        new Uint8Array([0, 255, 13, 10]),
      );
      const info = getOrThrow(await env.fileInfo(path, context));
      assertEquals({ name: info.name, path: info.path, kind: info.kind, size: info.size }, {
        name: "quo'te😀.bin",
        path,
        kind: "file",
        size: 4,
      });
      assert(info.mtimeMs > 0);
      assertEquals(getOrThrow(await env.listDir(`${root}/nested`, context)), [info]);
      getOrThrow(await env.writeFile(`${root}/target`, "replace me", context));
      getOrThrow(await env.renameFile(path, `${root}/target`, context));
      assertEquals(getOrThrow(await env.exists(path, context)), false);
      assertEquals(
        getOrThrow(await env.readBinaryFile(`${root}/target`, context)),
        bytes.subarray(1, 5),
      );
      const mkdir = await env.createDir(`${root}/missing/child`, { recursive: false }, context);
      assert(!mkdir.ok && mkdir.error.code === "unknown");
      getOrThrow(await env.createDir(`${root}/missing/child`, undefined, context));
      assertEquals(
        (await Effect.runPromise(opened.runtime.run([
          "/usr/bin/ln",
          "-s",
          `${root}/target`,
          `${root}/link`,
        ]))).exitCode,
        0,
      );
      const canonical = await env.canonicalPath(`${root}/link`, context);
      assert(!canonical.ok && canonical.error.code === "not_supported");
      // Gondolin stat follows symlinks; it does not expose lstat.
      assertEquals(getOrThrow(await env.fileInfo(`${root}/link`, context)).kind, "file");
      const listing = getOrThrow(await env.listDir(root, context));
      assertEquals(listing.map(({ name, kind }) => [name, kind]).sort(), [
        ["link", "file"],
        ["missing", "directory"],
        ["nested", "directory"],
        ["target", "file"],
      ]);
      getOrThrow(await env.remove(`${root}/link`, { recursive: true }, context));
      assert(getOrThrow(await env.exists(`${root}/target`, context)));
      const nonRecursive = await env.remove(root, undefined, context);
      assert(!nonRecursive.ok);

      const textFile = `${root}/lines`;
      const text = "a".repeat(65535) + "😀\r\nlast";
      getOrThrow(await env.writeFile(textFile, text, context));
      assertEquals(getOrThrow(await env.readTextFile(textFile, context)), text);
      getOrThrow(await env.remove(textFile, undefined, context));
      getOrThrow(await env.remove(textFile, { force: true }, context));
      getOrThrow(await env.writeFile(hostFile, "guest only", context));
      assertEquals(getOrThrow(await env.readTextFile(hostFile, context)), "guest only");
      getOrThrow(await env.remove(hostFile, undefined, context));
      assertEquals(await Deno.readTextFile(hostFile), "untouched");
      getOrThrow(await env.remove(root, { recursive: true }, context));
      assertEquals(getOrThrow(await env.exists(root, context)), false);
    } finally {
      await opened.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

async function openRuntime(
  options: Parameters<ReturnType<typeof makeGondolinAgentEnvironmentProvider>["make"]>[0] & {
    readonly guestImage: Parameters<typeof makeGondolinAgentEnvironmentProvider>[0];
    readonly softwareEmulation?: boolean;
  },
) {
  const scope = await Effect.runPromise(Scope.make());
  const config = { ...options, ...gondolinTestEnvironmentOptions() };
  const provider = makeGondolinAgentEnvironmentProvider(
    config.guestImage,
    config.softwareEmulation,
  );
  await Effect.runPromise(provider.initializeRootDisk(config.rootDiskPath));
  const runtime = await Effect.runPromise(
    provider.make(config).pipe(Effect.provideService(Scope.Scope, scope)),
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
