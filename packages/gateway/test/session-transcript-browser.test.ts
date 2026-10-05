import { assertEquals } from "@std/assert";
import type { JsonObject } from "@earendil-works/pi-durable";
import { assetServer } from "@/app/assets.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";

// OPENORB_BROWSER_TEST_CDP="$(agent-browser --session durable-ui get cdp-url)" deno task test <this-file>
const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name:
    "browser wakes on page entry, applies atomic Durable frames, and keeps command receipts independent",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sessionId = "browser-session";
    const commands: string[] = [];
    const artifactId = "01989d78-65ee-8f6a-a97e-0f16ad134c10";
    const artifactPath = routes.api.sessions.artifact.href({ sessionId, artifactId });
    let imageReads = 0;
    let events: ReadableStreamDefaultController<Uint8Array> | undefined;
    let releaseCommand = Promise.withResolvers<void>();
    const uiHref = await assetServer.getHref(import.meta.resolve("remix/component"));
    const jsxHref = await assetServer.getHref(import.meta.resolve("remix/component/jsx-runtime"));
    const importMap = await assetServer.getImportMap([
      import.meta.resolve("remix/component"),
      import.meta.resolve("remix/component/jsx-runtime"),
      "packages/gateway/app/actions/sessions/public/session-page-controller.tsx",
      "packages/gateway/app/actions/sessions/public/session-transcript.tsx",
      "packages/gateway/app/actions/sessions/public/session-vm-control.tsx",
    ]);
    const html = `<!doctype html><html><head><script type="importmap">${
      JSON.stringify(importMap).replaceAll("<", "\\u003c")
    }</script>
      <style>body{margin:0;font-family:system-ui;color:#171717;background:#fafafa;--background:#fafafa;--foreground:#171717;--muted:#f1f1f1;--muted-foreground:#737373;--border:#ddd;--destructive:#dc2626;--ring:#737373;--radius-md:6px;--radius-lg:8px;--font-mono:monospace}#app{max-width:980px;margin:24px auto;display:flex;flex-direction:column;height:calc(100vh - 48px);gap:20px}</style>
      </head><body><main id="app"></main><script type="module">
      import { createRoot, Fragment } from ${JSON.stringify(uiHref)};
      import { jsx } from ${JSON.stringify(jsxHref)};
      import { SessionPageScope } from "/assets/app/actions/sessions/public/session-page-controller.tsx";
      import { SessionTranscript } from "/assets/app/actions/sessions/public/session-transcript.tsx";
      import { SessionVmControl } from "/assets/app/actions/sessions/public/session-vm-control.tsx";
      const root = createRoot(document.getElementById("app"));
      globalThis.renderSession = (sessionId, initial = {}) => root.render(jsx(Fragment, {children:jsx(SessionPageScope, {
        csrfToken:"browser-csrf",sessionId,initialState:"stopped",initialAgentState:"paused",initialEnvironmentState:"stopped",initialIssues:[],...initial,
        children:jsx(Fragment,{children:[jsx(SessionVmControl,{csrfToken:"browser-csrf",sessionId}),jsx(SessionTranscript,{csrfToken:"browser-csrf",sessionId,contextWindow:1000,initialThinkingLevel:"high",thinkingLevels:["off","minimal","low","medium","high"]})]})
      },sessionId)}));
      globalThis.renderSession("browser-session");</script></body></html>`;
    const frame = (event: JsonObject) =>
      events!.enqueue(
        new TextEncoder().encode(`event: session\ndata: ${JSON.stringify(event)}\n\n`),
      );
    const mounted = (entries: JsonObject[] = [], docs: JsonObject = {}) => ({
      conversation: { id: 0 },
      entries,
      docs,
    });
    const state = (agentState: string, environmentState: string) =>
      frame({
        type: "session.state",
        stage: "running",
        agentState,
        environmentState,
        checkoutState: "available",
        issues: [],
      });
    const server = await createTestServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === artifactPath) {
        imageReads++;
        return new Response(await Deno.readFile(new URL("../../../logo.png", import.meta.url)), {
          headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" },
        });
      }
      if (path.startsWith("/assets/")) {
        return await assetServer.fetch(request) ?? new Response(null, { status: 404 });
      }
      if (path.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
              frame({ type: "conversation.snapshot", view: mounted() });
            },
            cancel() {
              events = undefined;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (request.method === "POST") {
        commands.push(path);
        const body = await request.formData();
        assertEquals(body.get("_csrf"), "browser-csrf");
        if (path.endsWith("/wake")) return Response.json({ status: "accepted" });
        await releaseCommand.promise;
        if (path === routes.app.sessions.message.href({ sessionId })) {
          return Response.json({ error: "Prompt acknowledgement uncertain." }, { status: 503 });
        }
        if (path === routes.app.sessions.thinkingLevel.href({ sessionId })) {
          return Response.json({ level: body.get("thinkingLevel") });
        }
        return Response.json({ error: "Acknowledgement lost; inspect live state." }, {
          status: 503,
        });
      }
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });
    try {
      const initialWake = page.waitForResponse((response) =>
        new URL(response.url()).pathname === routes.api.sessions.wake.href({ sessionId })
      );
      await page.goto(server.baseUrl.href);
      await initialWake;
      assertEquals(commands, [routes.api.sessions.wake.href({ sessionId })]);
      await page.getByRole("button", { name: "Wake", exact: true }).waitFor();
      state("running", "stopped");
      await page.getByRole("button", { name: "Stop Session", exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Continue session" }).waitFor();
      const initial = mounted([
        {
          id: 1,
          conversationId: 0,
          kind: "pi.user",
          model: [{ role: "user", content: "Inspect the repository" }],
        },
        {
          id: 2,
          conversationId: 0,
          kind: "pi.assistant",
          model: [{
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "tool-1",
              name: "bash",
              arguments: { command: "git status" },
            }],
          }],
        },
        {
          id: 3,
          conversationId: 0,
          kind: "pi.tool-result",
          model: [{
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "bash",
            content: [{ type: "text", text: "Working tree clean" }],
            isError: false,
          }],
        },
      ], {
        "pi.live": {
          run: { taskId: 4, inputs: [1] },
          generation: {
            attempt: 1,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Still thinking with the environment stopped" }],
            },
          },
        },
      });
      frame({ type: "conversation.snapshot", view: initial });
      await page.getByText("Still thinking with the environment stopped").waitFor();
      const tool = page.locator('[data-tool-call-id="tool-1"] details');
      await tool.locator("summary").click();
      frame({
        type: "conversation.ops",
        ops: [["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "."]],
      });
      await page.getByText("Still thinking with the environment stopped.", { exact: true })
        .waitFor();
      assertEquals(await tool.getAttribute("open"), "");
      const thinkingResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === routes.app.sessions.thinkingLevel.href({ sessionId })
      );
      await page.getByRole("textbox", { name: "Continue session" }).press("Shift+Tab");
      await page.locator('span[data-thinking-level="off"]').waitFor();
      frame({
        type: "conversation.ops",
        ops: [["s", ["docs", "pi.agent"], { thinkingLevel: "off" }]],
      });
      releaseCommand.resolve();
      await thinkingResponse;
      releaseCommand = Promise.withResolvers<void>();
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) =>
          element.scrollTo({ top: 0, behavior: "instant" })
        );
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: ".amp/in/artifacts/durable-agent-running-environment-stopped.png",
        });
      }

      const stopRequest = page.waitForRequest((request) => request.method() === "POST");
      await page.getByRole("button", { name: "Stop Session", exact: true }).click();
      await stopRequest;
      state("paused", "stopping");
      await page.getByText("Agent: paused · Environment: stopping", { exact: true }).waitFor();
      releaseCommand.resolve();
      await page.getByRole("alert").filter({ hasText: "Acknowledgement lost" }).waitFor();
      assertEquals(commands, [
        routes.api.sessions.wake.href({ sessionId }),
        routes.app.sessions.thinkingLevel.href({ sessionId }),
        routes.app.sessions.stop.href({ sessionId }),
      ]);
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: ".amp/in/artifacts/durable-paused-environment-stopping.png",
        });
      }
      state("paused", "stopped");
      await page.getByRole("button", { name: "Wake", exact: true }).waitFor();
      assertEquals(commands.length, 3);
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() =>
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
        await page.screenshot({ path: ".amp/in/artifacts/durable-paused-wake-narrow.png" });
        await page.setViewportSize({ width: 1280, height: 800 });
      }

      frame({
        type: "conversation.ops",
        ops: [
          ["d", ["docs", "pi.live", "generation"]],
          ["p", ["entries"], 3, 0, [{
            id: 4,
            conversationId: 0,
            kind: "pi.assistant",
            model: [{ role: "assistant", content: [{ type: "text", text: "Final answer" }] }],
          }]],
        ],
      });
      await page.getByText("Final answer", { exact: true }).waitFor();
      assertEquals(await page.locator('[data-role="assistant"]').count(), 1);
      frame({
        type: "conversation.snapshot",
        view: mounted([
          {
            id: 6,
            conversationId: 0,
            kind: "pi.assistant",
            model: [{
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "read-image",
                  name: "readImage",
                  arguments: { path: "/workspace/logo.png" },
                },
              ],
            }],
          },
          {
            id: 7,
            conversationId: 0,
            kind: "pi.tool-result",
            model: [{
              role: "toolResult",
              toolCallId: "read-image",
              toolName: "readImage",
              content: [
                { type: "text", text: "Read image file [image/png]" },
                { type: "image", artifactId },
              ],
            }],
          },
        ]),
      });
      const image = page.getByRole("img", { name: "Image", exact: true });
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        document.querySelector<HTMLImageElement>('img[alt="Image"]')?.naturalWidth === 1614
      );
      assertEquals(await image.getAttribute("src"), artifactPath);
      assertEquals(imageReads, 1);
      assertEquals(await page.getByText("Read image file [image/png]", { exact: true }).count(), 0);
      assertEquals(await page.locator("[data-read-path]").textContent(), "/workspace/logo.png");
      assertEquals(await page.locator("[data-tool-result]").count(), 0);
      assertEquals(commands.length, 3); // Reading media while stopped never wakes the session.
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.locator('[data-slot="message-scroller-item"]').screenshot({
          path: ".amp/in/artifacts/durable-bulk-image.png",
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      await page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) =>
        element.scrollTo({ top: 0, behavior: "instant" })
      );
      assertEquals(
        await image.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
        true,
      );
      assertEquals(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.screenshot({ path: ".amp/in/artifacts/durable-bulk-image-narrow.png" });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      frame({
        type: "conversation.ops",
        ops: [["s", ["entries", 1, "model", 0, "content", 1], {
          type: "image",
          text: "[Image unavailable: media could not be stored]",
        }]],
      });
      await page.getByText("[Image unavailable: media could not be stored]", { exact: true })
        .waitFor();
      assertEquals(await image.count(), 0);
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.getByText("[Image unavailable: media could not be stored]", { exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: ".amp/in/artifacts/durable-bulk-image-unavailable.png" });
      }
      frame({
        type: "conversation.ops",
        ops: [
          ["s", ["entries", 1, "model", 0, "content"], [{
            type: "text",
            text: "readImage requires a PNG, JPEG, GIF, or WebP image",
          }]],
          ["s", ["entries", 1, "model", 0, "isError"], true],
        ],
      });
      await page.getByText("readImage requires a PNG, JPEG, GIF, or WebP image", { exact: true })
        .waitFor();
      assertEquals(await image.count(), 0);
      if (Deno.env.get("OPENORB_BROWSER_SCREENSHOTS")) {
        await page.screenshot({ path: ".amp/in/artifacts/durable-read-image-error.png" });
      }
      frame({
        type: "conversation.snapshot",
        view: mounted([{
          id: 5,
          conversationId: 0,
          kind: "pi.user",
          model: [{ role: "user", content: "Replacement transcript" }],
        }]),
      });
      await page.getByText("Replacement transcript", { exact: true }).waitFor();
      assertEquals(await page.locator('[data-role="assistant"]').count(), 0);

      releaseCommand = Promise.withResolvers<void>();
      const input = page.getByRole("textbox", { name: "Continue session" });
      await input.fill("A recoverable prompt");
      await input.press("Enter");
      await page.locator('[data-delivery="pending"]').waitFor();
      releaseCommand.resolve();
      await page.locator('[data-delivery="failed"]').waitFor();
      assertEquals(await input.inputValue(), "");
      const switchedWake = page.waitForResponse((response) =>
        new URL(response.url()).pathname ===
          routes.api.sessions.wake.href({ sessionId: "switched-session" })
      );
      await page.evaluate(
        "globalThis.renderSession('switched-session', {initialState:'running', initialAgentState:'running'})",
      );
      await switchedWake;
      await page.waitForFunction(() => document.querySelector('[data-delivery="failed"]') === null);
      assertEquals(commands.filter((path) => path.endsWith("/wake")), [
        routes.api.sessions.wake.href({ sessionId }),
        routes.api.sessions.wake.href({ sessionId: "switched-session" }),
      ]);
      assertEquals(errors, []);
    } finally {
      releaseCommand.resolve();
      await context.close();
      await browser.close();
      await server.close();
      if (errors.length) console.error("Browser errors:", errors);
    }
  },
});
