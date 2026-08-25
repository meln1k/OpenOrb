import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import { parseSafe, string } from "remix/data-schema";
import { validate as validateUuid } from "@std/uuid";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";
import { routes } from "@/app/routes.ts";
import { Effect } from "effect";

const sessionIdSchema = string().refine(validateUuid, "Expected a session UUID.");

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
      if (
        !await Effect.runPromise(
          context.services.runnerConnections.getSessionRunner(userId, sessionId),
        )
      ) {
        return new Response("The pinned runner is offline.", { status: 503 });
      }

      const afterCursor = parseCursor(context.request);
      if (afterCursor === null) return new Response("Invalid event cursor.", { status: 400 });

      const stream = await Effect.runPromise(
        createSessionEventStream(
          context.services.runnerConnections.watchSession(userId, sessionId, afterCursor),
        ),
        { signal: context.request.signal },
      );

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
  const source = request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(source)) return null;
  const cursor = Number(source);
  return Number.isSafeInteger(cursor) ? cursor : null;
}
