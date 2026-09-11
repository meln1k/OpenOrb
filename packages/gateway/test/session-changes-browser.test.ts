import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

import { assetServer } from "@/app/assets.ts";
import { MAX_RUNNER_BULK_CHUNK_BYTES } from "../../protocol/src/runner-api-limits.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const browserEndpoint = Deno.env.get("OPENORB_BROWSER_TEST_CDP");

Deno.test({
  name: "browser hydrates and renders a multi-chunk Git patch sequentially",
  ignore: browserEndpoint === undefined,
  async fn() {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(browserEndpoint!);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 720 });

    const errors: string[] = [];
    const requestedPaths: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requestedPaths.push(new URL(request.url()).pathname));

    const snapshotId = "a".repeat(64);
    const addedLines = 24_000;
    const endMarker = "OPENORB_BROWSER_BULK_PATCH_END";
    const patch = createPatch(addedLines, endMarker);
    const patchBytes = new TextEncoder().encode(patch);
    const offsets: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const mutationResponse = Promise.withResolvers<Response>();
    const mutationReceived = Promise.withResolvers<void>();
    const reconciliationResponse = Promise.withResolvers<Response>();
    const reconciliationRequested = Promise.withResolvers<void>();
    let mutationRequests = 0;
    let snapshotRequests = 0;

    const uiHref = await assetServer.getHref(import.meta.resolve("remix/ui"));
    const jsxHref = await assetServer.getHref(import.meta.resolve("remix/ui/jsx-runtime"));
    const html = `<!doctype html><html><body style="margin:0">
      <div id="app" style="display:flex;width:100%;height:720px"></div>
      <script type="module">
        import { createRoot, Fragment } from ${JSON.stringify(uiHref)};
        import { jsx, jsxs } from ${JSON.stringify(jsxHref)};
        import { SessionPageScope } from "/assets/app/ui/session/session-page-controller.tsx";
        import { SessionChangesPanel } from "/assets/app/ui/session/session-changes-panel.tsx";
        import { SessionChangesScope } from "/assets/app/ui/session/session-changes-resource.tsx";

        function HydrationProbe(handle) {
          const changes = handle.context.get(SessionChangesScope);
          const page = handle.context.get(SessionPageScope);
          handle.queueTask(() => {
            const update = () => handle.update();
            const refresh = () => page.apply({ type: "git.snapshot.updated" });
            changes.addEventListener("change", update, { signal: handle.signal });
            globalThis.addEventListener("openorb-test-git-refresh", refresh, {
              signal: handle.signal
            });
          });
          return () => {
            const patch = changes.projection.loaded?.snapshot.sections.unstaged.patch ?? "";
            return jsx("output", {
              id: "hydration-probe",
              hidden: true,
              "data-generated-at": changes.projection.loaded?.snapshot.generatedAt ?? "",
              "data-patch-bytes": new TextEncoder().encode(patch).byteLength,
              "data-has-end-marker": patch.endsWith(${JSON.stringify(endMarker + "\n")})
            });
          };
        }

        createRoot(document.getElementById("app")).render(
          jsx(SessionPageScope, {
            csrfToken: "browser-csrf",
            initialState: "ready",
            initialIssues: [],
            sessionId: "browser-session",
            children: jsx(SessionChangesScope, {
              csrfToken: "browser-csrf",
              sessionId: "browser-session",
              children: jsxs(Fragment, { children: [
                jsx(SessionChangesPanel, { sessionId: "browser-session", variant: "content" }),
                jsx(HydrationProbe, {})
              ] })
            })
          })
        );
      </script>
    </body></html>`;

    const server = await createTestServer(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/assets/")) {
        return await assetServer.fetch(request) ?? new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/git-snapshot")) {
        snapshotRequests++;
        if (snapshotRequests === 3) {
          reconciliationRequested.resolve();
          return await reconciliationResponse.promise;
        }
        const empty = snapshotRequests === 2;
        return Response.json({
          snapshotId,
          mutationRevision: 0,
          generatedAt: `browser-bulk-snapshot-${snapshotRequests}`,
          branch: "openorb/browser-bulk-test",
          head: "b".repeat(40),
          completeness: "complete",
          stale: false,
          truncated: false,
          sections: {
            staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
            unstaged: {
              files: empty ? [] : [{
                kind: "tracked",
                path: "src/large.ts",
                displayPath: "src/large.ts",
                status: "added",
                diffState: "available",
              }],
              patch: "",
              fullPatchBytes: empty ? 0 : patchBytes.byteLength,
              truncated: false,
            },
          },
        });
      }
      if (url.pathname.includes("/git-patch/")) {
        const offset = Number(url.pathname.split("/").at(-1));
        const end = Math.min(offset + MAX_RUNNER_BULK_CHUNK_BYTES, patchBytes.byteLength);
        offsets.push(offset);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return Response.json({
          snapshotId,
          section: "unstaged",
          offset,
          bytes: encodeBase64(patchBytes.subarray(offset, end)),
          nextOffset: end,
          done: end === patchBytes.byteLength,
        });
      }
      if (url.pathname.endsWith("/changes") && request.method === "POST") {
        mutationRequests++;
        mutationReceived.resolve();
        return await mutationResponse.promise;
      }
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });

    try {
      await page.goto(server.baseUrl.href);
      const probe = page.locator("#hydration-probe");
      await page.waitForFunction(
        (expectedBytes) =>
          document.querySelector("#hydration-probe")?.getAttribute("data-patch-bytes") ===
            String(expectedBytes),
        patchBytes.byteLength,
        { timeout: 15_000 },
      );
      assertEquals(await probe.getAttribute("data-has-end-marker"), "true");
      assertEquals(offsets, [
        0,
        MAX_RUNNER_BULK_CHUNK_BYTES,
        MAX_RUNNER_BULK_CHUNK_BYTES * 2,
      ]);
      assertEquals(maxInFlight, 1);
      assertEquals(await page.getByText("openorb/browser-bulk-test").isVisible(), true);
      await page.getByLabel(`${addedLines} additions, 0 deletions`).waitFor({ state: "visible" });
      assertEquals(
        await page.getByLabel(`${addedLines} additions, 0 deletions`).isVisible(),
        true,
      );
      const fileToggle = page.locator('button[data-change-file-command="toggle"]');
      if (await fileToggle.getAttribute("aria-expanded") === "false") await fileToggle.click();
      await page.waitForFunction(() =>
        document.querySelector('button[data-change-file-command="toggle"]')?.getAttribute(
          "aria-expanded",
        ) === "true"
      );
      await page.getByText(/generatedLine0/).waitFor({ state: "visible", timeout: 15_000 });
      assertEquals(await page.getByRole("alert").count(), 0);
      assertEquals(
        requestedPaths.some((path) => path.endsWith("/pierre-diff-worker.ts")),
        true,
      );
      assertEquals(errors, []);

      await page.getByLabel("Stage src/large.ts").click();
      const optimisticAction = page.getByLabel("Unstage src/large.ts");
      await optimisticAction.waitFor({ state: "visible" });
      assertEquals(await optimisticAction.getAttribute("aria-busy"), "true");
      assertEquals(await optimisticAction.isEnabled(), true);
      await mutationReceived.promise;
      assertEquals(mutationRequests, 1);

      await page.evaluate(() => globalThis.dispatchEvent(new Event("openorb-test-git-refresh")));
      await page.waitForFunction(() =>
        document.querySelector("#hydration-probe")?.getAttribute("data-patch-bytes") === "0"
      );
      assertEquals(await optimisticAction.isVisible(), true);
      assertEquals(await optimisticAction.getAttribute("aria-busy"), "true");
      assertEquals(await optimisticAction.isEnabled(), true);

      const screenshot = Deno.env.get("OPENORB_BROWSER_TEST_SCREENSHOT");
      mutationResponse.resolve(Response.json({ mutationRevision: 1 }));
      await reconciliationRequested.promise;
      await page.waitForFunction(() => document.querySelector("[aria-busy='true']") === null);
      assertEquals(await page.locator("[aria-busy='true']").count(), 0);
      assertEquals(await optimisticAction.isVisible(), true);
      assertEquals(await optimisticAction.getAttribute("aria-busy"), null);
      if (screenshot !== undefined) await page.screenshot({ path: screenshot });

      reconciliationResponse.resolve(Response.json({
        snapshotId,
        mutationRevision: 1,
        generatedAt: "browser-bulk-snapshot-3",
        branch: "openorb/browser-bulk-test",
        head: "b".repeat(40),
        completeness: "complete",
        stale: false,
        truncated: false,
        sections: {
          staged: {
            files: [{
              kind: "tracked",
              path: "src/large.ts",
              displayPath: "src/large.ts",
              status: "added",
              diffState: "available",
            }],
            patch: "",
            fullPatchBytes: 0,
            truncated: false,
          },
          unstaged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
        },
      }));
      await page.waitForFunction(() =>
        document.querySelector("#hydration-probe")?.getAttribute("data-generated-at") ===
          "browser-bulk-snapshot-3"
      );
      assertEquals(await optimisticAction.isVisible(), true);
      assertEquals(await optimisticAction.getAttribute("aria-busy"), null);
    } finally {
      mutationResponse.resolve(Response.json({ mutationRevision: 1 }));
      reconciliationResponse.resolve(new Response(null, { status: 500 }));
      await context.close();
      await browser.close();
      await server.close();
      if (errors.length > 0) console.error("Browser errors:", errors);
    }
  },
});

function createPatch(addedLines: number, endMarker: string): string {
  const lines = Array.from(
    { length: addedLines - 1 },
    (_, index) => `+export const generatedLine${index} = "${"x".repeat(64)}";`,
  );
  lines.push(`+${endMarker}`);
  return [
    "diff --git a/src/large.ts b/src/large.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/large.ts",
    `@@ -0,0 +1,${addedLines} @@`,
    ...lines,
    "",
  ].join("\n");
}
