import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Schema, Scope } from "effect";

import {
  createGondolinAgentEnvironment,
  OPENORB_GUEST_MARKER,
} from "@/src/environment/gondolin/layer.ts";
import { resolveAgentWorkspacePath } from "@/src/environment/agent-environment.ts";
import { createOpenOrbPiSession } from "@/src/harness/pi/session.ts";
import { createPiTools } from "@/src/harness/pi/tools.ts";
import { installLocalGuestImage } from "@/test/environment/gondolin/local-guest-image.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const CONVERSATION_PROJECTION = {
  activate: () => Effect.succeed({ update() {}, dispose() {} }),
};

Deno.test("workspace path mapping rejects lexical escapes", () => {
  assertEquals(resolveAgentWorkspacePath("file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentWorkspacePath("nested/../file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentWorkspacePath("/workspace/file.txt"), "/workspace/file.txt");
  assertEquals(resolveAgentWorkspacePath("/workspace"), "/workspace");
  assertEquals(resolveAgentWorkspacePath("@nested/file.txt"), "/workspace/nested/file.txt");
  assertEquals(
    resolveAgentWorkspacePath("file:///workspace/nested/file.txt"),
    "/workspace/nested/file.txt",
  );

  for (
    const escaped of [
      "../outside",
      "../../outside",
      "/outside",
      "/workspace/../../outside",
      "/workspace-adjacent/file",
      "file:///outside",
      "@file:///outside",
      "~/outside",
    ]
  ) {
    assertThrows(
      () => resolveAgentWorkspacePath(escaped),
      Error,
      "Path must remain within /workspace.",
    );
  }
  assertThrows(
    () => resolveAgentWorkspacePath("inside\0outside"),
    Error,
    "Workspace paths must not contain NUL bytes.",
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
      sessionLabel: "openorb OO-008 integration test",
      cpuCount: 2,
      memoryMiB: 2 * 1024,
    });
    const runtime = opened.runtime;
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
      assertEquals(
        createPiTools(runtime).find((tool) => tool.name === "edit")?.renderCall,
        undefined,
      );

      const imageProbe = await bash.execute("guest-image", {
        command: [
          "set -eu",
          'test "$(cat /etc/openorb-image-release)" = mvp-5',
          ". /etc/os-release",
          'test "$ID" = debian && test "$VERSION_ID" = 13',
          'for command in agent-browser apt-get autoconf automake bash bun bunx bzip2 certutil corepack curl dpkg-buildpackage ffmpeg file find fzf g++ gcc gh git hg ip jq less lsof magick make node npm npx openssl patch perl ping pip pip3 pkg-config pnpm pnpx python python3 rg sed socat ssh svn tar time tmux unzip vim websocat wget xz yarn yarnpkg zstd sha256sum timeout; do command -v "$command" >/dev/null; done',
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

      await edit.execute("edit", {
        path: "/workspace/nested/message.txt",
        edits: [{ oldText: "before", newText: "after" }],
      });
      assertEquals(await Deno.readTextFile(`${workspacePath}/nested/message.txt`), "after\n");

      for (const escaped of ["../../host-secret", hostSecretPath]) {
        await assertRejects(
          () => read.execute("read-escape", { path: escaped }),
          Error,
          "Path must remain within /workspace.",
        );
        await assertRejects(
          () => write.execute("write-escape", { path: escaped, content: "changed" }),
          Error,
          "Path must remain within /workspace.",
        );
        await assertRejects(
          () =>
            edit.execute("edit-escape", {
              path: escaped,
              edits: [{ oldText: "runner", newText: "guest" }],
            }),
          Error,
          "Path must remain within /workspace.",
        );
      }

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
        () => bash.execute("bash-link", { command: "cat relative-escape" }),
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
        "Command timed out after 0.1 seconds",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await assertRejects(
        () => Deno.stat(`${workspacePath}/timed-out-marker`),
        Deno.errors.NotFound,
      );
      const afterTimeout = await bash.execute("bash-after-timeout", {
        command: "printf recovered",
      });
      assertStringIncludes(
        afterTimeout.content[0]?.type === "text" ? afterTimeout.content[0].text : "",
        "recovered",
      );

      const abortController = new AbortController();
      const abortPromise = bash.execute(
        "bash-abort",
        { command: "sleep 1; printf too-late > aborted-marker" },
        abortController.signal,
      );
      setTimeout(() => abortController.abort(), 100);
      await assertRejects(() => abortPromise, Error, "Command aborted");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await assertRejects(
        () => Deno.stat(`${workspacePath}/aborted-marker`),
        Deno.errors.NotFound,
      );
      const afterAbort = await bash.execute("bash-after-abort", { command: "printf reusable" });
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
    createGondolinAgentEnvironment(options).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    runtime,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
