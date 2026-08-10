import { assertEquals, assertMatch } from "@std/assert";

import { createAppRouter } from "../app/router.ts";
import { createAppServices } from "../app/middleware/services.ts";
import { routes } from "../app/routes.ts";
import { createTestServer } from "./http-test-server.ts";
import { createTestStore } from "./postgres-test.ts";

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

    const homeResponse = await fetch(new URL(routes.home.href(), server.baseUrl));
    assertEquals(homeResponse.status, 200);
    assertMatch(homeResponse.headers.get("content-type") ?? "", /^text\/html/);
    assertMatch(await homeResponse.text(), /Create your administrator/);
  } finally {
    await server.close();
    await store.close();
  }
});
