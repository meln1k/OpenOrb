import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  createOpenOrbGondolinToolRuntime,
  OPENORB_GUEST_MARKER,
  resolveGuestWorkspacePath,
} from "@/src/gondolin-tools.ts";
import { OpenOrbPiSessionFactory } from "@/src/pi-session-factory.ts";

Deno.test("workspace path mapping rejects lexical escapes", () => {
  assertEquals(resolveGuestWorkspacePath("file.txt"), "/workspace/file.txt");
  assertEquals(resolveGuestWorkspacePath("nested/../file.txt"), "/workspace/file.txt");
  assertEquals(resolveGuestWorkspacePath("/workspace/file.txt"), "/workspace/file.txt");
  assertEquals(resolveGuestWorkspacePath("/workspace"), "/workspace");
  assertEquals(resolveGuestWorkspacePath("@nested/file.txt"), "/workspace/nested/file.txt");
  assertEquals(
    resolveGuestWorkspacePath("file:///workspace/nested/file.txt"),
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
      () => resolveGuestWorkspacePath(escaped),
      Error,
      "Path must remain within /workspace.",
    );
  }
  assertThrows(
    () => resolveGuestWorkspacePath("inside\0outside"),
    Error,
    "Workspace paths must not contain NUL bytes.",
  );
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

    const runtime = await createOpenOrbGondolinToolRuntime({
      workspacePath,
      sessionLabel: "openorb OO-008 integration test",
    });
    const pi = await OpenOrbPiSessionFactory.create({
      runnerSessionDirectory: `${temporaryDirectory}/pi-sessions`,
      runnerAgentDirectory: `${temporaryDirectory}/pi-agent`,
      tools: runtime.tools,
    });

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
      assertEquals(runtime.tools.find((tool) => tool.name === "edit")?.renderCall, undefined);

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
      await runtime.close();
      if (originalHostMarker === undefined) Deno.env.delete("OPENORB_HOST_PROCESS_MARKER");
      else Deno.env.set("OPENORB_HOST_PROCESS_MARKER", originalHostMarker);
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});
