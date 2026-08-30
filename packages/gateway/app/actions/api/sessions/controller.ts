import { parseModelReference } from "@openorb/protocol";
import { MAX_SESSION_GIT_PATH_CHARACTERS } from "@openorb/protocol/runner-api";
import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { validate as validateUuid } from "@std/uuid";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { sessionModelRuntime } from "@/app/model-provider-catalog.ts";
import { routes } from "@/app/routes.ts";
import { Effect } from "effect";

const sessionIdSchema = s.string().refine(validateUuid, "Expected a session UUID.");
const gitPathSchema = s.string().refine(
  (value) => value.length > 0 && Array.from(value).length <= MAX_SESSION_GIT_PATH_CHARACTERS,
  `Git paths must contain 1 to ${MAX_SESSION_GIT_PATH_CHARACTERS} characters.`,
);
const updateGitFileSchema = f.object({
  action: f.field(s.union([s.literal("stage" as const), s.literal("unstage" as const)])),
  path: f.field(gitPathSchema),
  previousPath: f.field(s.optional(gitPathSchema)),
});

export default createController(routes.api.sessions, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async wake(context) {
      const userId = context.auth.identity.id;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return apiError("Session not found.", 404);
      const session = await context.services.store.getSessionCatalogEntry(userId, sessionId);
      if (!session) return apiError("Session not found.", 404);
      const snapshot = await Effect.runPromise(
        context.services.runnerConnections.getSessionSnapshot(userId, sessionId),
      );
      if (!snapshot) return apiError("The pinned runner is offline.", 503);
      if (
        snapshot.state !== "ready" && snapshot.state !== "running" &&
        snapshot.state !== "stopped"
      ) {
        return apiError("The session cannot be restored right now.", 409);
      }

      const [[modelApiKey, modelCredentialError], [githubToken, gitCredentialError]] = await Promise
        .all([
          context.services.store.getModelProviderApiKey(
            userId,
            parseModelReference(snapshot.model).providerId,
          ),
          context.services.store.getGitHubToken(userId),
        ]);
      if (modelCredentialError !== undefined) {
        return apiError("The saved model provider credential could not be read.", 500);
      }
      if (gitCredentialError !== undefined) {
        return apiError("The saved GitHub credential could not be read.", 500);
      }
      if (modelApiKey === null) {
        return apiError("Reconfigure this session's model provider before continuing.", 409);
      }

      const woken = await Effect.runPromise(
        context.services.runnerConnections.wakeSession({
          userId,
          sessionId,
          payload: {
            modelRuntime: sessionModelRuntime(snapshot.model, modelApiKey),
            ...(githubToken === null ? {} : { githubToken }),
          },
        }),
        { signal: context.request.signal },
      );
      if (woken.status !== "accepted") {
        return apiError(woken.message, woken.status === "rejected" ? 409 : 503);
      }
      return Response.json(
        { status: "accepted" },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    },
    async changes(context) {
      const userId = context.auth.identity.id;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return apiError("Session not found.", 404);
      const parsed = s.parseSafe(updateGitFileSchema, context.formData);
      if (!parsed.success) {
        return apiError(parsed.issues[0]?.message ?? "Invalid Git file update.", 400);
      }
      const session = await context.services.store.getSessionCatalogEntry(userId, sessionId);
      if (!session) return apiError("Session not found.", 404);
      const updated = await Effect.runPromise(
        context.services.runnerConnections.updateSessionGitFile({
          userId,
          sessionId,
          action: parsed.value.action,
          path: parsed.value.path,
          ...(parsed.value.previousPath === undefined
            ? {}
            : { previousPath: parsed.value.previousPath }),
        }),
        { signal: context.request.signal },
      );
      if (updated.status !== "accepted") {
        return apiError(updated.message, updated.status === "rejected" ? 409 : 503);
      }
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    },
    async gitSnapshot(context) {
      const userId = context.auth.identity.id;
      const sessionId = context.params.sessionId;
      if (!s.parseSafe(sessionIdSchema, sessionId).success) {
        return new Response("Session not found.", { status: 404 });
      }
      const session = await context.services.store.getSessionCatalogEntry(userId, sessionId);
      if (!session) return new Response("Session not found.", { status: 404 });

      const result = await Effect.runPromise(
        context.services.runnerConnections.getSessionGitSnapshot(userId, sessionId),
      );
      if (result.status !== "accepted") {
        return Response.json(
          { error: result.message },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(result.acknowledgement, {
        headers: { "Cache-Control": "no-store" },
      });
    },
    async events(context) {
      const userId = context.auth.identity.id;
      const sessionId = context.params.sessionId;
      if (!s.parseSafe(sessionIdSchema, sessionId).success) {
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

function parseSessionId(value: string): string | null {
  return s.parseSafe(sessionIdSchema, value).success ? value : null;
}

function apiError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function parseCursor(request: Request): number | null {
  const source = request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/.test(source)) return null;
  const cursor = Number(source);
  return Number.isSafeInteger(cursor) ? cursor : null;
}
