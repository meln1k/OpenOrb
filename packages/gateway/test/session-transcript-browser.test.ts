import { assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";

// Resolve openorb.test to 127.0.0.1 in /etc/hosts or Chromium's host-resolver rules.
// Start agent-browser, then run:
// OPENORB_BROWSER_TEST_CDP="$(agent-browser get cdp-url)" deno task test:browser
// The non-loopback HTTP origin exercises a genuinely insecure browser context.
const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name: "HTTP browser preserves live transcript interaction state across session switches",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const prompts: string[] = [];
    const thinkingLevels: Array<string | null> = [];
    const thinkingLevelChanges: string[] = [];
    const csrfTokens: string[] = [];
    const sessionId = "browser-session";
    const switchedSessionId = "switched-session";
    const messagePath = routes.app.sessions.message.href({ sessionId });
    const thinkingLevelPath = routes.app.sessions.thinkingLevel.href({ sessionId });
    const eventsPath = routes.api.sessions.events.href({ sessionId });
    const switchedEventsPath = routes.api.sessions.events.href({ sessionId: switchedSessionId });
    let events: ReadableStreamDefaultController<Uint8Array> | undefined;
    let switchedEvents: ReadableStreamDefaultController<Uint8Array> | undefined;
    const switchedConnection = Promise.withResolvers<void>();
    let acknowledge: (() => void) | undefined;
    let received = Promise.withResolvers<void>();
    let thinkingLevelAcknowledgement: PromiseWithResolvers<void> | undefined;
    const uiHref = await assetServer.getHref(
      import.meta.resolve("remix/ui"),
    );
    const jsxHref = await assetServer.getHref(
      import.meta.resolve("remix/ui/jsx-runtime"),
    );
    const importMap = await assetServer.getImportMap([
      import.meta.resolve("remix/ui"),
      import.meta.resolve("remix/ui/jsx-runtime"),
      "packages/gateway/app/ui/session/session-page-controller.tsx",
      "packages/gateway/app/ui/session/session-transcript.tsx",
    ]);
    const importMapJson = JSON.stringify(importMap).replaceAll("<", "\\u003c");
    const html =
      `<!doctype html><html><head><script type="importmap">${importMapJson}</script></head><body><button type="button">Outside transcript</button><div id="app"></div>
      <script type="module">
        import { createRoot, Fragment } from ${JSON.stringify(uiHref)};
        import { jsx } from ${JSON.stringify(jsxHref)};
        import { SessionPageScope } from "/assets/app/ui/session/session-page-controller.tsx";
        import { SessionTranscript } from "/assets/app/ui/session/session-transcript.tsx";
        const root = createRoot(document.getElementById("app"));
        globalThis.renderSession = (sessionId) => root.render(jsx(Fragment, {
          children: jsx(SessionPageScope, {
            csrfToken: "browser-csrf", initialState: "ready", initialIssues: [],
            sessionId,
            children: jsx(SessionTranscript, {
              csrfToken: "browser-csrf", sessionId, contextWindow: 1000,
              thinkingLevels: ["off", "minimal", "low", "medium", "high"]
            })
          }, sessionId)
        }));
        globalThis.renderSession("browser-session");
      </script></body></html>`;
    const server = await createTestServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/assets/")) {
        return await assetServer.fetch(request) ?? new Response(null, { status: 404 });
      }
      if (path === eventsPath) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
            cancel() {
              events = undefined;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === switchedEventsPath) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              switchedEvents = controller;
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
              switchedConnection.resolve();
            },
            cancel() {
              switchedEvents = undefined;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === messagePath && request.method === "POST") {
        const body = await request.formData();
        prompts.push(String(body.get("prompt")));
        thinkingLevels.push(body.get("thinkingLevel")?.toString() ?? null);
        csrfTokens.push(String(body.get("_csrf")));
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
          received.resolve();
        });
        return prompts.length <= 2
          ? Response.json({ error: "Runner rejected this test prompt." }, { status: 409 })
          : Response.json({ status: "accepted" });
      }
      if (path === thinkingLevelPath && request.method === "POST") {
        const body = await request.formData();
        const level = String(body.get("thinkingLevel"));
        thinkingLevelChanges.push(level);
        await thinkingLevelAcknowledgement?.promise;
        return Response.json({ status: "accepted", level }, { status: 202 });
      }
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });

    try {
      const url = new URL(server.baseUrl);
      url.hostname = "openorb.test";
      await page.goto(url.href);
      assertEquals(await page.evaluate(() => globalThis.isSecureContext), false);
      assertEquals(await page.evaluate(() => crypto.randomUUID === undefined), true);
      const input = page.getByRole("textbox", { name: "Continue session" });
      const send = page.getByRole("button", { name: "Send prompt" });
      const outside = page.getByRole("button", { name: "Outside transcript" });
      const messages = page.locator('[data-conversation-entry][data-role="user"]');
      const thinkingLevelColors = [
        ["off", "rgb(157, 157, 157)"],
        ["minimal", "rgb(255, 255, 255)"],
        ["low", "rgb(30, 255, 0)"],
        ["medium", "rgb(0, 112, 221)"],
        ["high", "rgb(163, 53, 238)"],
      ] as const;
      await outside.focus();
      for (const [level, borderColor] of thinkingLevelColors) {
        const thinkingLevelResponse = page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === thinkingLevelPath
        );
        await page.keyboard.press("Shift+Tab");
        await thinkingLevelResponse;
        await page.waitForFunction(
          (level) =>
            document.querySelector(`span[data-thinking-level="${level}"]`)?.textContent === level,
          level,
        );
        assertEquals(
          await page.locator(`span[data-thinking-level="${level}"]`).textContent(),
          level,
        );
        await page.waitForFunction(
          ({ level, borderColor }) => {
            const form = document.querySelector(`form[data-thinking-level="${level}"]`);
            return form !== null && getComputedStyle(form).borderTopColor === borderColor;
          },
          { level, borderColor },
        );
        assertEquals(
          await page.locator(`form[data-thinking-level="${level}"]`).evaluate((form) =>
            getComputedStyle(form).borderTopColor
          ),
          borderColor,
        );
        assertEquals(await outside.evaluate((element) => element === document.activeElement), true);
      }
      assertEquals(
        thinkingLevelChanges,
        ["off", "minimal", "low", "medium", "high"],
      );
      await input.focus();
      for (const method of ["Enter", "click"]) {
        // Keep the same text so distinct failed and pending entries must coexist.
        await input.fill("HTTP continuation");
        const request = page.waitForRequest(
          (request) =>
            request.method() === "POST" && new URL(request.url()).pathname === messagePath,
          { timeout: 5000 },
        );
        if (method === "Enter") await input.press("Enter");
        else await send.click();
        await request;
        await received.promise;
        received = Promise.withResolvers<void>();
        await page.waitForFunction(() =>
          document.querySelector('[data-delivery="pending"]') !== null
        );
        assertEquals(await input.inputValue(), "");
        assertEquals(await send.isDisabled(), true);
        assertEquals(await messages.count(), method === "Enter" ? 1 : 2);
        acknowledge?.();
        await page.waitForFunction(() =>
          document.querySelector('[data-delivery="pending"]') === null &&
          document.querySelector('[data-delivery="failed"]') !== null
        );
      }
      assertEquals(await messages.count(), 2);
      assertEquals(await messages.locator('[role="alert"]').allTextContents(), [
        "Runner rejected this test prompt.",
        "Runner rejected this test prompt.",
      ]);
      await input.fill("Accepted HTTP continuation");
      await send.click();
      await received.promise;
      acknowledge?.();
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="Send prompt"]:enabled') !== null
      );
      assertEquals(await messages.count(), 3);
      events!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({
            type: "user.message",
            messageId: "durable-message",
            text: "Accepted HTTP continuation",
          })
        }\n\n`,
      ));
      await page.waitForFunction(() =>
        document.querySelector('[data-delivery="pending"]') === null
      );
      assertEquals(await messages.count(), 3);
      assertEquals(await messages.last().textContent(), "Accepted HTTP continuation");
      assertEquals(prompts, [
        "HTTP continuation",
        "HTTP continuation",
        "Accepted HTTP continuation",
      ]);
      assertEquals(csrfTokens, ["browser-csrf", "browser-csrf", "browser-csrf"]);
      assertEquals(thinkingLevels, [null, null, null]);

      thinkingLevelAcknowledgement = Promise.withResolvers<void>();
      const delayedThinkingLevelResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === thinkingLevelPath
      );
      await input.press("Shift+Tab");
      await page.waitForFunction(() =>
        document.querySelector('span[data-thinking-level="off"]') !== null
      );
      events!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({ type: "thinking-level.changed", level: "off" })
        }\n\n`,
      ));
      await page.waitForFunction(() =>
        document.querySelector('span[data-thinking-level="off"]')?.textContent === "off"
      );
      thinkingLevelAcknowledgement.resolve();
      await delayedThinkingLevelResponse;
      thinkingLevelAcknowledgement = undefined;
      assertEquals(
        await page.locator('span[data-thinking-level="off"]').textContent(),
        "off",
      );

      events!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({ type: "session.state", stage: "stopped", issues: [] })
        }\n\n`,
      ));
      await page.locator('[data-session-state="stopped"]').waitFor();
      await input.press("Shift+Tab");
      assertEquals(
        await page.locator('span[data-thinking-level="minimal"]').textContent(),
        "minimal",
      );
      assertEquals(thinkingLevelChanges, ["off", "minimal", "low", "medium", "high", "off"]);
      received = Promise.withResolvers<void>();
      await input.fill("Wake with draft thinking");
      await send.click();
      await received.promise;
      acknowledge?.();
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="Send prompt"]:enabled') !== null
      );
      assertEquals(prompts.at(-1), "Wake with draft thinking");
      assertEquals(thinkingLevels.at(-1), "minimal");

      for (
        const event of [
          { type: "session.state", stage: "running", issues: [] },
          {
            type: "tool.started",
            toolCallId: "streaming-tool",
            toolName: "bash",
            arguments: JSON.stringify({ command: "printf tool-output" }),
          },
          {
            type: "tool.completed",
            toolCallId: "streaming-tool",
            toolName: "bash",
            result: "tool-output",
            isError: false,
          },
        ]
      ) {
        events!.enqueue(new TextEncoder().encode(
          `event: session\ndata: ${JSON.stringify(event)}\n\n`,
        ));
      }
      const toolDetails = page.locator('[data-tool-call-id="streaming-tool"] details');
      await toolDetails.getByText("printf tool-output").waitFor();
      await toolDetails.locator("summary").click();
      assertEquals(
        await toolDetails.evaluate((details) =>
          details instanceof HTMLDetailsElement && details.open
        ),
        true,
      );
      events!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({
            type: "assistant.text.delta",
            delta: "Streaming after the tool",
          })
        }\n\n`,
      ));
      await page.getByText("Streaming after the tool").waitFor();
      assertEquals(
        await toolDetails.evaluate((details) =>
          details instanceof HTMLDetailsElement && details.open
        ),
        true,
      );
      await toolDetails.locator("summary").click();
      events!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({
            type: "assistant.text.delta",
            delta: " and after closing it",
          })
        }\n\n`,
      ));
      await page.getByText("Streaming after the tool and after closing it").waitFor();
      assertEquals(
        await toolDetails.evaluate((details) =>
          details instanceof HTMLDetailsElement && details.open
        ),
        false,
      );

      await page.evaluate("globalThis.renderSession('switched-session')");
      const connectionTimeout = setTimeout(
        () => switchedConnection.reject(new Error("The switched session did not connect.")),
        5000,
      );
      await switchedConnection.promise;
      clearTimeout(connectionTimeout);
      switchedEvents!.enqueue(new TextEncoder().encode(
        `event: session\ndata: ${
          JSON.stringify({
            type: "user.message",
            messageId: "switched-message",
            text: "Switched session transcript",
          })
        }\n\n`,
      ));
      await page.getByText("Switched session transcript").waitFor();
      assertEquals(await messages.allTextContents(), ["Switched session transcript"]);
      assertEquals(errors, []);
    } finally {
      acknowledge?.();
      events?.close();
      switchedEvents?.close();
      await context.close();
      await browser.close();
      await server.close();
      if (errors.length > 0) console.error("Browser errors:", errors);
    }
  },
});
