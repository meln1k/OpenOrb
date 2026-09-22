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
    const importMap = await assetServer.getImportMap([
      import.meta.resolve("remix/ui"),
      import.meta.resolve("remix/ui/jsx-runtime"),
      "packages/gateway/app/ui/session-composer.tsx",
      "packages/gateway/app/ui/components/theme.ts",
    ]);
    const importMapJson = JSON.stringify(importMap).replaceAll("<", "\\u003c");
    const html =
      `<!doctype html><html><head><script type="importmap">${importMapJson}</script><style>:root { --border: #e5e5e5; }</style></head><body>
      <button command="show-modal" commandfor="composer">New session</button>
      <div id="app"></div>
      <script type="module">
        import { createRoot } from ${JSON.stringify(uiHref)};
        import { jsx } from ${JSON.stringify(jsxHref)};
        import { SessionComposer } from "/assets/app/ui/session-composer.tsx";
        import { designSystemStyle } from "/assets/app/ui/components/theme.ts";
        const root = createRoot(document.getElementById("app"));
        globalThis.renderComposer = (autoOpen = false) => root.render(jsx("main", {
          mix: designSystemStyle,
          children: jsx(SessionComposer, {
            dialogId: "composer", csrfToken: "test-csrf", autoOpen,
            hasConnectedRunner: false, hasConfiguredRunner: false,
            projects: [
              { id: "first", name: "First", defaultRef: "main" },
              { id: "second", name: "Second", defaultRef: "main" }
            ],
            models: [
              {
                id: "first-model", name: "First", providerId: "test", providerName: "Test",
                thinkingLevels: ["off", "low", "high", "max"]
              },
              {
                id: "second-model", name: "Second", providerId: "test", providerName: "Test",
                thinkingLevels: ["off", "minimal", "medium"]
              }
            ]
          })
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
      assertEquals(
        await page.locator("#composer form").evaluate((form) =>
          form.hasAttribute("data-rmx-document")
        ),
        true,
      );
      await page.getByRole("button", { name: "New session", exact: true }).click();
      const prompt = page.getByRole("textbox", { name: "Initial prompt" });
      assertEquals(await prompt.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.type("Write a regression test");
      assertEquals(await prompt.inputValue(), "Write a regression test");
      await prompt.press("Shift+Enter");
      await page.keyboard.type("and keep this draft");
      const draft = "Write a regression test\nand keep this draft";
      assertEquals(await prompt.inputValue(), draft);
      const thinkingLevel = page.getByRole("button", { name: "Thinking level" });
      const thinkingLevelInput = page.locator('input[name="thinkingLevel"]');
      const project = page.getByRole("button", { name: "Project" });
      const projectInput = page.locator('input[name="projectId"]');
      const orbSize = page.getByRole("button", { name: "Orb size" });
      const orbSizeInput = page.locator('input[name="orbSize"]');
      const model = page.getByRole("button", { name: "Model" });
      const modelInput = page.locator('input[name="model"]');
      const dialog = page.locator("#composer");
      assertEquals(await orbSizeInput.inputValue(), "medium");
      assertEquals((await orbSize.textContent())?.trim(), "medium");
      assertEquals(await modelInput.inputValue(), "first-model");
      assertEquals((await model.textContent())?.trim(), "First");
      assertEquals(await projectInput.inputValue(), "first");
      assertEquals((await project.textContent())?.trim(), "First");
      assertEquals(await thinkingLevelInput.inputValue(), "high");
      assertEquals((await thinkingLevel.textContent())?.trim(), "High");
      await orbSize.locator("svg").first().click();
      assertEquals(
        await page.getByRole("listbox").evaluate((list) => {
          const trigger = document.querySelector('button[aria-label="Orb size"]')
            ?.getBoundingClientRect();
          const popover = list.parentElement?.getBoundingClientRect();
          return trigger && popover
            ? {
              horizontalOffset: Math.round(popover.left - trigger.left),
              verticalGap: Math.round(popover.top - trigger.bottom),
            }
            : null;
        }),
        { horizontalOffset: 0, verticalGap: 4 },
      );
      assertEquals(
        await page.getByRole("listbox").getByRole("option").allTextContents(),
        [
          "tiny · 1 CPU · 2 GB memory",
          "small · 2 CPUs · 4 GB memory",
          "medium · 4 CPUs · 8 GB memory",
          "large · 8 CPUs · 16 GB memory",
          "xxlarge · 16 CPUs · 32 GB memory",
        ],
      );
      await page.getByRole("option", { name: "large · 8 CPUs · 16 GB memory" }).click();
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="orbSize"]')?.value === "large"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Orb size"]')?.textContent
          ?.trim() === "large"
      );
      assertEquals(await orbSizeInput.inputValue(), "large");
      assertEquals((await orbSize.textContent())?.trim(), "large");
      assertEquals(
        await dialog.locator("form").evaluate((form) =>
          form instanceof HTMLFormElement ? new FormData(form).get("orbSize") : null
        ),
        "large",
      );
      assertEquals(await thinkingLevelInput.inputValue(), "high");
      assertEquals(await dialog.getAttribute("data-thinking-level"), "high");
      assertEquals(
        await dialog.evaluate((element) => getComputedStyle(element).borderTopWidth),
        "2px",
      );
      assertEquals(
        await dialog.evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(163, 53, 238)",
      );
      assertEquals(
        await dialog.locator("[data-thinking-level-option]:not([hidden])").evaluateAll((options) =>
          options.map((option) => option.getAttribute("data-thinking-level-option"))
        ),
        ["off", "low", "high", "max"],
      );
      await prompt.press("Shift+Tab");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "max"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "max");
      assertEquals((await thinkingLevel.textContent())?.trim(), "Max");
      assertEquals(await dialog.getAttribute("data-thinking-level"), "max");
      assertEquals(
        await dialog.evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(230, 204, 128)",
      );
      assertEquals(await prompt.evaluate((element) => element === document.activeElement), true);
      await model.locator("svg").first().click();
      assertEquals(
        await page.getByRole("listbox").evaluate((list) => {
          const trigger = document.querySelector('button[aria-label="Model"]')
            ?.getBoundingClientRect();
          const popover = list.parentElement?.getBoundingClientRect();
          return trigger && popover
            ? {
              horizontalOffset: Math.round(popover.left - trigger.left),
              verticalGap: Math.round(trigger.top - popover.bottom),
            }
            : null;
        }),
        { horizontalOffset: 0, verticalGap: 4 },
      );
      assertEquals(
        await page.getByRole("listbox").getByRole("option").allTextContents(),
        ["Test · First", "Test · Second"],
      );
      await page.getByRole("option", { name: "Test · Second" }).click();
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="model"]')?.value === "second-model"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')?.textContent
          ?.trim() === "Second"
      );
      assertEquals(await modelInput.inputValue(), "second-model");
      assertEquals((await model.textContent())?.trim(), "Second");
      assertEquals(
        await dialog.locator("[data-thinking-level-option]:not([hidden])").evaluateAll((options) =>
          options.map((option) => option.getAttribute("data-thinking-level-option"))
        ),
        ["off", "minimal", "medium"],
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "medium"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "medium");
      assertEquals((await thinkingLevel.textContent())?.trim(), "Medium");
      assertEquals(await dialog.getAttribute("data-thinking-level"), "medium");
      assertEquals(
        await dialog.evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(0, 112, 221)",
      );
      await orbSize.press("Shift+Tab");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "off"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
          ?.textContent
          ?.trim() === "Off"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "off");
      assertEquals(
        await orbSize.evaluate((element) => element === document.activeElement),
        true,
      );
      await project.press("Shift+Tab");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "minimal"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
          ?.textContent
          ?.trim() === "Minimal"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "minimal");
      assertEquals(await project.evaluate((element) => element === document.activeElement), true);
      const close = page.getByRole("button", { name: "Close new session" });
      await close.press("Shift+Tab");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "medium"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
          ?.textContent
          ?.trim() === "Medium"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "medium");
      assertEquals(await close.evaluate((element) => element === document.activeElement), true);
      await project.locator("svg").first().click();
      await page.getByRole("option", { name: "Second" }).click();
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="projectId"]')?.value === "second"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Project"]')?.textContent
          ?.trim() === "Second"
      );
      assertEquals(await projectInput.inputValue(), "second");
      assertEquals((await project.textContent())?.trim(), "Second");
      await thinkingLevel.locator("svg").first().click();
      await page.getByRole("option", { name: "Minimal" }).click();
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>('input[name="thinkingLevel"]')?.value === "minimal"
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
          ?.textContent
          ?.trim() === "Minimal"
      );
      assertEquals(await thinkingLevelInput.inputValue(), "minimal");
      assertEquals(await dialog.getAttribute("data-thinking-level"), "minimal");
      assertEquals(await orbSizeInput.inputValue(), "large");
      assertEquals(
        await dialog.evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(255, 255, 255)",
      );
      await page.getByRole("button", { name: "Close new session" }).click();
      await page.evaluate("globalThis.renderComposer()");
      await page.getByRole("button", { name: "New session", exact: true }).click();
      assertEquals(await prompt.inputValue(), draft);
      assertEquals(await projectInput.inputValue(), "second");
      assertEquals((await project.textContent())?.trim(), "Second");
      assertEquals(await modelInput.inputValue(), "second-model");
      assertEquals((await model.textContent())?.trim(), "Second");
      assertEquals(await orbSizeInput.inputValue(), "large");
      assertEquals((await orbSize.textContent())?.trim(), "large");
      assertEquals(await thinkingLevelInput.inputValue(), "minimal");
      assertEquals((await thinkingLevel.textContent())?.trim(), "Minimal");
      assertEquals(await page.getByRole("button", { name: "Start session" }).isDisabled(), true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(new URL("?autoOpen", server.baseUrl).href);
      await prompt.waitFor({ state: "visible" });
      await page.keyboard.type("Mobile auto-open draft");
      assertEquals(await prompt.inputValue(), "Mobile auto-open draft");
      await orbSize.locator("svg").first().click();
      assertEquals(
        await page.getByRole("listbox").evaluate((list) => {
          const rect = list.parentElement?.getBoundingClientRect();
          return rect
            ? {
              top: Math.round(rect.top),
              right: Math.round(globalThis.innerWidth - rect.right),
              bottom: Math.round(globalThis.innerHeight - rect.bottom),
              left: Math.round(rect.left),
            }
            : null;
        }),
        { top: 12, right: 12, bottom: 12, left: 12 },
      );
      await page.getByRole("button", { name: "Back to session" }).click();
      assertEquals(await orbSize.getAttribute("aria-expanded"), "false");
      await model.locator("svg").first().click();
      assertEquals(await page.getByRole("heading", { name: "Choose a model" }).isVisible(), true);
      assertEquals(
        await page.getByRole("listbox").getByRole("option").allTextContents(),
        ["Test · First", "Test · Second"],
      );
      await page.getByRole("button", { name: "Back to session" }).click();
      assertEquals(await model.getAttribute("aria-expanded"), "false");
      await project.locator("svg").first().click();
      assertEquals(
        await page.getByRole("heading", { name: "Choose a project" }).isVisible(),
        true,
      );
      await page.getByRole("button", { name: "Back to session" }).click();
      assertEquals(await project.getAttribute("aria-expanded"), "false");
      await thinkingLevel.locator("svg").first().click();
      assertEquals(
        await page.getByRole("heading", { name: "Choose a thinking level" }).isVisible(),
        true,
      );
      assertEquals(
        await page.getByRole("listbox").getByRole("option").allTextContents(),
        ["Off", "Low", "High", "Max"],
      );
      await page.getByRole("button", { name: "Back to session" }).click();
      assertEquals(await thinkingLevel.getAttribute("aria-expanded"), "false");
      assertEquals(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
});
