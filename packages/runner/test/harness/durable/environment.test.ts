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
