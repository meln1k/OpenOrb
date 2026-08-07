import assert from "node:assert/strict";
import test from "node:test";

import { createTestServer } from "remix/node-fetch-server/test";

import { router } from "../app/router.ts";
import { routes } from "../app/routes.ts";

test("serves process health and the control shell over HTTP", async () => {
  let server = await createTestServer((request) => router.fetch(request));

  try {
    let healthResponse = await fetch(new URL(routes.health.href(), server.baseUrl));
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      service: "openorb-control",
      status: "ok",
    });

    let homeResponse = await fetch(new URL(routes.home.href(), server.baseUrl));
    assert.equal(homeResponse.status, 200);
    assert.match(homeResponse.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await homeResponse.text(), /OpenOrb control/);
  } finally {
    await server.close();
  }
});
