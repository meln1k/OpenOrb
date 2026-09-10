import { assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name: "mobile sidebar stays engaged during a diagonal horizontal swipe",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const uiHref = await assetServer.getHref(import.meta.resolve("remix/ui"));
    const jsxHref = await assetServer.getHref(import.meta.resolve("remix/ui/jsx-runtime"));
    const html = `<!doctype html><html><body><div id="app"></div>
      <script type="module">
        import { createRoot } from ${JSON.stringify(uiHref)};
        import { jsx, jsxs } from ${JSON.stringify(jsxHref)};
        import {
          SidebarLayout,
          SidebarMobile,
        } from "/assets/app/ui/components/sidebar.tsx";

        createRoot(document.getElementById("app")).render(
          jsxs(SidebarLayout, {
            children: [
              jsx(SidebarMobile, {
                id: "mobile-sidebar",
                children: jsx("nav", { style: { padding: "16px" }, children: "Navigation" }),
              }),
              jsx("main", {
                style: { minHeight: "2000px", padding: "24px 24px 24px 330px" },
                children: "Content",
              }),
            ],
          }),
        );
      </script></body></html>`;
    const server = await createTestServer(async (request) => {
      if (new URL(request.url).pathname.startsWith("/assets/")) {
        return await assetServer.fetch(request) ?? new Response(null, { status: 404 });
      }
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });

    try {
      await page.goto(server.baseUrl.href);
      const sidebar = page.locator("#mobile-sidebar");
      await sidebar.waitFor({ state: "attached" });
      await page.waitForFunction(() =>
        getComputedStyle(document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!)
          .touchAction.includes("pan-y")
      );

      const session = await context.newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 20, y: 400 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 30, y: 404 }],
      });
      assertEquals(await sidebar.getAttribute("data-swipe"), "dragging");

      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 90, y: 475 }],
      });
      await page.waitForTimeout(50);
      assertEquals(await sidebar.getAttribute("data-swipe"), "dragging");

      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 280, y: 520 }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() =>
        document.querySelector("#mobile-sidebar")?.getAttribute("data-swipe") === "open"
      );
      assertEquals(await sidebar.evaluate((element) => element.matches(":popover-open")), true);

      const screenshot = Deno.env.get("OPENORB_SIDEBAR_SCREENSHOT");
      if (screenshot !== undefined) await page.screenshot({ path: screenshot });

      await sidebar.evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Sidebar is not an HTML element.");
        element.hidePopover();
      });
      await page.waitForFunction(() =>
        !document.querySelector("#mobile-sidebar")?.hasAttribute("data-swipe")
      );
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 200, y: 700 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 200, y: 500 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 200, y: 200 }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => globalThis.scrollY > 0);
      assertEquals(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
});
