import { assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name: "new session composer accepts typing and selection changes",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const uiHref = await assetServer.getHref(import.meta.resolve("remix/ui"));
    const jsxHref = await assetServer.getHref(import.meta.resolve("remix/ui/jsx-runtime"));
    const html = `<!doctype html><html><body>
      <button command="show-modal" commandfor="composer">New session</button>
      <div id="app"></div>
      <script type="module">
        import { createRoot } from ${JSON.stringify(uiHref)};
        import { jsx } from ${JSON.stringify(jsxHref)};
        import { SessionComposer } from "/assets/app/ui/session-composer.tsx";
        const root = createRoot(document.getElementById("app"));
        globalThis.renderComposer = (autoOpen = false) => root.render(jsx(SessionComposer, {
          dialogId: "composer", csrfToken: "test-csrf", autoOpen,
          hasConnectedRunner: false, hasConfiguredRunner: false,
          projects: [
            { id: "first", name: "First", defaultRef: "main" },
            { id: "second", name: "Second", defaultRef: "main" }
          ],
          models: [
            { id: "first-model", name: "First", providerName: "Test" },
            { id: "second-model", name: "Second", providerName: "Test" }
          ]
        }));
        globalThis.renderComposer(new URL(location.href).searchParams.has("autoOpen"));
      </script></body></html>`;
    const server = await createTestServer(async (request) => {
      if (new URL(request.url).pathname.startsWith("/assets/")) {
        return await assetServer.fetch(request) ?? new Response(null, { status: 404 });
      }
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });
    try {
      await page.goto(server.baseUrl.href);
      await page.locator("#composer").waitFor({ state: "attached" });
      await page.getByRole("button", { name: "New session", exact: true }).click();
      const prompt = page.getByRole("textbox", { name: "Initial prompt" });
      assertEquals(await prompt.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.type("Write a regression test");
      assertEquals(await prompt.inputValue(), "Write a regression test");
      await prompt.press("Shift+Enter");
      await page.keyboard.type("and keep this draft");
      const draft = "Write a regression test\nand keep this draft";
      assertEquals(await prompt.inputValue(), draft);
      for (
        const [name, value] of [
          ["projectId", "second"],
          ["model", "second-model"],
          ["orbSize", "large"],
        ] as const
      ) {
        const select = page.locator(`select[name="${name}"]`);
        await select.selectOption(value);
        assertEquals(await select.inputValue(), value);
      }
      await page.getByRole("button", { name: "Close new session" }).click();
      await page.evaluate("globalThis.renderComposer()");
      await page.getByRole("button", { name: "New session", exact: true }).click();
      assertEquals(await prompt.inputValue(), draft);
      assertEquals(await page.locator('select[name="projectId"]').inputValue(), "second");
      assertEquals(await page.locator('select[name="model"]').inputValue(), "second-model");
      assertEquals(await page.locator('select[name="orbSize"]').inputValue(), "large");
      assertEquals(await page.getByRole("button", { name: "Start session" }).isDisabled(), true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(new URL("?autoOpen", server.baseUrl).href);
      await prompt.waitFor({ state: "visible" });
      await page.keyboard.type("Mobile auto-open draft");
      assertEquals(await prompt.inputValue(), "Mobile auto-open draft");
      assertEquals(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
});
