import { assert, assertEquals } from "@std/assert";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";
import { createGuestExecutionEnv } from "../../../src/harness/durable/environment.ts";
import { memoryGuest } from "./helpers.ts";

Deno.test({
  name: "unavailable Gondolin capabilities return not_supported without acquiring a guest",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const { environment } = memoryGuest();
    const env = createGuestExecutionEnv(
      new Proxy(environment, {
        get: () => {
          throw new Error("Must not acquire a guest");
        },
      }),
      "unsupported",
    );
    for (
      const result of await Promise.all([
        env.appendFile("file", "text", context),
        env.truncateFile("file", 0, context),
        env.flushFile("file", context),
        env.canonicalPath("file", context),
        env.createTempDir(undefined, context),
        env.createTempFile(undefined, context),
        env.openTextLineReader("file", context),
        env.readTextLines("file", undefined, context),
        env.openBinaryReader("file", { noFollow: true }, context),
        env.openDirReader("directory", context),
        env.watch([{ path: "directory", recursive: true }], () => {}, context),
      ])
    ) {
      assert(!result.ok);
      assertEquals(result.error.code, "not_supported");
    }
  },
});

Deno.test("Durable filesystem adapter normalizes guest paths and preserves binary views and options", async () => {
  const { environment, files } = memoryGuest();
  const calls: unknown[] = [];
  const env = createGuestExecutionEnv({
    ...environment,
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        calls.push(["mkdir", path, options]);
      }),
    listDirectory: (path) =>
      Effect.sync(() => {
        calls.push(["list", path]);
        return ["file"];
      }),
    renameFile: (source, destination) =>
      Effect.sync(() => {
        calls.push(["rename", source, destination]);
      }),
    remove: (path, options) =>
      Effect.sync(() => {
        calls.push(["remove", path, options]);
      }),
  }, "filesystem");
  getOrThrow(
    await env.writeFile("nested/file", new Uint8Array([88, 0, 255, 99]).subarray(1, 3), context),
  );
  assertEquals(files.get("/workspace/nested/file"), new Uint8Array([0, 255]));
  assertEquals(getOrThrow(await env.listDir("nested", context)), [{
    name: "file",
    path: "/workspace/nested/file",
    kind: "file",
    size: 2,
    mtimeMs: 0,
  }]);
  getOrThrow(await env.createDir("a/../single", { recursive: false }, context));
  getOrThrow(await env.renameFile("nested/file", "/tmp/moved", context));
  getOrThrow(await env.remove("nested", { recursive: true, force: true }, context));
  assertEquals(calls, [
    ["mkdir", "/workspace/nested", undefined],
    ["list", "/workspace/nested"],
    ["mkdir", "/workspace/single", { recursive: false }],
    ["rename", "/workspace/nested/file", "/tmp/moved"],
    ["remove", "/workspace/nested", { recursive: true, force: true }],
  ]);
});

Deno.test("cancelling native filesystem acquisition releases its guest readiness waiter", async () => {
  const { environment } = memoryGuest();
  const started = Promise.withResolvers<void>();
  let finished = false;
  const env = createGuestExecutionEnv({
    ...environment,
    stat: () =>
      Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => {
          finished = true;
        })),
      ),
  }, "opening");
  const controller = new AbortController();
  const pending = env.fileInfo("file", withAbortSignal(controller.signal, context));
  await started.promise;
  controller.abort();
  const result = await pending;
  assert(!result.ok);
  assertEquals(result.error.code, "aborted");
  assert(finished);
});

Deno.test({
  name: "guest binary readers retain bounded snapshots and scan decoded lines with host IO denied",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const { environment, files, reads } = memoryGuest();
    const bytes = new Uint8Array([239, 187, 191, 97, 10, 255, 10, 98, 10]);
    files.set("/workspace/file", bytes);
    const env = createGuestExecutionEnv(environment, "reader");
    const reader = getOrThrow(await env.openBinaryReader("file", undefined, context));
    assertEquals(getOrThrow(await reader.info(context)).size, bytes.length);
    assertEquals(getOrThrow(await reader.read(3, 100, context)), bytes.slice(3));
    assertEquals(getOrThrow(await reader.read(100, 2, context)), new Uint8Array());
    assertEquals(getOrThrow(await reader.scanLines({ startLine: 0, endLine: 1 }, context)), {
      newlines: 3,
      start: 0,
      end: 4,
      firstLineEnd: 4,
      lastLineStart: 0,
      selectedBytes: 1,
      firstLineBytes: 1,
    });
    assertEquals(getOrThrow(await reader.scanLines({ startLine: 1, endLine: 3 }, context)), {
      newlines: 3,
      start: 5,
      end: 8,
      firstLineEnd: 6,
      lastLineStart: 7,
      selectedBytes: 5,
      firstLineBytes: 3,
    });
    assertEquals(getOrThrow(await reader.scanLines({ startLine: 5 }, context)), {
      newlines: 3,
      start: 9,
      end: 9,
      firstLineEnd: 9,
      lastLineStart: 9,
      selectedBytes: 0,
      firstLineBytes: 0,
    });
    bytes.fill(0);
    files.set("/workspace/file", new Uint8Array([1]));
    assertEquals(getOrThrow(await reader.read(3, 1, context)), new Uint8Array([97]));
    assertEquals(getOrThrow(await reader.info(context)).size, 9);
    assertEquals(reads, ["/workspace/file"]);
    for (
      const result of await Promise.all([
        reader.read(-1, 1, context),
        reader.read(0, Infinity, context),
        reader.scanLines({ startLine: 1, endLine: 1 }, context),
      ])
    ) {
      assert(!result.ok);
      assertEquals(result.error.code, "invalid");
    }
    const cancelled = withAbortSignal(AbortSignal.abort(), context);
    for (
      const result of await Promise.all([
        reader.read(0, 1, cancelled),
        reader.info(cancelled),
        reader.scanLines({ startLine: 0 }, cancelled),
      ])
    ) {
      assert(!result.ok);
      assertEquals(result.error.code, "aborted");
    }
    await reader.close(cancelled);
    await reader.close(context);
    const closed = await reader.read(0, 1, context);
    assert(!closed.ok);
    assertEquals(closed.error.code, "invalid");
    const directory = await env.openBinaryReader(".", undefined, context);
    assert(!directory.ok);
    assertEquals(directory.error.code, "is_directory");
  },
});

Deno.test({
  name: "guest argv remains unparsed and stdout/stderr decode independently with metadata",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const { environment } = memoryGuest();
    const argv = ["/usr/bin/printf", "%s", "$(touch /host); 'quoted' 😀"];
    const output = { stdout: "", stderr: "" };
    let calls = 0;
    const env = createGuestExecutionEnv({
      ...environment,
      runShell: (command, options) =>
        Effect.gen(function* () {
          calls++;
          assertEquals(command, argv);
          assertEquals(options.timeoutSeconds, 10);
          const stdout = new TextEncoder().encode("😀\uFEFF");
          const stderr = new TextEncoder().encode("é");
          for (let i = 0; i < stdout.length; i++) {
            yield* options.onOutput(stdout.subarray(i, i + 1), "stdout");
            if (i < stderr.length) yield* options.onOutput(stderr.subarray(i, i + 1), "stderr");
          }
          return { exitCode: 0 };
        }).pipe(Effect.orDie),
    }, "argv");
    getOrThrow(
      await env.exec(argv, {
        timeout: 10,
        onOutput: (text, receivedContext, info) => {
          assertEquals(receivedContext, context);
          output[info.stream] += text;
        },
      }, context),
    );
    assertEquals(output, { stdout: "😀\uFEFF", stderr: "é" });
    for (
      const options of [
        { env: { KEY: "value" } },
        { inheritEnv: false },
        { spill: { afterBytes: 1, afterLines: 1 } },
      ]
    ) {
      const result = await env.exec(argv, { timeout: 10, ...options }, context);
      assert(!result.ok);
    }
    for (const command of [[], ["relative"]]) {
      const result = await env.exec(command, { timeout: 10 }, context);
      assert(!result.ok);
      assertEquals(result.error.code, "spawn_error");
    }
    assertEquals(calls, 1);
  },
});
