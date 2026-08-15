import { assertEquals, assertMatch } from "@std/assert";

import { createAppRouter } from "@/app/router.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore } from "@/test/postgres-test.ts";

Deno.test("serves process health and the control shell over HTTP", async () => {
  const store = await createTestStore();
  const router = createAppRouter(createAppServices(store));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const healthResponse = await fetch(new URL(routes.health.href(), server.baseUrl));
    assertEquals(healthResponse.status, 200);
    assertEquals(await healthResponse.json(), {
      service: "openorb-control",
      status: "ok",
    });
    assertEquals(healthResponse.headers.get("set-cookie"), null);
    const sessionCount = await store.pool.query<{ count: number }>(
      "select count(*)::integer as count from browser_sessions",
    );
    assertEquals(sessionCount.rows[0]?.count, 0);

    const faviconResponse = await fetch(new URL("/favicon.svg", server.baseUrl));
    assertEquals(faviconResponse.status, 200);
    assertEquals(faviconResponse.headers.get("content-type"), "image/svg+xml");
    assertEquals(faviconResponse.headers.get("set-cookie"), null);
    assertMatch(await faviconResponse.text(), /^<svg/);

    const homeResponse = await fetch(new URL(routes.home.href(), server.baseUrl));
    assertEquals(homeResponse.status, 200);
    assertMatch(homeResponse.headers.get("content-type") ?? "", /^text\/html/);
    const homeHtml = await homeResponse.text();
    assertMatch(homeHtml, /Create your administrator/);
    assertMatch(
      homeHtml,
      /<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no" \/>/,
    );
    assertMatch(homeHtml, /<script type="module" src="\/assets\/app\/assets\/client\.ts">/);
  } finally {
    await server.close();
    await store.close();
  }
});
