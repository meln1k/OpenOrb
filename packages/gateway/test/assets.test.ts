import { assert, assertEquals } from "@std/assert";

import { assetServer } from "@/app/assets.ts";

const clientEntries = [
  "packages/gateway/app/assets/client.ts",
  "packages/gateway/app/ui/session/session-composer-behavior.tsx",
  "packages/gateway/app/ui/session/session-detail-client.tsx",
  "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/ui/button.js",
];

Deno.test("serves browser UI dependencies without exposing server modules", async () => {
  const preloads = await assetServer.getPreloads(clientEntries);

  assert(preloads.some((href) => href.startsWith("/assets/npm/")));
  for (const href of preloads) {
    const response = await assetServer.fetch(new Request(new URL(href, "http://assets.test")));
    assert(response, `expected the asset server to handle ${href}`);
    assertEquals(response.status, 200, href);
  }

  for (
    const href of [
      "/assets/app/actions/settings/controller.tsx",
      "/assets/app/actions/settings/page.tsx",
      "/assets/app/ui/settings/settings-navigation.tsx",
      "/assets/app/actions/sessions/controller.tsx",
      "/assets/app/actions/sessions/page.tsx",
      "/assets/npm/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/ui/server.js",
      "/assets/npm/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/ui/test.js",
      "/assets/npm/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/server/stream.js",
      "/assets/npm/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/test.js",
      "/assets/npm/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/data-table-postgres.js",
      "/assets/npm/.deno/pg@8.16.3/node_modules/pg/lib/index.js",
      "/assets/npm/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/index.d.ts",
    ]
  ) {
    assertEquals(
      await assetServer.fetch(new Request(new URL(href, "http://assets.test"))),
      null,
      href,
    );
  }
});
