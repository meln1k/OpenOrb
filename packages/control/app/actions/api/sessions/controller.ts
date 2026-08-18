import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import { parseSafe } from "remix/data-schema";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { type SessionEventPayload, sessionIdSchema } from "@openorb/protocol";
import { routes } from "@/app/routes.ts";

const KEEPALIVE_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

export default createController(routes.api.sessions, {
  middleware: [requireAuth<Administrator>()],
  actions: {
    async events(context) {
      const userId = context.auth.identity.id;
      const sessionId = context.params.sessionId;
      if (!parseSafe(sessionIdSchema, sessionId).success) {
        return new Response("Session not found.", { status: 404 });
      }
      const session = await context.services.store.getSessionCatalogEntry(userId, sessionId);
      if (!session) return new Response("Session not found.", { status: 404 });
      if (!context.services.runnerConnections.getSessionRunner(userId, sessionId)) {
        return new Response("The pinned runner is offline.", { status: 503 });
      }

      const afterCursor = parseCursor(context.request);
      if (afterCursor === null) return new Response("Invalid event cursor.", { status: 400 });

      let unsubscribe = () => {};
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let abort = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            if (keepalive !== undefined) clearInterval(keepalive);
            unsubscribe();
            context.request.signal.removeEventListener("abort", abort);
            try {
              controller.close();
            } catch {
              // A peer may cancel immediately before the abort signal is delivered.
            }
          };
          const enqueue = (event: SessionEventPayload) => {
            if (closed) return;
            try {
              controller.enqueue(encodeEvent(event));
            } catch {
              close();
            }
          };
          const subscription = context.services.runnerConnections.subscribeToSessionEvents(
            userId,
            sessionId,
            afterCursor,
            enqueue,
          );
          unsubscribe = subscription.unsubscribe;
          for (const event of subscription.events) enqueue(event);
          keepalive = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              close();
            }
          }, KEEPALIVE_INTERVAL_MS);
          abort = close;
          context.request.signal.addEventListener("abort", abort, { once: true });
          if (context.request.signal.aborted) close();
        },
        cancel() {
          if (keepalive !== undefined) clearInterval(keepalive);
          unsubscribe();
          context.request.signal.removeEventListener("abort", abort);
        },
      });

      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    },
  },
});

function parseCursor(request: Request): number | null {
  const url = new URL(request.url);
  const source = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(source)) return null;
  const cursor = Number(source);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

function encodeEvent(payload: SessionEventPayload): Uint8Array {
  return encoder.encode(
    `id: ${payload.cursor}\nevent: session\ndata: ${JSON.stringify(payload.event)}\n\n`,
  );
}
