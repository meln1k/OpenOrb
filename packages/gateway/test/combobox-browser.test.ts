import { assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name: "combobox filters, skips disabled options, and submits the committed value",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 960, height: 720 });

    const uiHref = await assetServer.getHref(import.meta.resolve("remix/ui"));
    const jsxHref = await assetServer.getHref(import.meta.resolve("remix/ui/jsx-runtime"));
    const html = `<!doctype html><html><body><div id="app"></div>
      <script type="module">
        import { createRoot, css } from ${JSON.stringify(uiHref)};
        import { jsx, jsxs } from ${JSON.stringify(jsxHref)};
        import { Combobox, ComboboxOption } from "/assets/app/ui/components/combobox.tsx";
        import { designSystemStyle } from "/assets/app/ui/components/theme.ts";

        const pageStyle = css({
          minHeight: "100dvh", margin: 0, padding: "64px", background: "var(--background)"
        });
        const formStyle = css({ display: "grid", width: "320px", gap: "56px" });
        const fieldStyle = css({ display: "grid", gap: "8px", fontSize: "14px", fontWeight: 500 });

        const options = [
          jsx(ComboboxOption, { label: "Next.js", value: "Next.js" }, "next"),
          jsx(ComboboxOption, { disabled: true, label: "Nuxt.js", value: "Nuxt.js" }, "nuxt"),
          jsx(ComboboxOption, { label: "Remix", value: "Remix" }, "remix"),
          jsx(ComboboxOption, {
            label: "SvelteKit", searchValue: ["SvelteKit", "sv"], value: "SvelteKit"
          }, "svelte")
        ];

        createRoot(document.getElementById("app")).render(
          jsx("main", {
            mix: [designSystemStyle, pageStyle],
            children: jsxs("form", {
              mix: formStyle,
              children: [
                jsxs("label", {
                  mix: fieldStyle,
                  children: [
                    "Framework",
                    jsx(Combobox, {
                      name: "framework",
                      placeholder: "Select a framework",
                      inputProps: { "aria-label": "Framework" },
                      children: options
                    })
                  ]
                }),
                jsxs("label", {
                  mix: fieldStyle,
                  children: [
                    "Invalid",
                    jsx(Combobox, {
                      placeholder: "Select a framework",
                      inputProps: { "aria-invalid": "true", "aria-label": "Invalid framework" },
                      children: options
                    })
                  ]
                }),
                jsxs("label", {
                  mix: fieldStyle,
                  children: [
                    "Disabled",
                    jsx(Combobox, {
                      disabled: true,
                      placeholder: "Select a framework",
                      inputProps: { "aria-label": "Disabled framework" },
                      children: options
                    })
                  ]
                })
              ]
            })
          })
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
      const input = page.getByRole("combobox", { name: "Framework", exact: true });
      await input.waitFor();
      assertEquals(await input.getAttribute("aria-expanded"), "false");

      await input.click();
      assertEquals(await input.getAttribute("aria-expanded"), "true");
      const listId = await input.getAttribute("aria-controls");
      const list = page.locator(`#${listId}`);
      assertEquals(await list.getByRole("option").count(), 4);

      await input.press("ArrowDown");
      await input.press("ArrowDown");
      const activeId = await input.getAttribute("aria-activedescendant");
      assertEquals(await page.locator(`#${activeId}`).textContent(), "Remix");
      await input.press("Enter");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>("input[role='combobox']")?.value === "Remix"
      );
      assertEquals(await input.getAttribute("aria-expanded"), "false");
      assertEquals(
        await page.locator('input[type="hidden"][name="framework"]').inputValue(),
        "Remix",
      );
      const selectedOption = list.getByRole("option", { name: "Remix" });
      assertEquals(await selectedOption.getAttribute("aria-selected"), "true");
      assertEquals(
        await selectedOption.locator('[data-slot="combobox-item-indicator"]').evaluate((element) =>
          getComputedStyle(element).opacity
        ),
        "1",
      );

      await input.fill("sv");
      assertEquals(await input.getAttribute("aria-expanded"), "true");
      assertEquals(await list.getByRole("option").filter({ visible: true }).allTextContents(), [
        "SvelteKit",
      ]);

      const screenshot = Deno.env.get("OPENORB_COMBOBOX_SCREENSHOT");
      if (screenshot !== undefined) {
        await page.locator('[data-slot="combobox-content"]:popover-open').evaluate((element) =>
          Promise.all(element.getAnimations().map((animation) => animation.finished))
        );
        await page.screenshot({ path: screenshot });
      }

      await input.press("ArrowDown");
      await input.press("Enter");
      await page.waitForFunction(() =>
        document.querySelector<HTMLInputElement>("input[role='combobox']")?.value === "SvelteKit"
      );
      assertEquals(
        await page.locator('input[type="hidden"][name="framework"]').inputValue(),
        "SvelteKit",
      );

      await input.fill("unknown");
      assertEquals(await input.getAttribute("aria-expanded"), "false");
      await input.press("Escape");
      assertEquals(await input.inputValue(), "");
      assertEquals(await page.locator('input[type="hidden"][name="framework"]').inputValue(), "");
      assertEquals(
        await page.getByRole("combobox", { name: "Disabled framework" }).isDisabled(),
        true,
      );
      assertEquals(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
});
