import { assert, assertEquals, assertObjectMatch, assertStringIncludes } from "@std/assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { DatabaseSync } from "node:sqlite";
import { packTar } from "modern-tar";
import { assertions } from "../../pi-env/test/fixtures.ts";
import {
  sandboxExecutionEnv,
  type SandboxHost,
  sandboxProvider,
} from "../app/cells/session/environment/sandbox-provider.ts";
import type { SandboxSql } from "../app/cells/session/environment/sandbox/persistent-fs.ts";
import type { SandboxRpc } from "../app/cells/session/environment/sandbox/rpc.ts";
import { Sandbox } from "../app/cells/session/environment/sandbox/worker.ts";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import { SessionId, WorkspaceId } from "@openorb/protocol/runner-api";
import { GitAuthor } from "@openorb/protocol/runner-api";

const context = BACKGROUND_CONTEXT;

/** celld rejects SQLite strings and blobs from about 2 MB. */
const CELLD_MAX_VALUE_BYTES = 2_000_000;

/** A facet's synchronous SQLite API over an in-memory database, with celld's value limit. */
/** An in-memory database with celld's value limit, counting the blob bytes written to it. */
function memorySql(written = { bytes: 0 }): SandboxSql {
  const database = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      for (const binding of bindings) {
        if (!(binding instanceof Uint8Array)) continue;
        if (binding.byteLength >= CELLD_MAX_VALUE_BYTES) {
          throw new Error("SQL error: string or blob too big");
        }
        written.bytes += binding.byteLength;
      }
      const rows = database.prepare(query).all(...bindings).map((row) => ({ ...row }));
      return { [Symbol.iterator]: () => rows.values(), toArray: () => rows };
    },
  };
}

/**
 * The sandbox facet in-process: the same class celld loads, over the given database. Arguments
 * and results are structured-cloned, as native RPC does, so the wire contract is exercised.
 */
function openSandbox(sql: SandboxSql): SandboxRpc {
  const sandbox = new Sandbox(
    { storage: { sql }, blockConcurrencyWhile: (callback) => callback() },
    {},
  );
  return {
    file: async (...args) => structuredClone(await sandbox.file(...structuredClone(args))),
    open: async (...args) => structuredClone(await sandbox.open(...structuredClone(args))),
    reader: async (...args) => structuredClone(await sandbox.reader(...structuredClone(args))),
    exec: async (...args) => structuredClone(await sandbox.exec(...structuredClone(args))),
    cancel: (id) => sandbox.cancel(structuredClone(id)),
    cleanup: () => sandbox.cleanup(),
  };
}

function sandboxEnv(sql = memorySql(), cwd = "/workspace"): ExecutionEnv {
  const sandbox = openSandbox(sql);
  return sandboxExecutionEnv("openorb-sandbox:test", cwd, () => sandbox);
}

async function gzipTar(entries: Parameters<typeof packTar>[0]): Promise<Uint8Array> {
  const archive = await packTar(entries);
  return new Uint8Array(
    await new Response(
      new Blob([archive.slice()]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}

async function run(env: ExecutionEnv, command: string | readonly string[]) {
  let output = "";
  const result = await env.exec(command, {
    onOutput: (text) => {
      output += text;
    },
  }, context);
  assert(result.ok, result.ok ? undefined : result.error.message);
  return { exitCode: result.value.exitCode, output };
}

// The virtual filesystem reports no changes; the sandbox declares watch unsupported.
for (
  const conformance of createEnvConformance({
    assertions,
    withEnv: async (use) => {
      const env = sandboxEnv();
      const cwd = `/workspace/case-${crypto.randomUUID()}`;
      const created = await env.createDir(cwd, { recursive: true }, context);
      assert(created.ok);
      env.cwd = cwd;
      await use(env);
    },
  }).filter((conformance) => !conformance.name.startsWith("watch "))
) {
  Deno.test({
    name: `sandbox ExecutionEnv over its RPC relay: ${conformance.name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => conformance.run(),
  });
}

Deno.test("the sandbox filesystem survives a restart from its SQLite database", async () => {
  const sql = memorySql();
  const env = sandboxEnv(sql);
  assertEquals(
    (await run(
      env,
      [
        "mkdir -p src/nested && echo kept > src/nested/a.txt && echo gone > b.txt",
        "ln -s nested/a.txt src/link && mv b.txt src/moved.txt && rm src/moved.txt",
        "cp -r src copy && chmod 0755 copy/nested/a.txt && echo temporary > /tmp/scratch",
      ].join(" && "),
    )).exitCode,
    0,
  );
  const restarted = sandboxEnv(sql);
  assertEquals(
    (await run(restarted, "cat src/nested/a.txt src/link copy/nested/a.txt")).output,
    "kept\nkept\nkept\n",
  );
  assertEquals((await run(restarted, "test -e src/moved.txt || echo absent")).output, "absent\n");
  assertEquals(
    (await run(restarted, "test -e /tmp/scratch || echo temporary")).output,
    "temporary\n",
  );
  const info = await restarted.fileInfo("src/link", context);
  assert(info.ok);
  assertEquals(info.value.kind, "symlink");
});

Deno.test("sandbox tar unpacks archives without escaping the target directory", async () => {
  const env = sandboxEnv();
  const gzipped = await gzipTar([
    { header: { name: "repo-abc/README.md", size: 5, type: "file" }, body: "hello" },
    { header: { name: "repo-abc/bin/", size: 0, type: "directory" } },
    { header: { name: "repo-abc/bin/run", size: 2, type: "file", mode: 0o755 }, body: "ok" },
    { header: { name: "repo-abc/../escape.txt", size: 1, type: "file" }, body: "x" },
    { header: { name: "/absolute.txt", size: 1, type: "file" }, body: "x" },
  ]);
  const written = await env.writeFile("/tmp/archive.tgz", gzipped, context);
  assert(written.ok);
  const unpacked = await run(env, [
    "tar",
    "-xzf",
    "/tmp/archive.tgz",
    "-C",
    "/workspace/checkout",
    "--strip-components=1",
  ]);
  assertEquals(unpacked.exitCode, 0);
  assertEquals((await run(env, "cat checkout/README.md checkout/bin/run")).output, "hellook");
  assertEquals(
    (await run(env, "ls -A /workspace /workspace/checkout; ls /absolute.txt 2>&1 || true")).output
      .includes("escape.txt"),
    false,
  );
  assertEquals((await run(env, "test -e /absolute.txt || echo safe")).output, "safe\n");
  assertEquals(
    (await run(env, "test -x checkout/bin/run && echo executable")).output,
    "executable\n",
  );
});

Deno.test("sandbox commands accept login shells and argv words unparsed", async () => {
  const env = sandboxEnv();
  assertEquals((await run(env, ["/bin/sh", "-lc", "echo login"])).output, "login\n");
  assertEquals(
    (await run(env, ["printf", "%s\\n", "a'b $HOME; touch injected"])).output,
    "a'b $HOME; touch injected\n",
  );
  assertEquals((await run(env, "test -e injected || echo clean")).output, "clean\n");
  assertEquals((await run(env, "curl https://example.com")).exitCode, 127);
});

Deno.test("a stopped sandbox fails guest operations immediately and keeps its files", async () => {
  const sql = memorySql();
  let state: EnvironmentState = "stopped";
  let facet: SandboxRpc | undefined;
  const calls: string[] = [];
  const host: SandboxHost = {
    facet: () => facet ??= openSandbox(sql),
    stop: () => {
      calls.push("stop");
      facet = undefined;
    },
    delete: () => calls.push("delete"),
  };
  const provider = sandboxProvider({
    host,
    state: () => state,
    recordState: (next) => state = next,
  });
  assertObjectMatch(provider.capabilities, {
    git: false,
    credentials: "none",
    hibernatableLink: false,
    persistence: "virtual-disk",
  });
  const environment = provider.bind({
    workspaceId: WorkspaceId.make(crypto.randomUUID()),
    sessionId: SessionId.make(crypto.randomUUID()),
    repository: {
      url: "https://github.com/acme/app.git",
      gitAuthor: new GitAuthor({ name: "A", email: "a@example.com" }),
    },
  });
  const stopped = await environment.env.readTextFile("/workspace/a", context);
  assert(!stopped.ok);
  assertStringIncludes(stopped.error.message, "stopped");
  assertEquals((await environment.control("start")).state, "running");
  assert((await environment.env.writeFile("/workspace/a", "kept", context)).ok);
  assertEquals((await environment.control("stop")).state, "stopped");
  await environment.control("start");
  const read = await environment.env.readTextFile("/workspace/a", context);
  assert(read.ok);
  assertEquals(read.value, "kept");
  await environment.delete();
  assertEquals(calls, ["stop", "delete"]);
  assertEquals(state, "stopped");
});

Deno.test("files larger than one SQLite value survive a restart, appends included", async () => {
  const sql = memorySql();
  const env = sandboxEnv(sql);
  const large = new Uint8Array(5 * 1024 * 1024).map((_, index) => index % 251);
  assert((await env.writeFile("large.bin", large, context)).ok);
  assert((await env.writeFile("log.txt", "one\n", context)).ok);
  for (const line of ["two\n", "three\n"]) {
    assert((await env.appendFile("log.txt", line, context)).ok);
  }
  assert((await env.appendFile("large.bin", new Uint8Array([7]), context)).ok);
  const restarted = sandboxEnv(sql);
  const read = await restarted.readBinaryFile("large.bin", context);
  assert(read.ok);
  assertEquals(read.value.byteLength, large.byteLength + 1);
  assertEquals(read.value.subarray(0, large.byteLength), large);
  assertEquals(read.value.at(-1), 7);
  const log = await restarted.readTextFile("log.txt", context);
  assert(log.ok);
  assertEquals(log.value, "one\ntwo\nthree\n");
});

Deno.test("recursive moves and copies write each file to SQLite once", async () => {
  const written = { bytes: 0 };
  const sql = memorySql(written);
  const env = sandboxEnv(sql);
  const data = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
  assert((await env.writeFile("a/b/c/d/data.bin", data, context)).ok);
  assert((await env.writeFile("a/b/note.txt", "kept", context)).ok);
  for (const command of ["mv a z", "cp -r z y"]) {
    written.bytes = 0;
    assertEquals((await run(env, command)).exitCode, 0);
    assertEquals(written.bytes, data.byteLength + "kept".length, command);
  }
  written.bytes = 0;
  assertEquals((await run(env, "rm -r y")).exitCode, 0);
  assertEquals(written.bytes, 0);
  const restarted = sandboxEnv(sql);
  assertEquals(
    (await run(restarted, "cat z/b/note.txt; test -e a || test -e y || echo gone")).output,
    "keptgone\n",
  );
  const read = await restarted.readBinaryFile("z/b/c/d/data.bin", context);
  assert(read.ok);
  assertEquals(read.value, data);
});

Deno.test("appends store only their new bytes and survive compaction", async () => {
  const written = { bytes: 0 };
  const sql = memorySql(written);
  const env = sandboxEnv(sql);
  assertEquals((await run(env, "for i in $(seq 300); do echo $i >> log.txt; done")).exitCode, 0);
  const expected = Array.from({ length: 300 }, (_, index) => `${index + 1}\n`).join("");
  // Without compaction this is the log's size; each compaction rewrites at most what precedes it.
  assert(written.bytes < 6 * expected.length, `${written.bytes} bytes written`);
  const [rows] = sql.exec(
    "SELECT COUNT(*) AS count FROM sandbox_chunks WHERE path = ?",
    "/workspace/log.txt",
  ).toArray();
  assert(Number(rows?.count) <= 65, `${rows?.count} rows`);
  const log = await sandboxEnv(sql).readTextFile("log.txt", context);
  assert(log.ok);
  assertEquals(log.value, expected);
});

Deno.test("a reader from before a sandbox restart cannot read another file", async () => {
  const sql = memorySql();
  let sandbox = openSandbox(sql);
  const env = sandboxExecutionEnv("openorb-sandbox:test", "/workspace", () => sandbox);
  assert((await env.writeFile("public.txt", "public", context)).ok);
  assert((await env.writeFile("secret.txt", "secret", context)).ok);
  const before = await env.openBinaryReader("public.txt", undefined, context);
  assert(before.ok);
  sandbox = openSandbox(sql);
  const after = await env.openBinaryReader("secret.txt", undefined, context);
  assert(after.ok);
  const stale = await before.value.read(0, 100, context);
  assert(!stale.ok);
  assertEquals(stale.error.code, "invalid");
});

Deno.test("a cancel that overtakes its command still stops it", async () => {
  const sandbox = openSandbox(memorySql());
  sandbox.cancel("early");
  const { result } = await sandbox.exec("early", "/workspace", "echo ran", {});
  assert(!result.ok);
  assertEquals(result.error.code, "aborted");
});

Deno.test("sandbox file errors carry their code and path, and joinPath stays pure", async () => {
  const env = sandboxEnv();
  const missing = await env.readTextFile("no/ENOENT-in-name.txt", context);
  assert(!missing.ok);
  assertEquals([missing.error.code, missing.error.path], ["not_found", "no/ENOENT-in-name.txt"]);
  const joined = await env.joinPath(["src", "../lib", "a.ts"], context);
  assert(joined.ok);
  assertEquals(joined.value, "lib/a.ts");
});

Deno.test("sandbox tar enforces archive limits and never writes through its own links", async () => {
  const env = sandboxEnv();
  const extract = async (entries: Parameters<typeof packTar>[0]) => {
    assert((await env.writeFile("/tmp/a.tgz", await gzipTar(entries), context)).ok);
    return await run(env, ["tar", "-xzf", "/tmp/a.tgz", "-C", "/workspace/out"]);
  };
  // A link to elsewhere followed by a file below it: the file must not land outside.
  await extract([
    { header: { name: "link", size: 0, type: "symlink", linkname: "/elsewhere" } },
    { header: { name: "link/escaped.txt", size: 1, type: "file" }, body: "x" },
  ]);
  assertEquals(await env.exists("/elsewhere/escaped.txt", context), { ok: true, value: false });
  // The hardened profile allows 64 MiB per entry; the header is checked before reading.
  const oversized = await extract([
    {
      header: { name: "big.bin", size: 65 * 1024 * 1024, type: "file" },
      body: new Uint8Array(65 * 1024 * 1024),
    },
  ]);
  assertEquals(oversized.exitCode, 2);
  assertStringIncludes(oversized.output, "archive too large");
});
