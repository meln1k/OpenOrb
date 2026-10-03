import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Effect, Stream } from "effect";
import { readDurableView } from "../../../src/harness/durable/storage.ts";
import { conversationMedia } from "../../../src/session/conversation-media.ts";
import { artifactStore, fixtureHarness, memoryGuest, optionsFor, until } from "./helpers.ts";

Deno.test("OpenCode Go requests retain the OpenOrb session routing header across reopen", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness("opencode-go");
  const base = optionsFor(directory);
  const options = { ...base, modelRuntime: { ...base.modelRuntime, model: "opencode-go/test" } };
  const headers: (string | null | undefined)[] = [];
  try {
    for (const requestId of ["first", "reopened"]) {
      fixture.faux.setResponses([(_context, request) => {
        headers.push(request?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("ok");
      }]);
      const opened = await fixture.open(options);
      try {
        await Effect.runPromise(opened.session.submit("hello", requestId));
        await until(() => !opened.session.view.docs["pi.live"]?.run);
      } finally {
        await opened.close();
      }
    }
    assertEquals(headers, [options.sessionId, options.sessionId]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SQLite create/close/reopen retains recoverable work; resume only schedules; abort withdraws follow-ups", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const started = Promise.withResolvers<void>();
  fixture.faux.setResponses([(_context, options) => {
    started.resolve();
    return new Promise((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true })
    );
  }]);
  let opened = await fixture.open(optionsFor(directory));
  try {
    const submissionId = await Effect.runPromise(opened.session.submit("first", "request-one"));
    await started.promise;
    assert(Number.isSafeInteger(submissionId) && submissionId >= 0);
    const follow = await Effect.runPromise(opened.session.submit("second", "request-two"));
    assertNotEquals(follow, submissionId);
    assertEquals(
      await Effect.runPromise(opened.session.submit("ignored duplicate", "request-one")),
      submissionId,
    );
    await opened.close();
    const offline = await readDurableView(directory);
    assert(offline.docs["pi.live"]?.run);
    assertEquals((await Deno.stat(`${directory}/harness.sqlite`)).mode! & 0o777, 0o600);
    assertFalse(
      new TextDecoder().decode(await Deno.readFile(`${directory}/harness.sqlite`)).includes(
        "private-test-credential",
      ),
    );
    const before = fixture.faux.state.callCount;
    opened = await fixture.open(optionsFor(directory));
    assertEquals(fixture.faux.state.callCount, before);
    assertEquals(
      await Effect.runPromise(opened.session.submit("duplicate", "request-one")),
      submissionId,
    );
    assertEquals(
      await Effect.runPromise(opened.session.submit("duplicate follow-up", "request-two")),
      follow,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(fixture.faux.state.callCount, before);
    fixture.faux.setResponses([
      fauxAssistantMessage("recovered"),
      fauxAssistantMessage("follow-up answer"),
    ]);
    await Effect.runPromise(opened.session.resume);
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertStringIncludes(JSON.stringify(opened.session.view), "recovered");
    assertEquals(opened.session.view.entries.filter((entry) => entry.kind === "pi.user").length, 2);
    assertFalse(JSON.stringify(opened.session.view).includes("duplicate"));
    await opened.close();
    assertFalse((await readDurableView(directory)).docs["pi.live"]?.run);
    opened = await fixture.open(optionsFor(directory));
    fixture.faux.setResponses([
      (_context, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          })
        ),
    ]);
    await Effect.runPromise(opened.session.submit("abort me", "request-three"));
    await Effect.runPromise(opened.session.submit("withdraw me", "request-four"));
    await Effect.runPromise(opened.session.abort);
    assertFalse(opened.session.view.docs["pi.live"]?.run);
    assertEquals(opened.session.view.docs["pi.inbox"]?.items, []);
    await opened.close();
    opened = await fixture.open(optionsFor(directory));
    const calls = fixture.faux.state.callCount;
    await Effect.runPromise(opened.session.resume);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(fixture.faux.state.callCount, calls);
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("model generation and host environment control never wait for guest readiness", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  let guestCalls = 0;
  const unavailable = {
    ...guest.environment,
    readFile: () => {
      guestCalls++;
      return Effect.never;
    },
    access: () => {
      guestCalls++;
      return Effect.never;
    },
  };
  let controls = 0;
  const options = {
    ...optionsFor(directory, unavailable),
    environmentState: "starting" as const,
    environmentStates: Stream.make("starting" as const),
    controlEnvironment: () => {
      controls++;
      return Effect.succeed({ state: "stopped" as const, forced: false });
    },
  };
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("environment", { action: "stop" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("still conversing"),
  ]);
  const opened = await fixture.open(options);
  try {
    const initial = await Effect.runPromise(
      opened.session.views.pipe(Stream.take(1), Stream.runCollect),
    );
    assertEquals(initial[0], opened.session.view);
    await Effect.runPromise(opened.session.submit("stop guest", "control"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertEquals(controls, 1);
    assertEquals(guestCalls, 0);
    assertStringIncludes(JSON.stringify(opened.session.view), "still conversing");
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("input, provider responses, and split guest output persist unchanged across credential rotation", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  const oldSecret = "private-test-credential";
  const newSecret = "rotated-provider-credential";
  const options = optionsFor(directory, {
    ...guest.environment,
    runShell: (_command, options) =>
      Effect.gen(function* () {
        yield* options.onOutput(new TextEncoder().encode(`output ${oldSecret.slice(0, 9)}`));
        yield* options.onOutput(new TextEncoder().encode(`${oldSecret.slice(9)} ${newSecret} 🙂`));
        return { exitCode: 0 };
      }).pipe(Effect.orDie),
  });
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "guest", timeout: 10 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(`provider echoed ${oldSecret} and ${newSecret}`),
  ]);
  let opened = await fixture.open(options);
  try {
    await Effect.runPromise(
      opened.session.updateModelRuntime({
        ...options.modelRuntime,
        credential: { type: "api_key", value: newSecret },
      }),
    );
    const thinking = await Effect.runPromise(opened.session.setThinkingLevel("high"));
    assertEquals(thinking, "high");
    await Effect.runPromise(
      opened.session.submit(`inspect ${oldSecret} ${newSecret}`, "unchanged"),
    );
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    const live = JSON.stringify(opened.session.view);
    for (
      const content of [
        `inspect ${oldSecret} ${newSecret}`,
        `output ${oldSecret} ${newSecret} 🙂`,
        `provider echoed ${oldSecret} and ${newSecret}`,
      ]
    ) assertStringIncludes(live, content);
    assertFalse(live.includes("[REDACTED]"));
    await opened.close();
    const offline = JSON.stringify(await readDurableView(directory));
    assertStringIncludes(offline, `output ${oldSecret} ${newSecret} 🙂`);
    assertStringIncludes(offline, `provider echoed ${oldSecret} and ${newSecret}`);
    opened = await fixture.open(options);
    assertEquals(opened.session.view.docs["pi.agent"]?.thinkingLevel, "high");
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("distinct submissions keep their own IDs and stable retries across generation boundaries", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const firstAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const secondStarted = Promise.withResolvers<void>();
  fixture.faux.setResponses([
    () => firstAnswer.promise,
    (_context, options) => {
      secondStarted.resolve();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      );
    },
  ]);
  const opened = await fixture.open(optionsFor(directory));
  try {
    const first = await Effect.runPromise(opened.session.submit("one", "one"));
    const second = await Effect.runPromise(opened.session.submit("two", "two"));
    firstAnswer.resolve(fauxAssistantMessage("first answer"));
    await secondStarted.promise;
    const third = await Effect.runPromise(opened.session.submit("three", "three"));
    assertEquals(new Set([first, second, third]).size, 3);
    for (
      const [requestId, expected] of [["one", first], ["two", second], ["three", third]] as const
    ) {
      assertEquals(
        await Effect.runPromise(opened.session.submit("duplicate", requestId)),
        expected,
      );
    }
    assertEquals(opened.session.view.entries.filter((entry) => entry.kind === "pi.user").length, 2);
    assertFalse(JSON.stringify(opened.session.view).includes("duplicate"));
    await Effect.runPromise(opened.session.abort);
  } finally {
    firstAnswer.resolve(fauxAssistantMessage("cleanup"));
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Durable read and readImage persist tool results while browser projection removes inline images", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  guest.files.set("/workspace/text.txt", new TextEncoder().encode("guest text"));
  guest.files.set("/workspace/image.gif", new TextEncoder().encode("GIF89a"));
  const options = optionsFor(directory, guest.environment);
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "text.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readImage", { path: "image.gif" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const opened = await fixture.open(options);
  try {
    await Effect.runPromise(opened.session.submit("inspect files", "read-files"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    const view = opened.session.view;
    const results = view.entries.flatMap((entry) => entry.model ?? []).filter((message) =>
      message.role === "toolResult"
    );
    assertEquals(results.length, 2);
    assertEquals(results.map((result) => result.isError), [false, false]);
    assertEquals(results[0]?.content, [{ type: "text", text: "guest text" }]);
    assertEquals(results[1]?.content[1], {
      type: "image",
      mimeType: "image/gif",
      data: "R0lGODlh",
    });
    const projected = await Effect.runPromise(
      conversationMedia(options.sessionId, artifactStore)(view),
    );
    assertFalse(JSON.stringify(projected).includes("R0lGODlh"));
    assertStringIncludes(JSON.stringify(projected), "artifactId");
    assertStringIncludes(JSON.stringify(view), "R0lGODlh");
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("blank request IDs reject before admission or scheduling", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const opened = await fixture.open(optionsFor(directory));
  try {
    for (const requestId of ["", " \t\n"]) {
      await assertRejects(() =>
        Effect.runPromise(opened.session.submit("not admitted", requestId))
      );
    }
    assertEquals(fixture.faux.state.callCount, 0);
    assertEquals(opened.session.view.entries, []);
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});
