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
  name: "HTTP browser submits distinct optimistic prompts without crypto.randomUUID",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const prompts: string[] = [];
    const csrfTokens: string[] = [];
    const sessionId = "browser-session";
    const messagePath = routes.app.sessions.message.href({ sessionId });
    const eventsPath = routes.api.sessions.events.href({ sessionId });
    let events: ReadableStreamDefaultController<Uint8Array> | undefined;
    let acknowledge: (() => void) | undefined;
    let received = Promise.withResolvers<void>();
    const uiHref = await assetServer.getHref(
      import.meta.resolve("remix/ui"),
    );
    const jsxHref = await assetServer.getHref(
      import.meta.resolve("remix/ui/jsx-runtime"),
    );
    const html = `<!doctype html><html><body><div id="app"></div>
      <script type="module">
        import { createRoot } from ${JSON.stringify(uiHref)};
        import { jsx } from ${JSON.stringify(jsxHref)};
        import { SessionPageScope } from "/assets/app/ui/session/session-page-controller.tsx";
        import { SessionTranscript } from "/assets/app/ui/session/session-transcript.tsx";
        const root = createRoot(document.getElementById("app"));
        root.render(jsx(SessionPageScope, {
          csrfToken: "browser-csrf", initialState: "stopped", initialIssues: [],
          sessionId: "browser-session",
          children: jsx(SessionTranscript, {
            csrfToken: "browser-csrf", sessionId: "browser-session", contextWindow: 1000
          })
        }));
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
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === messagePath && request.method === "POST") {
        const body = await request.formData();
        prompts.push(String(body.get("prompt")));
        csrfTokens.push(String(body.get("_csrf")));
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
          received.resolve();
        });
        return prompts.length <= 2
          ? Response.json({ error: "Runner rejected this test prompt." }, { status: 409 })
          : Response.json({ status: "accepted" });
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
      const messages = page.locator('[data-conversation-entry][data-role="user"]');
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
      assertEquals(errors, []);
    } finally {
      acknowledge?.();
      events?.close();
      await context.close();
      await browser.close();
      await server.close();
      if (errors.length > 0) console.error("Browser errors:", errors);
    }
  },
});
