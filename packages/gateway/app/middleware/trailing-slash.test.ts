import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";
import { createRouter } from "remix/router";

import { rewriteTrailingSlash } from "./trailing-slash.ts";

test("trailing slash middleware rewrites the path before routing", async () => {
  const router = createRouter({ middleware: [rewriteTrailingSlash()] });
  router.post("/resource", async (context) =>
    Response.json({
      body: await context.request.text(),
      pathname: context.url.pathname,
      search: context.url.search,
    }),
  );

  const response = await router.fetch(
    new Request("http://localhost/resource/?view=summary", {
      method: "POST",
      body: "payload",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    body: "payload",
    pathname: "/resource",
    search: "?view=summary",
  });
});

test("trailing slash middleware preserves the root path", async () => {
  const router = createRouter({ middleware: [rewriteTrailingSlash()] });
  router.get("/", (context) => new Response(context.url.pathname));

  const response = await router.fetch("http://localhost/");

  assertEquals(response.status, 200);
  assertEquals(await response.text(), "/");
});
