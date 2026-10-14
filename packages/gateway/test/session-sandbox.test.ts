import { test } from "vite-plus/test";
import { assert, assertEquals, assertObjectMatch, assertStringIncludes } from "@jsr/std__assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Harness } from "@earendil-works/pi-durable";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { DatabaseSync } from "node:sqlite";
import { packTar } from "modern-tar";
import { assertions } from "../../pi-env/test/fixtures.ts";
import {
  sandboxExecutionEnv,
  sandboxProvider,
  type SandboxProviderOptions,
} from "../app/cells/session/environment/sandbox-provider.ts";
import { SANDBOX_WORKER } from "../app/cells/session/environment/sandbox/code.ts";
import type { SandboxSql } from "../app/cells/session/environment/sandbox/persistent-fs.ts";
import type { SandboxRpc } from "../app/cells/session/environment/sandbox/rpc.ts";
import { Sandbox } from "../app/cells/session/environment/sandbox/worker.ts";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import { SessionId, WorkspaceId } from "@openorb/protocol/runner-api";
import { GitAuthor } from "@openorb/protocol/runner-api";
import { Session } from "../app/cells/session/session.ts";
import type { Env } from "../app/env.ts";
import { MemoryStorage } from "./workspace/storage.ts";
import { migrateDurableObjectDatabase } from "../app/cells/migrations.ts";
import { sessionMigrations } from "../app/cells/session/migrations.ts";
import { readRecord, writeRecord } from "../app/cells/session/record.ts";
import type { RunnerEnvironmentApi } from "../app/cells/session/environment/runner-provider.ts";

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
      const rows = database
        .prepare(query)
        .all(...bindings)
        .map((row) => ({ ...row }));
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
  return sandboxExecutionEnv("openorb-sandbox:test", cwd, (work) => work(sandbox));
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
  const result = await env.exec(
    command,
    {
      onOutput: (text) => {
        output += text;
      },
    },
    context,
  );
  assert(result.ok, result.ok ? undefined : result.error.message);
  return { exitCode: result.value.exitCode, output };
}

// The virtual filesystem reports no changes; the sandbox declares watch unsupported.
for (const conformance of createEnvConformance({
  assertions,
  withEnv: async (use) => {
    const env = sandboxEnv();
    const cwd = `/workspace/case-${crypto.randomUUID()}`;
    const created = await env.createDir(cwd, { recursive: true }, context);
    assert(created.ok);
    env.cwd = cwd;
    await use(env);
  },
}).filter((conformance) => !conformance.name.startsWith("watch "))) {
  test(`sandbox ExecutionEnv over its RPC relay: ${conformance.name}`, {}, () => conformance.run());
}

test("the sandbox filesystem survives a restart from its SQLite database", async () => {
  const sql = memorySql();
  const env = sandboxEnv(sql);
  assertEquals(
    (
      await run(
        env,
        [
          "mkdir -p src/nested && echo kept > src/nested/a.txt && echo gone > b.txt",
          "ln -s nested/a.txt src/link && mv b.txt src/moved.txt && rm src/moved.txt",
          "cp -r src copy && chmod 0755 copy/nested/a.txt && echo temporary > /tmp/scratch",
        ].join(" && "),
      )
    ).exitCode,
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

test("sandbox tar unpacks archives without escaping the target directory", async () => {
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
    (
      await run(env, "ls -A /workspace /workspace/checkout; ls /absolute.txt 2>&1 || true")
    ).output.includes("escape.txt"),
    false,
  );
  assertEquals((await run(env, "test -e /absolute.txt || echo safe")).output, "safe\n");
  assertEquals(
    (await run(env, "test -x checkout/bin/run && echo executable")).output,
    "executable\n",
  );
});

test("sandbox commands accept login shells and argv words unparsed", async () => {
  const env = sandboxEnv();
  assertEquals((await run(env, ["/bin/sh", "-lc", "echo login"])).output, "login\n");
  assertEquals(
    (await run(env, ["printf", "%s\\n", "a'b $HOME; touch injected"])).output,
    "a'b $HOME; touch injected\n",
  );
  assertEquals((await run(env, "test -e injected || echo clean")).output, "clean\n");
  assertEquals((await run(env, "curl https://example.com")).exitCode, 127);
});

test("a stopped sandbox fails guest operations immediately and keeps its files", async () => {
  using fixture = providerFixture();
  const { provider } = fixture;
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
  assert((await environment.env.writeFile("/tmp/transient", "gone", context)).ok);
  environment.close();
  assertEquals(environment.state(), "running");
  assertEquals(await environment.env.readTextFile("/workspace/a", context), {
    ok: true,
    value: "kept",
  });
  assertEquals(await environment.env.exists("/tmp/transient", context), { ok: true, value: false });
  await environment.delete();
  assertEquals(environment.state(), "stopped");
});

/** Real provider and sandbox RPC over SQLite, with the runtime's lazy facet factory. */
function providerFixture(wrap: (rpc: SandboxRpc) => SandboxRpc = (rpc) => rpc) {
  const previousCode = SANDBOX_WORKER.code;
  SANDBOX_WORKER.code = "fixture";
  let sql = memorySql();
  let state: EnvironmentState = "stopped";
  let facet: SandboxRpc | undefined;
  let reconcile = () => {};
  const options: SandboxProviderOptions = {
    sessionId: "test",
    state: () => state,
    recordState: (next) => (state = next),
    onIdle: () => reconcile(),
    // SAFETY: fixture supplies the facet and loader methods used by the production provider.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    facets: {
      get: (_name: string, factory: Parameters<DurableObjectFacets["get"]>[1]) => {
        const dispatch = () => {
          if (facet === undefined) {
            factory();
            facet = wrap(openSandbox(sql));
          }
          return facet;
        };
        return {
          file: (...args: Parameters<SandboxRpc["file"]>) => dispatch().file(...args),
          exec: (...args: Parameters<SandboxRpc["exec"]>) => dispatch().exec(...args),
          cancel: (id: string) => dispatch().cancel(id),
        };
      },
      abort: () => (facet = undefined),
      delete: () => (sql = memorySql()),
    } as unknown as DurableObjectFacets,
    // SAFETY: the fake WorkerStub supplies only class acquisition and celld's disposal extension.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    loader: {
      get: () => ({ getDurableObjectClass: () => ({}), dispose: () => {} }),
    } as unknown as WorkerLoader,
  };
  const provider = sandboxProvider(options);
  const binding = {
    workspaceId: WorkspaceId.make(crypto.randomUUID()),
    sessionId: SessionId.make(crypto.randomUUID()),
  };
  return {
    provider,
    facets: options.facets,
    loader: options.loader,
    bind: () => provider.bind(binding),
    reconcile: (callback: () => void) => (reconcile = callback),
    [Symbol.dispose]: () => (SANDBOX_WORKER.code = previousCode),
  };
}

test("sandbox lifecycle is ordered across bindings and deletion cannot be undone", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  using fixture = providerFixture((rpc) => ({
    ...rpc,
    exec: async (...args) => {
      entered.resolve();
      await finish.promise;
      return await rpc.exec(...args);
    },
  }));
  const first = fixture.bind();
  const second = fixture.bind();
  await first.control("start");
  const execution = first.env.exec("echo kept > durable.txt", {}, context);
  await entered.promise;
  const stopped = first.control("stop");
  const started = second.control("start");
  assert(!(await second.env.exists("durable.txt", context)).ok);
  finish.resolve();
  assert((await execution).ok);
  await stopped;
  await started;
  assertEquals(first.state(), "running");
  assertEquals(await second.env.readTextFile("durable.txt", context), {
    ok: true,
    value: "kept\n",
  });

  const restarted = first.control("restart");
  const deleted = second.delete();
  await restarted;
  await deleted;
  await first.control("start");
  assertEquals(second.state(), "stopped");
  assert(!(await first.env.exists("durable.txt", context)).ok);
});

test("idle release waits for cancellation and rechecks activity before retirement", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const execSettled = Promise.withResolvers<void>();
  const finishCancel = Promise.withResolvers<void>();
  using fixture = providerFixture((rpc) => ({
    ...rpc,
    exec: async (...args) => {
      await rpc.file("/workspace", "writeFile", ["/tmp/marker", "live"]);
      entered.resolve();
      await cancelled.promise;
      const result = await rpc.exec(...args);
      execSettled.resolve();
      return result;
    },
    cancel: async () => {
      cancelled.resolve();
      await finishCancel.promise;
    },
  }));
  const environment = fixture.bind();
  await environment.control("start");
  const abort = new AbortController();
  const execution = environment.env.exec(
    "echo done",
    {},
    {
      ...context,
      abortSignal: abort.signal,
    },
  );
  await entered.promise;
  environment.close();
  abort.abort();
  await execSettled.promise;
  assertEquals(await environment.env.readTextFile("/tmp/marker", context), {
    ok: true,
    value: "live",
  });
  const reconciled = Promise.withResolvers<void>();
  fixture.reconcile(() => reconciled.resolve());
  finishCancel.resolve();
  await execution;
  await reconciled.promise;
  // A stale idle observation requests a recheck, not automatic retirement.
  assertEquals(await environment.env.exists("/tmp/marker", context), { ok: true, value: true });
  environment.close();
  assertEquals(await environment.env.exists("/tmp/marker", context), { ok: true, value: false });
});

/** A model-only turn can finish even while provisioning holds the guest readiness gate. */
class ModelOnlySession extends Session {
  protected override agentModels(): Models {
    const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 1_000_000 });
    faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Answered.")));
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
}

function sessionFixture(
  fixture: ReturnType<typeof providerFixture>,
  storage = Object.assign(new MemoryStorage(), { deleteAll: () => Promise.resolve() }),
  runners: Partial<RunnerEnvironmentApi> = {},
) {
  const open = Harness.open;
  const opened = Promise.withResolvers<Harness>();
  Harness.open = async (storage, options, context) => {
    try {
      const harness = await open(storage, options, context);
      opened.resolve(harness);
      return harness;
    } finally {
      Harness.open = open;
    }
  };
  const pending = new Set<Promise<unknown>>();
  const session = new ModelOnlySession(
    {
      storage,
      facets: fixture.facets,
      blockConcurrencyWhile: (callback) => callback(),
      acceptWebSocket: () => {},
      getWebSockets: () => [],
      waitUntil: (promise) => {
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
      },
    },
    // SAFETY: model-only Sessions need only these empty credentials and the supplied runner RPCs.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    {
      WORKSPACE: {
        getByName: () => ({
          getGitHubToken: () => Promise.resolve([null, undefined]),
          getEnvironmentSecrets: () => Promise.resolve([[], undefined]),
        }),
      },
      RUNNERS: { getByName: () => runners },
      MEDIA: {},
      LOADER: fixture.loader,
    } as unknown as Env,
  );
  return {
    session,
    harness: opened.promise,
    storage,
    create: () =>
      session.create({
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        placement: { provider: "sandbox" },
        orbSize: "tiny",
        model: "faux/demo",
        thinkingLevel: "off",
        initialPrompt: "Answer without guest tools.",
      }),
    drain: async () => {
      while (pending.size !== 0) await Promise.all([...pending]);
    },
  };
}

test("concurrent admission persists recovery despite a held idle inspection", async () => {
  using fixture = providerFixture();
  const { session, storage, create, drain, harness: opened } = sessionFixture(fixture);
  await create();
  await drain();
  const harness = await opened;
  const inspect = harness.inspect.bind(harness);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let held = false;
  harness.inspect = async (context) => {
    const snapshot = await inspect(context);
    if (!held) {
      held = true;
      entered.resolve();
      await finish.promise;
    }
    return snapshot;
  };
  using _restore = {
    [Symbol.dispose]: () => {
      harness.inspect = inspect;
      finish.resolve();
    },
  };
  // Alarm delivery consumes the old alarm; every newly accepted input needs another one.
  storage.alarm = null;
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...bindings) => {
    if (query.includes("INSERT INTO submissions")) {
      assert(storage.alarm !== null, "input accepted without a persisted recovery alarm");
    }
    return exec(query, ...bindings);
  };
  const first = session.submit({ prompt: "First", requestId: "first" });
  await entered.promise;
  const second = session.submit({ prompt: "Second", requestId: "second" });
  // Let the second RPC reach admission while the earlier inspection is still held.
  await new Promise((resolve) => setTimeout(resolve, 0));
  finish.resolve();
  const admitted = await Promise.all([first, second]);
  assert(admitted[0]!.submissionId !== admitted[1]!.submissionId);
  await drain();
  assertEquals(storage.rows("SELECT COUNT(*) AS count FROM submissions"), [{ count: 3 }]);
  await session.stop();
  await drain();
});

test("admission during a runner idle stop resumes only after its acknowledgement", async () => {
  using fixture = providerFixture();
  const initial = sessionFixture(fixture);
  await initial.create();
  await initial.drain();
  await initial.session.stop();
  await initial.drain();
  const storage = Object.assign(new MemoryStorage(), { deleteAll: () => Promise.resolve() });
  await migrateDurableObjectDatabase(storage, sessionMigrations);
  writeRecord(storage, {
    ...readRecord(initial.storage)!,
    placement: { provider: "runner", runnerId: crypto.randomUUID() },
    environmentState: "running",
    agentPaused: false,
    lastActivityAt: Date.now() - 16 * 60_000,
  });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const actions: string[] = [];
  const runner = sessionFixture(fixture, storage, {
    controlEnvironment: async ({ payload }) => {
      actions.push(payload.action);
      if (payload.action === "stop") {
        entered.resolve();
        await finish.promise;
      } else {
        assertEquals(
          storage.rows(
            "SELECT json_extract(record, '$.environmentState') AS state FROM openorb_session",
          ),
          [{ state: "stopped" }],
        );
      }
      return {
        status: "accepted",
        acknowledgement: {
          state: payload.action === "stop" ? "stopped" : "running",
          forced: false,
        },
      };
    },
  });
  const alarm = runner.session.alarm();
  await entered.promise;
  await runner.session.submit({ prompt: "Resume", requestId: "resume-during-stop" });
  assertEquals(actions, ["stop"]);
  finish.resolve();
  await alarm;
  await runner.drain();
  assertEquals(actions, ["stop", "start"]);
  assertEquals(runner.session.view()?.environmentState, "running");
  await runner.session.stop();
  await runner.drain();
});

test("idle stop rechecks provisioning that starts during inspection", async () => {
  let holdProvisioning = false;
  const provisioning = Promise.withResolvers<void>();
  const finishProvisioning = Promise.withResolvers<void>();
  using fixture = providerFixture((rpc) => ({
    ...rpc,
    file: async (...args) => {
      if (holdProvisioning && args[1] === "createDir") {
        provisioning.resolve();
        await finishProvisioning.promise;
      }
      return await rpc.file(...args);
    },
  }));
  const test = sessionFixture(fixture);
  await test.create();
  await test.drain();
  const harness = await test.harness;
  const inspect = harness.inspect.bind(harness);
  const inspected = Promise.withResolvers<void>();
  const finishInspection = Promise.withResolvers<void>();
  harness.inspect = async (context) => {
    const snapshot = await inspect(context);
    inspected.resolve();
    await finishInspection.promise;
    return snapshot;
  };
  const now = Date.now;
  Date.now = () => now() + 16 * 60_000;
  using _restore = {
    [Symbol.dispose]: () => {
      Date.now = now;
      harness.inspect = inspect;
      finishInspection.resolve();
      finishProvisioning.resolve();
    },
  };
  const alarm = test.session.alarm();
  await inspected.promise;
  holdProvisioning = true;
  await test.session.retry("retry-provisioning");
  await provisioning.promise;
  finishInspection.resolve();
  // Alarm must finish without starting a stop that waits on the held provisioning RPC.
  await Promise.race([
    alarm,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("idle stop drained active provisioning")),
        5_000,
      );
      void alarm.finally(() => clearTimeout(timer));
    }),
  ]);
  assertEquals(test.session.view()?.environmentState, "running");
  finishProvisioning.resolve();
  await test.drain();
  await test.session.stop();
  await test.drain();
});

test("provisioning completion releases sandbox after a model-only turn", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  using fixture = providerFixture((rpc) => ({
    ...rpc,
    file: async (...args) => {
      if (args[1] === "createDir") {
        await rpc.file("/workspace", "writeFile", ["/tmp/provisioning-marker", "live"]);
        entered.resolve();
        await finish.promise;
      }
      return await rpc.file(...args);
    },
  }));
  const { session, storage, create, drain } = sessionFixture(fixture);
  await create();
  await entered.promise;
  // Wait on observable durable completion, not on the blocked infrastructure operation.
  while (storage.rows("SELECT id FROM submissions WHERE status = 'done'").length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  finish.resolve();
  await drain();
  const guest = fixture.bind();
  await guest.control("start");
  assertEquals(await guest.env.exists("/tmp/provisioning-marker", context), {
    ok: true,
    value: false,
  });
  assertEquals(session.view()?.environmentState, "running");
  await session.stop();
  await drain();
});

test("files larger than one SQLite value survive a restart, appends included", async () => {
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

test("recursive moves and copies write each file to SQLite once", async () => {
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

test("appends store only their new bytes and survive compaction", async () => {
  const written = { bytes: 0 };
  const sql = memorySql(written);
  const env = sandboxEnv(sql);
  assertEquals((await run(env, "for i in $(seq 300); do echo $i >> log.txt; done")).exitCode, 0);
  const expected = Array.from({ length: 300 }, (_, index) => `${index + 1}\n`).join("");
  // Without compaction this is the log's size; each compaction rewrites at most what precedes it.
  assert(written.bytes < 6 * expected.length, `${written.bytes} bytes written`);
  const [rows] = sql
    .exec("SELECT COUNT(*) AS count FROM sandbox_chunks WHERE path = ?", "/workspace/log.txt")
    .toArray();
  assert(Number(rows?.count) <= 65, `${rows?.count} rows`);
  const log = await sandboxEnv(sql).readTextFile("log.txt", context);
  assert(log.ok);
  assertEquals(log.value, expected);
});

test("a reader from before a sandbox restart cannot read another file", async () => {
  const sql = memorySql();
  let sandbox = openSandbox(sql);
  const env = sandboxExecutionEnv("openorb-sandbox:test", "/workspace", (work) => work(sandbox));
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

test("a cancel that overtakes its command still stops it", async () => {
  const sandbox = openSandbox(memorySql());
  sandbox.cancel("early");
  const { result } = await sandbox.exec("early", "/workspace", "echo ran", {});
  assert(!result.ok);
  assertEquals(result.error.code, "aborted");
});

test("sandbox file errors carry their code and path, and joinPath stays pure", async () => {
  const env = sandboxEnv();
  const missing = await env.readTextFile("no/ENOENT-in-name.txt", context);
  assert(!missing.ok);
  assertEquals([missing.error.code, missing.error.path], ["not_found", "no/ENOENT-in-name.txt"]);
  const joined = await env.joinPath(["src", "../lib", "a.ts"], context);
  assert(joined.ok);
  assertEquals(joined.value, "lib/a.ts");
});

test("sandbox tar enforces archive limits and never writes through its own links", async () => {
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
