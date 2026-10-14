import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import { createRpcClient } from "./workspace/rpc-client.ts";

const gatewayUrl = process.env["OPENORB_TEST_GATEWAY_URL"];
const browserEndpoint = process.env["OPENORB_BROWSER_TEST_CDP"];

test(
  "Worker router cache preserves each request's secure cookie policy",
  { skip: !gatewayUrl, timeout: 120_000 },
  async () => {
    assert(gatewayUrl);
    const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
    await workspace.createAdministrator("rpc-fixture-password");
    for (const secure of [false, true, false]) {
      const path = secure ? "/__https/auth/login" : "/auth/login";
      const response = await fetch(new URL(path, gatewayUrl));
      assertEquals(response.status, 200);
      const cookie = response.headers.get("set-cookie");
      assert(cookie && cookie.startsWith("openorb_session="));
      assertEquals(/; Secure(?:;|$)/i.test(cookie), secure);
      await response.body?.cancel();
    }
  },
);

test(
  "native Worker authenticates through Workspace RPC and hydrates bundled client entries",
  { skip: !gatewayUrl || !browserEndpoint, timeout: 120_000 },
  async () => {
    assert(gatewayUrl && browserEndpoint);
    const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
    await workspace.createAdministrator("rpc-fixture-password");
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(new URL("/auth/login", gatewayUrl).href);
      await page
        .getByRole("textbox", { name: "Password", exact: true })
        .fill("rpc-fixture-password");
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.waitForURL("**/app");
      await page.getByRole("button", { name: "New session", exact: true }).click();
      const prompt = page.getByRole("textbox", { name: "Initial prompt" });
      await prompt.fill("Native Worker hydration");
      await page.getByRole("button", { name: "Orb size", exact: true }).click();
      await page.getByRole("option", { name: /^large ·/ }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('button[aria-label="Orb size"]')?.textContent?.trim() === "large",
      );
      assertEquals(
        await page.getByRole("button", { name: "Orb size", exact: true }).innerText(),
        "large",
      );
      assertEquals(await prompt.inputValue(), "Native Worker hydration");
      await page.getByRole("button", { name: "Close new session" }).click();
      await page.goto(new URL("/app/settings/providers", gatewayUrl).href);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("textbox", { name: "API key", exact: true }).waitFor();
      assertEquals(errors, []);
      // The old unauthenticated Workspace HTTP facade must not be exposed by the public Worker.
      const response = await context.request.post(new URL("/hasAdministrator", gatewayUrl).href, {
        data: [],
      });
      assertEquals(response.status(), 404);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
