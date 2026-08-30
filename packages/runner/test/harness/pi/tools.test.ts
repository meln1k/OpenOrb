import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { EditToolDetails, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../../src/environment/agent-environment.ts";
import { createPiTools } from "../../../src/harness/pi/tools.ts";

// SAFETY: these tests call only tool executors; the read executor's sole context access is
// the optional model field, for which absence is a supported state.
const TOOL_CONTEXT = {} as ExtensionContext;

Deno.test({
  name: "Pi file tools access guest files without runner filesystem permissions",
  permissions: {
    read: false,
    write: false,
    env: ["PI_EXPERIMENTAL"],
    sys: ["homedir"],
  },
  async fn() {
    const environment = new MemoryAgentEnvironment([
      ["/workspace/index.html", "<h1>before</h1>\n"],
      ["/etc/openorb-tool.conf", "guest before\n"],
    ]);
    const tools = toolMap(environment);
    const read = tools.get("read");
    const write = tools.get("write");
    const edit = tools.get("edit");
    assert(read && write && edit);

    assertEquals(
      (await read.execute(
        "read",
        { path: "/workspace/index.html" },
        undefined,
        undefined,
        TOOL_CONTEXT,
      )).content,
      [{ type: "text", text: "<h1>before</h1>\n" }],
    );
    await edit.execute(
      "edit",
      {
        path: "/workspace/index.html",
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
    await write.execute(
      "write",
      {
        path: "../new.txt",
        content: "guest only\n",
      },
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
    assertEquals(
      (await read.execute(
        "read-guest-absolute",
        { path: "/etc/openorb-tool.conf" },
        undefined,
        undefined,
        TOOL_CONTEXT,
      )).content,
      [{ type: "text", text: "guest before\n" }],
    );
    await edit.execute(
      "edit-guest-absolute",
      {
        path: "/etc/openorb-tool.conf",
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
      undefined,
      TOOL_CONTEXT,
    );

    assertEquals(environment.files.get("/new.txt"), "guest only\n");
    assertEquals(environment.files.get("/workspace/index.html"), "<h1>after</h1>\n");
    assertEquals(environment.files.get("/etc/openorb-tool.conf"), "guest after\n");
    assert(edit.renderCall, "edit must override Pi's host-reading fallback renderer");

    for (const tool of [read, write, edit]) {
      await assertRejects(
        () =>
          Promise.resolve().then(() =>
            tool.execute(
              "escape",
              tool.name === "read"
                ? { path: "invalid\0path" }
                : tool.name === "write"
                ? { path: "invalid\0path", content: "invalid" }
                : {
                  path: "invalid\0path",
                  edits: [{ oldText: "before", newText: "invalid" }],
                },
              undefined,
              undefined,
              TOOL_CONTEXT,
            )
          ),
        Error,
        "Agent paths must not contain NUL bytes.",
      );
    }
  },
});

Deno.test("Pi edit preserves matching, line-ending, and all-or-nothing behavior", async () => {
  const original = "\uFEFFconst title = “Before”;  \r\nunchanged  \r\n";
  const environment = new MemoryAgentEnvironment([
    ["/workspace/index.html", original],
  ]);
  const edit = toolMap(environment).get("edit");
  assert(edit);

  const result = await edit.execute(
    "fuzzy-edit",
    {
      path: "index.html",
      edits: [{ oldText: 'const title = "Before";', newText: 'const title = "After";' }],
    },
    undefined,
    undefined,
    TOOL_CONTEXT,
  );
  assertEquals(
    environment.files.get("/workspace/index.html"),
    '\uFEFFconst title = "After";\r\nunchanged  \r\n',
  );
  // SAFETY: the result was returned by the edit definition selected by its unique tool name.
  const details = result.details as EditToolDetails | undefined;
  assertStringIncludes(details?.diff ?? "", "-1 const title = “Before”;");
  assertStringIncludes(details?.patch ?? "", 'const title = "After";');

  const afterFirstEdit = environment.files.get("/workspace/index.html");
  await assertRejects(
    () =>
      edit.execute(
        "invalid-batch",
        {
          path: "index.html",
          edits: [
            { oldText: 'const title = "After";', newText: 'const title = "Later";' },
            { oldText: "missing", newText: "replacement" },
          ],
        },
        undefined,
        undefined,
        TOOL_CONTEXT,
      ),
    Error,
    "Could not find edits[1]",
  );
  assertEquals(environment.files.get("/workspace/index.html"), afterFirstEdit);
});

Deno.test("concurrent Pi edits to the same guest path are serialized", async () => {
  const firstRead = Promise.withResolvers<void>();
  const releaseFirstRead = Promise.withResolvers<void>();
  let readCount = 0;
  const environment = new MemoryAgentEnvironment([
    ["/workspace/index.html", "first\n"],
  ]);
  environment.beforeRead = async () => {
    readCount++;
    if (readCount === 1) {
      firstRead.resolve();
      await releaseFirstRead.promise;
    }
  };
  const edit = toolMap(environment).get("edit");
  assert(edit);

  const first = edit.execute(
    "first-edit",
    {
      path: "index.html",
      edits: [{ oldText: "first", newText: "second" }],
    },
    undefined,
    undefined,
    TOOL_CONTEXT,
  );
  await firstRead.promise;
  const second = edit.execute(
    "second-edit",
    {
      path: "/workspace/./index.html",
      edits: [{ oldText: "second", newText: "third" }],
    },
    undefined,
    undefined,
    TOOL_CONTEXT,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  try {
    assertEquals(readCount, 1);
  } finally {
    releaseFirstRead.resolve();
  }
  await Promise.all([first, second]);
  assertEquals(environment.files.get("/workspace/index.html"), "third\n");
});

function toolMap(environment: AgentEnvironment) {
  return new Map(createPiTools(environment).map((tool) => [tool.name, tool]));
}

class MemoryAgentEnvironment implements AgentEnvironment {
  readonly files: Map<string, string>;
  beforeRead: () => Promise<void> = () => Promise.resolve();

  constructor(files: Iterable<readonly [string, string]>) {
    this.files = new Map(files);
  }

  run: AgentEnvironment["run"] = () => Effect.die("run is not available in this test");
  runShell: AgentEnvironment["runShell"] = () =>
    Effect.die("runShell is not available in this test");
  readFile: AgentEnvironment["readFile"] = (path) =>
    Effect.promise(async () => {
      await this.beforeRead();
      const content = this.files.get(path);
      if (content === undefined) {
        throw new AgentEnvironmentError("Guest file could not be read.", undefined);
      }
      return new TextEncoder().encode(content);
    });
  access: AgentEnvironment["access"] = (path) =>
    this.files.has(path)
      ? Effect.void
      : Effect.fail(new AgentEnvironmentError("Guest file could not be accessed.", undefined));
  writeFile: AgentEnvironment["writeFile"] = (path, content) =>
    Effect.sync(() => this.files.set(path, content)).pipe(Effect.asVoid);
  makeDirectory: AgentEnvironment["makeDirectory"] = () => Effect.void;
  detectImageMimeType: AgentEnvironment["detectImageMimeType"] = () => Effect.succeed(null);
  checkpoint: AgentEnvironment["checkpoint"] = () =>
    Effect.die("checkpoint is not available in this test");
}
