import { assert, assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";

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
    const href of [
      "/assets/npm/marked/lib/marked.esm.js",
      "/assets/npm/lucide/dist/esm/icons/plus.mjs",
      "/assets/npm/@remix-run/data-schema/dist/index.js",
      "/assets/npm/@remix-run/ui/dist/combobox.js",
      "/assets/npm/@remix-run/ui/dist/select.js",
      "/assets/npm/@remix-run/ui/dist/popover.js",
      "/assets/npm/@earendil-works/chord/dist/delta/index.js",
    ]
  ) {
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
