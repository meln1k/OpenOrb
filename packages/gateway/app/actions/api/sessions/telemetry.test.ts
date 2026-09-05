import { assertEquals, assertRejects } from "@std/assert";
import { trace } from "@opentelemetry/api";
import { createRouter } from "remix/router";
import { sessionApiTelemetry, sessionRejection, sessionSpan, sessionStage } from "./telemetry.ts";

Deno.test("session telemetry preserves rejection responses and middleware short circuits", async () => {
  const router = createRouter({
    middleware: [
      sessionApiTelemetry(),
      () => {
        sessionStage("csrf");
        sessionRejection("invalid_csrf");
        return new Response("Forbidden", { status: 403 });
      },
    ],
  });
  router.get("/sessions", () => new Response("must not run"));
  const response = await router.fetch(new Request("http://localhost/sessions"));
  assertEquals(response.status, 403);
  assertEquals(await response.text(), "Forbidden");
});

Deno.test("session spans preserve results and original exceptions", async () => {
  assertEquals(await sessionSpan("test.success", () => Promise.resolve(42)), 42);
  const failure = new TypeError("secret must not appear in telemetry");
  const caught = await assertRejects(() =>
    sessionSpan("test.failure", () => Promise.reject(failure))
  );
  assertEquals(caught, failure);
});

Deno.test({
  name: "native OTel keeps session child spans in the request trace across awaits",
  ignore: Deno.env.get("OTEL_DENO") !== "true",
  async fn() {
    await sessionSpan("test.request", async () => {
      const parent = trace.getActiveSpan()!;
      assertEquals(parent.isRecording(), true);
      await sessionSpan("test.lookup", async () => {
        await Promise.resolve();
        const child = trace.getActiveSpan()!;
        assertEquals(child.spanContext().traceId, parent.spanContext().traceId);
        assertEquals(child.spanContext().spanId === parent.spanContext().spanId, false);
      });
      assertEquals(trace.getActiveSpan(), parent);
    });
  },
});
