import assert from "node:assert/strict";
import test from "node:test";

import { createTestServer } from "remix/node-fetch-server/test";

import { createAppRouter } from "../app/router.ts";
import { createControlRuntime } from "../app/data/runtime.ts";
import { routes } from "../app/routes.ts";
import { createTestStore } from "./postgres-test.ts";

test("serves process health and the control shell over HTTP", async () => {
  let store = await createTestStore();
  let router = createAppRouter(createControlRuntime(store));
  let server = await createTestServer((request) => router.fetch(request));

  try {
    let healthResponse = await fetch(new URL(routes.health.href(), server.baseUrl));
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      service: "openorb-control",
      status: "ok",
    });
    assert.equal(healthResponse.headers.get("set-cookie"), null);
    const sessionCount = await store.pool.query<{ count: number }>(
      "select count(*)::integer as count from browser_sessions",
    );
    assert.equal(sessionCount.rows[0]?.count, 0);

    let homeResponse = await fetch(new URL(routes.home.href(), server.baseUrl));
    assert.equal(homeResponse.status, 200);
    assert.match(homeResponse.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await homeResponse.text(), /Create your administrator/);
  } finally {
    await server.close();
    await store.close();
  }
});
