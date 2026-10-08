import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openDurableStorage } from "../../../src/harness/durable/storage.ts";
import { fixtureHarness, memoryGuest, optionsFor, until } from "./helpers.ts";

Deno.test("abort crosses durable background boundaries, including unavailable task definitions", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const storage = await openDurableStorage(directory);
    const seed = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const root = await seed.root(BACKGROUND_CONTEXT);
    const task = defineTask<Record<string, never>, { phase: "work" }, null>({
      name: "test.background",
      version: 1,
      initial: () => ({ phase: "work" }),
      phases: { work: (_task, runtime, context) => runtime.sleep(Date.now() + 100000, context) },
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    const id = await root.commit(
      (tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" }, background: true }),
      BACKGROUND_CONTEXT,
    );
    await seed.close(BACKGROUND_CONTEXT);
    const opened = await fixtureHarness().open(optionsFor(directory));
    await Effect.runPromise(opened.session.abort);
    await opened.close();
    const inspect = await openDurableStorage(directory);
    const record = await inspect.task(id, BACKGROUND_CONTEXT);
    assertEquals(record?.state.status, "terminal");
    assertEquals(record?.abortRequested, true);
    await inspect.close(BACKGROUND_CONTEXT);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("close cancels guest IO but never replays an interrupted side-effect tool after reopen", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  let executions = 0;
  let signal: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  const options = optionsFor(directory, {
    ...guest.environment,
    runShell: (_command, options) => {
      executions++;
      signal = options.signal;
      started.resolve();
      return Effect.never;
    },
  });
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "side-effect", timeout: 60 }), {
      stopReason: "toolUse",
    }),
  ]);
  let opened = await fixture.open(options);
  try {
    await Effect.runPromise(opened.session.submit("do work", "unsafe"));
    await started.promise;
    await opened.close();
    assert(signal?.aborted);
    fixture.faux.setResponses([
      fauxAssistantMessage("I will not repeat the interrupted operation"),
    ]);
    opened = await fixture.open(options);
    await Effect.runPromise(opened.session.resume);
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertEquals(executions, 1);
    assertStringIncludes(JSON.stringify(opened.session.view), "may have partially run");
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("bash tool retains bounded output in persisted live and result views", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  const options = optionsFor(directory, {
    ...guest.environment,
    runShell: (_command, options) =>
      options.onOutput(new TextEncoder().encode("x".repeat(200000)), "stdout").pipe(
        Effect.as({ exitCode: 0 }),
        Effect.orDie,
      ),
  });
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "large output", timeout: 10 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const opened = await fixture.open(options);
  try {
    await Effect.runPromise(opened.session.submit("output", "bounds"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    const view = JSON.stringify(opened.session.view);
    assertFalse(view.includes("x".repeat(60 * 1024)));
    assertStringIncludes(view, "x".repeat(1000));
    assertStringIncludes(view, "truncat");
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});
