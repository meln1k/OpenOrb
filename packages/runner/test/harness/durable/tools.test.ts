import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { createDurableTools } from "../../../src/harness/durable/tools.ts";
import { createGuestExecutionEnv } from "../../../src/harness/durable/environment.ts";
import { AgentEnvironmentError } from "../../../src/environment/agent-environment.ts";
import { artifactStore, memoryGuest, optionsFor } from "./helpers.ts";

function setup() {
  const guest = memoryGuest();
  let output = "";
  // SAFETY: These tool executors use only env, output and diagnostic; no task/storage operations.
  const api = Object.assign({} as ToolExecutionApi, {
    env: createGuestExecutionEnv(guest.environment, "test"),
    output: (value: string | Uint8Array) => {
      output += value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
    },
    diagnostic: () => {},
  });
  const tools = new Map(
    createDurableTools(optionsFor("unused", guest.environment), artifactStore).map((
      tool,
    ) => [tool.name, tool]),
  );
  return { ...guest, api, tools, output: () => output };
}

Deno.test({
  name:
    "Durable file tools are guest-only with all host IO permissions denied; edits retain matching semantics",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const { files, tools, api } = setup();
    const text = "\uFEFFconst title = “Before”;  \r\nunchanged  \r\n";
    files.set("/etc/file.txt", new TextEncoder().encode(text));
    const read = tools.get("read")!;
    const edit = tools.get("edit")!;
    const write = tools.get("write")!;
    const readResult = await read.execute({ path: "/etc/file.txt" }, api, BACKGROUND_CONTEXT);
    assertEquals(readResult.content, [{ type: "text", text: text.slice(1) }]);
    await edit.execute(
      {
        path: "/etc/file.txt",
        edits: [{ oldText: 'const title = "Before";', newText: 'const title = "After";' }],
      },
      api,
      BACKGROUND_CONTEXT,
    );
    assertEquals(
      new TextDecoder().decode(files.get("/etc/file.txt")),
      'const title = "After";\r\nunchanged  \r\n',
    );
    const unchanged = files.get("/etc/file.txt");
    await assertRejects(() =>
      edit.execute(
        {
          path: "/etc/file.txt",
          edits: [{ oldText: "After", newText: "Later" }, { oldText: "missing", newText: "nope" }],
        },
        api,
        BACKGROUND_CONTEXT,
      )
    );
    assertEquals(files.get("/etc/file.txt"), unchanged);
    await write.execute({ path: "../new.txt", content: "guest only" }, api, BACKGROUND_CONTEXT);
    assertEquals(new TextDecoder().decode(files.get("/new.txt")), "guest only");
    for (const tool of [read, edit, write]) {
      await assertRejects(() =>
        tool.execute(
          { path: "nul\0path", content: "no", edits: [{ oldText: "a", newText: "b" }] },
          api,
          BACKGROUND_CONTEXT,
        )
      );
      assert(tool.replay !== "safe");
    }
  },
});

Deno.test("image reads preserve image content and media publication rejects escapes and scriptable formats", async () => {
  const { files, tools, api, reads } = setup();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  files.set("/workspace/.openorb/artifacts/picture.png", png);
  const image = await tools.get("readImage")!.execute(
    { path: ".openorb/artifacts/picture.png" },
    api,
    BACKGROUND_CONTEXT,
  );
  assertEquals(image.content?.[1], { type: "image", mimeType: "image/png", data: "iVBORw0KGgoB" });
  const published = await tools.get("publish_media")!.execute(
    { path: ".openorb/artifacts/picture.png", description: "Picture]" },
    api,
    BACKGROUND_CONTEXT,
  );
  assertStringIncludes(JSON.stringify(published), "openorb-artifact:image:");
  const count = reads.length;
  await assertRejects(() =>
    tools.get("publish_media")!.execute(
      { path: ".openorb/artifacts/../../private.png", description: "No" },
      api,
      BACKGROUND_CONTEXT,
    )
  );
  assertEquals(reads.length, count);
  files.set(
    "/workspace/.openorb/artifacts/script.svg",
    new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
  );
  for (
    const [path, bytes] of [
      ["text.txt", new TextEncoder().encode("not an image")],
      ["movie.webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])],
      ["script.svg", files.get("/workspace/.openorb/artifacts/script.svg")!],
    ] as const
  ) {
    files.set(`/workspace/${path}`, bytes);
    await assertRejects(
      () => tools.get("readImage")!.execute({ path }, api, BACKGROUND_CONTEXT),
      Error,
      "readImage requires a PNG, JPEG, GIF, or WebP image",
    );
  }
  await assertRejects(() =>
    tools.get("publish_media")!.execute(
      { path: ".openorb/artifacts/script.svg", description: "No" },
      api,
      BACKGROUND_CONTEXT,
    )
  );
});

Deno.test("bash requires finite positive timeout and propagates cancellation to guest execution", async () => {
  const { environment, api } = setup();
  let passedSignal: AbortSignal | undefined;
  let calls = 0;
  let cancelled = false;
  const started = Promise.withResolvers<void>();
  const guest = {
    ...environment,
    runShell: (_command: string, options: Parameters<typeof environment.runShell>[1]) => {
      passedSignal = options.signal;
      calls++;
      return Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => {
          cancelled = true;
        })),
      );
    },
  };
  const bash = createDurableTools(optionsFor("unused", guest), artifactStore).find((tool) =>
    tool.name === "bash"
  )!;
  const guestApi = { ...api, env: createGuestExecutionEnv(guest, "test") };
  for (const timeout of [undefined, 0, -1, NaN, Infinity, 86400.001]) {
    await assertRejects(() =>
      bash.execute({ command: "sleep 100", timeout }, guestApi, BACKGROUND_CONTEXT)
    );
  }
  assertEquals(calls, 0);
  const controller = new AbortController();
  const running = bash.execute(
    { command: "sleep 100", timeout: 100 },
    guestApi,
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  await started.promise;
  controller.abort();
  await assertRejects(() => running);
  assert(passedSignal?.aborted);
  assert(cancelled);
  await assertRejects(() =>
    bash.execute(
      { command: "must not start", timeout: 1 },
      guestApi,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
  );
  assertEquals(calls, 1);
});

Deno.test("bash delegates its command timeout without spending it on guest readiness", async () => {
  const { environment, api } = setup();
  let timeoutSeconds: number | undefined;
  const guest = {
    ...environment,
    runShell: (_command: string, options: Parameters<typeof environment.runShell>[1]) =>
      Effect.sleep(30).pipe(Effect.andThen(Effect.sync(() => {
        timeoutSeconds = options.timeoutSeconds;
        return { exitCode: 124 };
      }))),
  };
  const bash = createDurableTools(optionsFor("unused", guest), artifactStore).find((tool) =>
    tool.name === "bash"
  )!;
  await assertRejects(
    () =>
      bash.execute(
        { command: "sleep 100", timeout: 0.001 },
        { ...api, env: createGuestExecutionEnv(guest, "test") },
        BACKGROUND_CONTEXT,
      ),
    Error,
    "Command exited with code 124",
  );
  assertEquals(timeoutSeconds, 0.001);
});

Deno.test({
  name: "Durable bash streams split UTF-8 through the guest with host IO denied",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const { environment, tools, api, output } = setup();
    const bytes = new TextEncoder().encode("prefix 😀 suffix");
    const guest = {
      ...environment,
      runShell: (command: string, options: Parameters<typeof environment.runShell>[1]) =>
        Effect.gen(function* () {
          assertEquals(command, "guest-command");
          assertEquals(options.cwd, "/workspace");
          assertEquals(options.timeoutSeconds, 86400);
          for (const byte of bytes) yield* options.onOutput(new Uint8Array([byte]));
          return { exitCode: 0 };
        }).pipe(Effect.orDie),
    };
    assertEquals(
      await tools.get("bash")!.execute(
        { command: "guest-command", timeout: 86400 },
        { ...api, env: createGuestExecutionEnv(guest, "test") },
        BACKGROUND_CONTEXT,
      ),
      {},
    );
    assertEquals(output(), "prefix 😀 suffix");
  },
});

Deno.test("Durable read pages text, bounds output, and leaves images to readImage", async () => {
  const { files, tools, api } = setup();
  files.set("/workspace/text.txt", new TextEncoder().encode("first\nsecond\nthird\nfourth"));
  const read = tools.get("read")!;
  const page = await read.execute(
    { path: "text.txt", offset: 2, limit: 2 },
    api,
    BACKGROUND_CONTEXT,
  );
  assertEquals(page.content, [{ type: "text", text: "second\nthird" }]);
  assertStringIncludes(page.diagnostics?.[0]?.message ?? "", "offset=4");
  await assertRejects(() => read.execute({ path: "text.txt", offset: 5 }, api, BACKGROUND_CONTEXT));
  files.set("/workspace/long.txt", new TextEncoder().encode("é".repeat(30000)));
  const long = await read.execute({ path: "long.txt" }, api, BACKGROUND_CONTEXT);
  assertEquals(long.content, [{ type: "text", text: "é".repeat(25600) }]);
  assertEquals(long.diagnostics?.[0]?.code, "truncated");
  files.set("/workspace/image.gif", new TextEncoder().encode("GIF89a"));
  const image = await read.execute({ path: "image.gif" }, api, BACKGROUND_CONTEXT);
  assertEquals(image.isError, true);
  assertEquals(image.diagnostics?.[0]?.code, "unsupported_image");
});

Deno.test("Durable read tries alternate filenames after a missing path", async () => {
  const { files, tools, api } = setup();
  files.set("/workspace/cafe\u0301’s.txt", new TextEncoder().encode("alternate filename"));
  assertEquals(await api.env.exists("missing.txt", BACKGROUND_CONTEXT), { ok: true, value: false });
  assertEquals(await api.env.exists("cafe\u0301’s.txt", BACKGROUND_CONTEXT), {
    ok: true,
    value: true,
  });
  const result = await tools.get("read")!.execute({ path: "café's.txt" }, api, BACKGROUND_CONTEXT);
  assertEquals(result.content, [{ type: "text", text: "alternate filename" }]);
});

Deno.test("guest path checks preserve failures and cancellation instead of reporting absence", async () => {
  const { environment } = memoryGuest();
  for (
    const run of [
      () => Effect.fail(new AgentEnvironmentError("VM unavailable", undefined)),
      () => Effect.succeed({ exitCode: 127 }),
    ]
  ) {
    const env = createGuestExecutionEnv({ ...environment, run }, "failure");
    const result = await env.exists("file", BACKGROUND_CONTEXT);
    assert(!result.ok);
    assertEquals(result.error.code, "unknown");
  }
  let calls = 0;
  const env = createGuestExecutionEnv({
    ...environment,
    run: () => Effect.sync(() => ({ exitCode: ++calls })),
  }, "cancelled");
  const result = await env.exists(
    "file",
    withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT),
  );
  assert(!result.ok);
  assertEquals(result.error.code, "aborted");
  assertEquals(calls, 0);
});

Deno.test("Durable serializes write/edit by lexical path when canonicalPath is unsupported", async () => {
  const { environment, files, tools, api, reads } = setup();
  files.set("/workspace/real/existing.txt", new Uint8Array());
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const env = createGuestExecutionEnv({
    ...environment,
    writeFile: (path, content) =>
      Effect.gen(function* () {
        if (content === "before") {
          started.resolve();
          yield* Effect.promise(() => release.promise);
        }
        return yield* environment.writeFile(path, content);
      }),
  }, "lexical-queue");
  const guestApi = { ...api, env };
  const writing = tools.get("write")!.execute(
    { path: "real/../real/new.txt", content: "before" },
    guestApi,
    BACKGROUND_CONTEXT,
  );
  await started.promise;
  const editing = tools.get("edit")!.execute(
    {
      path: "real/new.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
    guestApi,
    BACKGROUND_CONTEXT,
  );
  // An unrelated file can finish while the original write still holds its queue slot.
  await tools.get("write")!.execute(
    { path: "real/existing.txt", content: "independent" },
    guestApi,
    BACKGROUND_CONTEXT,
  );
  const prematureReads = [...reads];
  release.resolve();
  await Promise.all([writing, editing]);
  assertEquals(prematureReads, []);
  assertEquals(new TextDecoder().decode(files.get("/workspace/real/new.txt")), "after");
  assertEquals(new TextDecoder().decode(files.get("/workspace/real/existing.txt")), "independent");
});
