import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { assetServer as resolver, clientScriptEntry, createGatewayAssets } from "@/app/assets.ts";
import metadata from "../dist/asset-manifest.json" with { type: "json" };

const output = new URL("../dist/", import.meta.url);
// Model only the binding boundary, not a runtime filesystem dependency. celld owns HTTP semantics.
const assetServer = createGatewayAssets({
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const bytes = await Deno.readFile(new URL(`assets${pathname}`, output));
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  },
});

const clientEntries = [
  "packages/gateway/app/public/client.ts",
  "packages/gateway/app/ui/public/session-composer-behavior.tsx",
  "packages/gateway/app/actions/sessions/public/session-detail-client.tsx",
  "packages/gateway/app/ui/public/shell.tsx",
  "packages/gateway/app/actions/settings/providers/public/chatgpt-authorization-polling.tsx",
  "packages/gateway/app/ui/public/components/button.tsx",
];

Deno.test("serves browser UI dependencies without exposing server modules", async () => {
  const clientScript = await assetServer.getScriptEntry(clientEntries[0]!);
  assertEquals(clientScript.href, "/assets/app/public/client.ts");
  assertEquals(clientScript, clientScriptEntry);
  assert(Object.keys(clientScript.importMap.scopes ?? {}).length > 0);

  const preloads = await assetServer.getPreloads(clientEntries);

  assert(preloads.some((href) => href.startsWith("/assets/npm/")));
  for (const href of preloads) {
    if (href.startsWith("/assets/app/")) {
      assert(href.includes("/public/") || href === "/assets/app/routes.ts", href);
    }
    const response = await assetServer.fetch(new Request(new URL(href, "http://assets.test")));
    assert(response, `expected the asset server to handle ${href}`);
    assertEquals(response.status, 200, href);
  }

  for (
    const suffix of [
      "/marked/lib/marked.esm.js",
      "/lucide/dist/esm/icons/plus.mjs",
      "/data-schema/dist/lib/schema.js",
      "/ui/dist/combobox.js",
      "/ui/dist/select.js",
      "/ui/dist/popover.js",
      "/chord/dist/delta/index.js",
    ]
  ) {
    const href = preloads.find((href) => href.endsWith(suffix));
    assert(href, `expected browser dependency ${suffix}`);
    const response = await assetServer.fetch(new Request(new URL(href, "http://assets.test")));
    assert(response, `expected the asset server to handle ${href}`);
    assertEquals(response.status, 200, href);
  }

  for (
    const href of [
      "/assets/app/actions/settings/controller.tsx",
      "/assets/app/actions/settings/page.tsx",
      "/assets/app/actions/settings/providers/model-providers.tsx",
      "/assets/app/actions/settings/settings-navigation.tsx",
      "/assets/app/actions/settings/settings-shared.ts",
      "/assets/app/actions/settings/secrets/generic-secrets.tsx",
      "/assets/app/actions/settings/git-author/git-author.tsx",
      "/assets/app/actions/settings/github/github-credential.tsx",
      "/assets/app/actions/settings/runners/runners.tsx",
      "/assets/app/actions/sessions/controller.tsx",
      "/assets/app/actions/sessions/page.tsx",
      "/assets/app/actions/sessions/public/session-page-controller.test.ts",
      "/assets/app/actions/sessions/public/session-markdown.test.tsx",
      "/assets/npm/@earendil-works/pi-durable/dist/index.js",
      "/assets/npm/@earendil-works/chord/dist/index.js",
      "/assets/npm/.deno/remix@3.0.0/node_modules/remix/dist/component/server.js",
      "/assets/npm/.deno/remix@3.0.0/node_modules/remix/dist/component/test.js",
      "/assets/npm/.deno/@remix-run+component@1.0.0/node_modules/@remix-run/component/dist/server/stream.js",
      "/assets/npm/.deno/@remix-run+component@1.0.0/node_modules/@remix-run/component/dist/test.js",
      "/assets/npm/.deno/remix@3.0.0/node_modules/remix/dist/data-table-postgres.js",
      "/assets/npm/.deno/pg@8.16.3/node_modules/pg/lib/index.js",
      "/assets/npm/.deno/@remix-run+component@1.0.0/node_modules/@remix-run/component/dist/index.d.ts",
    ]
  ) {
    assertEquals(
      await assetServer.fetch(new Request(new URL(href, "http://assets.test"))),
      null,
      href,
    );
  }
});

Deno.test("build exports lazy graphs, portable worker, public files and no private source", async () => {
  const directory = fromFileUrl(output);
  assertEquals(metadata.entries["packages/gateway/app/public/client.ts"], clientScriptEntry);
  for (const [id, entry] of Object.entries(metadata.entries)) {
    assertEquals(await resolver.getScriptEntry(id), entry);
    assertEquals(
      await resolver.getScriptEntry(`file:///relocated/checkout/${id}#ExportName`),
      entry,
    );
  }
  for (const href of metadata.assetUrls) {
    if (href.startsWith("/assets/app/")) {
      assert(
        href.includes("/public/") || href === "/assets/app/routes.ts" ||
          href === "/assets/app/routes.ts.map",
        href,
      );
    }
    assert(!href.includes(".test."), href);
    assert(!href.endsWith(".d.ts"), href);
    assert(!href.includes("/component/server"), href);
    const bytes = await Deno.readFile(`${directory}/assets${decodeURIComponent(href)}`);
    assert(bytes.length > 0, href);
  }
  for (
    const suffix of [
      "/diffs/dist/worker/worker-portable.js",
      "/diffs/dist/worker/wasm-B9ZqxnKj.js",
      "/langs/dist/typescript.mjs",
      "/theme/dist/pierre-dark.mjs",
      "/theme/dist/pierre-light.mjs",
    ]
  ) {
    assert(metadata.assetUrls.some((href) => href.endsWith(suffix)), suffix);
  }
  const lru = metadata.assetUrls.find((href) => href.endsWith("/lru_map/dist/lru.js"));
  assert(lru);
  const lruSource = await Deno.readTextFile(`${directory}/assets${decodeURIComponent(lru)}`);
  assert(lruSource.includes("globalThis.lru_map"));
  assert(lruSource.includes("export default"));
  assertEquals(
    await Deno.readFile(`${directory}/assets/favicon.svg`),
    await Deno.readFile(new URL("../public/favicon.svg", import.meta.url)),
  );
  assertEquals(metadata.publicFiles, ["/favicon.svg"]);
  const headers = await Deno.readTextFile(`${directory}/assets/_headers`);
  assert(headers.includes("Content-Type: text/javascript; charset=utf-8"));
  // Metadata is bundled into the Worker, never deployed as a public asset.
  await assertRejects(() => Deno.stat(`${directory}/assets/asset-manifest.json`));
});

Deno.test("runtime delegates HTTP only for built assets and separates static public files", async () => {
  const requests: Request[] = [];
  const response = new Response(null, { status: 304, headers: { ETag: '"built"' } });
  const runtime = createGatewayAssets({
    fetch(request) {
      requests.push(request);
      return Promise.resolve(response);
    },
  });
  const request = new Request("https://assets.test/assets/app/public/client.ts?v=1", {
    method: "HEAD",
    headers: { "If-None-Match": '"built"', Range: "bytes=0-4" },
  });
  assertEquals(await runtime.fetch(request), response);
  assertEquals(requests[0], request);
  assertEquals(await runtime.fetch(new Request("https://assets.test/favicon.svg")), null);
  assertEquals(await runtime.fetchPublic(new Request("https://assets.test/favicon.svg")), response);
  for (
    const pathname of ["/assets/app/assets.ts", "/asset-manifest.json", "/_headers", "/unknown"]
  ) {
    assertEquals(await runtime.fetch(new Request(`https://assets.test${pathname}`)), null);
    assertEquals(await runtime.fetchPublic(new Request(`https://assets.test${pathname}`)), null);
  }
  assertEquals(
    await runtime.fetch(new Request(request.url, { method: "POST" })),
    null,
  );
  assertEquals(requests.length, 2);
  const missing = createGatewayAssets({
    fetch: () => Promise.resolve(new Response(null, { status: 404 })),
  });
  assertEquals(await missing.fetch(request), null);
  await assertRejects(() => resolver.fetch(request), TypeError, "ASSETS binding");
  await assertRejects(
    () => resolver.getScriptEntry("file:///dist/worker.js"),
    TypeError,
    "not built",
  );
  const entry = await resolver.getScriptEntry(clientEntries[0]!);
  entry.preloads.length = 0;
  assert((await resolver.getScriptEntry(clientEntries[0]!)).preloads.length > 0);
});
