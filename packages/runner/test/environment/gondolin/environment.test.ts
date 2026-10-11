import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Effect, Exit, Scope } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";

import {
  createOpenOrbGondolinSandboxOptions,
  makeGondolinAgentEnvironmentProvider,
  OPENORB_GUEST_MARKER,
} from "@/src/environment/gondolin/layer.ts";
import { guestExecutionEnv, guestPathExists, guestTools, readGuestText } from "./guest-tools.ts";
import {
  gondolinTestEnvironmentOptions,
  installLocalGuestImage,
} from "@/test/environment/gondolin/local-guest-image.ts";

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
      assertEquals(await readGuestText(opened.runtime, "/opt/persistent-root"), "persistent-root");
      assertEquals(
        await readGuestText(opened.runtime, "/workspace/persistent-workspace"),
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
  name: "Durable tools over the Environment Daemon execute only in Gondolin and recover",
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
    const guest = guestExecutionEnv(runtime);
    const { execute } = guestTools(guest.env);

    try {
      const imageProbe = await execute("bash", {
        command: [
          "set -eu",
          'test "$(cat /etc/openorb-image-release)" = release-2',
          'test "$(/usr/local/libexec/openorb/pi-env --version)" = "pi-env 1.1.0"',
          "test -s /usr/share/doc/pi-env/copyright",
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
      // Binary guest files cross the Environment Link intact; image tools build on this read.
      const screenshot = getOrThrow(
        await guest.env.readBinaryFile("/tmp/openorb-image-smoke.png", BACKGROUND_CONTEXT),
      );
      const encoded = await execute("bash", {
        command: "base64 -w0 /tmp/openorb-image-smoke.png",
        timeout: 30,
      });
      assertEquals(screenshot.toBase64(), encoded.output.trim());

      await execute("write", { path: "nested/message.txt", content: "before\n" });
      assertEquals(await readGuestText(runtime, "/workspace/nested/message.txt"), "before\n");

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
      assertEquals(await readGuestText(runtime, "/workspace/index.html"), "after\n");

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
      assertEquals(await readGuestText(runtime, "/workspace/guest-process-marker"), "guest");
      await assertRejects(() => Deno.stat(hostProcessMarker), Deno.errors.NotFound);

      const linkResult = await execute(
        "bash",
        { command: "cat relative-guest-link", timeout: 10 },
      );
      assertStringIncludes(linkResult.output, "relative-guest-link after");
      assertEquals(await Deno.readTextFile(hostSecretPath), "runner-host-secret");

      // The Environment Daemon owns command deadlines and kills the timed-out process group.
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
          entry.message === "Command timed out after 0.1 seconds"
        ),
        JSON.stringify(timedOut.diagnostics),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert(!await guestPathExists(runtime, "/workspace/timed-out-marker"));
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
      guest.close();
      await opened.close();
      if (originalHostMarker === undefined) Deno.env.delete("OPENORB_HOST_PROCESS_MARKER");
      else Deno.env.set("OPENORB_HOST_PROCESS_MARKER", originalHostMarker);
      await Deno.remove(temporaryDirectory, { recursive: true });
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
