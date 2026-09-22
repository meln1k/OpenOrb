import { assertEquals } from "@std/assert";
import { createRouter } from "remix/router";

import { redirectUnauthorizedPages } from "@/app/middleware/unauthorized-page.ts";

Deno.test("unauthorized page middleware redirects protected browser pages", async () => {
  const router = createRouter({ middleware: [redirectUnauthorizedPages()] });
  router.get("/app/projects", () => new Response("Unauthorized", { status: 401 }));

  const response = await router.fetch("http://localhost/app/projects");

  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), "/");
});

Deno.test("unauthorized page middleware preserves other error responses", async () => {
  const router = createRouter({ middleware: [redirectUnauthorizedPages()] });
  router.post("/auth/login", () => new Response("Invalid password", { status: 401 }));
  router.get("/api/sessions", () => new Response("Unauthorized", { status: 401 }));
  router.post("/app/projects", () => new Response("Forbidden", { status: 403 }));

  for (
    const [url, method, status] of [
      ["http://localhost/auth/login", "POST", 401],
      ["http://localhost/api/sessions", "GET", 401],
      ["http://localhost/app/projects", "POST", 403],
    ] as const
  ) {
    const response = await router.fetch(new Request(url, { method }));
    assertEquals(response.status, status);
    assertEquals(response.headers.get("location"), null);
  }
});
