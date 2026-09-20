import { MAX_SESSION_GIT_PATH_CHARACTERS, SessionId } from "@openorb/protocol/runner-api";
import {
  type SessionArtifactChunk,
  SessionArtifactId,
  SessionGitPatchSection,
  SessionGitSnapshotId,
} from "@openorb/protocol/runner-bulk-api";
import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { encodeBase64 } from "@std/encoding/base64";
import { validate as validateUuid } from "@std/uuid";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";
import {
  sessionApiTelemetry,
  sessionCsrfStage,
  sessionRejection,
  sessionSpan,
  sessionStage,
} from "./telemetry.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { resolveSessionModelRuntime } from "@/app/model-provider-runtime.ts";
import { routes } from "@/app/routes.ts";
import { Effect, Option, Schema } from "effect";

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
const wakeSessionSchema = f.object({
  recovery: f.field(s.optional(s.literal("restart-environment" as const))),
});
const gitPatchChunkParamsSchema = Schema.Struct({
  sessionId: SessionId,
  snapshotId: SessionGitSnapshotId,
  section: SessionGitPatchSection,
  offset: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});

export default createController(routes.api.sessions, {
  middleware: [
    sessionApiTelemetry(),
    requireAuth<Administrator>(),
    sessionCsrfStage(),
    csrf(),
  ],
  actions: {
    async wake(context) {
      sessionStage("wake.validate");
      const parsed = s.parseSafe(wakeSessionSchema, context.formData);
      if (!parsed.success) {
        sessionRejection("invalid_recovery_action");
        return apiError("Invalid recovery action.", 400);
      }
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return apiError("Session not found.", 404);
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const snapshot = await sessionSpan("runner.snapshot", () =>
        Effect.runPromise(
          context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
        ));
      if (!snapshot) return apiError("The pinned runner is offline.", 503);

      const [
        [modelRuntime, modelCredentialError],
        [githubToken, gitCredentialError],
        [environmentSecrets, environmentSecretError],
      ] = await sessionSpan("credentials.read", () =>
        Promise.all([
          resolveSessionModelRuntime(
            workspaceId,
            snapshot.model,
            context.services.store,
            context.services.openAICodexAuthorization,
          ),
          context.services.store.getGitHubToken(workspaceId),
          context.services.store.getEnvironmentSecrets(workspaceId),
        ]));
      if (modelCredentialError !== undefined) {
        return apiError("The saved model provider credential could not be read.", 500);
      }
      if (gitCredentialError !== undefined) {
        return apiError("The saved GitHub credential could not be read.", 500);
      }
      if (environmentSecretError !== undefined) {
        return apiError("The saved environment secrets could not be read.", 500);
      }
      if (modelRuntime === null) {
        return apiError("Reconfigure this session's model provider before continuing.", 409);
      }

      const woken = await sessionSpan("runner.wake", () =>
        Effect.runPromise(
          context.services.runnerConnections.wakeSession({
            workspaceId,
            sessionId,
            payload: {
              modelRuntime,
              ...(githubToken === null ? {} : { githubToken }),
              ...(environmentSecrets.length === 0 ? {} : { environmentSecrets }),
              ...(parsed.value.recovery === undefined ? {} : { recovery: parsed.value.recovery }),
            },
          }),
          { signal: context.request.signal },
        ));
      if (woken.status !== "accepted") {
        return apiError(woken.message, woken.status === "rejected" ? 409 : 503);
      }
      return Response.json(
        { status: "accepted" },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    },
    async changes(context) {
      sessionStage("changes.validate");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return apiError("Session not found.", 404);
      const parsed = s.parseSafe(updateGitFileSchema, context.formData);
      if (!parsed.success) {
        sessionRejection("invalid_git_file_update");
        return apiError(parsed.issues[0]?.message ?? "Invalid Git file update.", 400);
      }
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const updated = await sessionSpan("runner.git_file_update", () =>
        Effect.runPromise(
          context.services.runnerConnections.updateSessionGitFile({
            workspaceId,
            sessionId,
            action: parsed.value.action,
            path: parsed.value.path,
            ...(parsed.value.previousPath === undefined
              ? {}
              : { previousPath: parsed.value.previousPath }),
          }),
          { signal: context.request.signal },
        ));
      if (updated.status !== "accepted") {
        return apiError(updated.message, updated.status === "rejected" ? 409 : 503);
      }
      return Response.json(updated.acknowledgement, {
        headers: { "Cache-Control": "no-store" },
      });
    },
    async gitSnapshot(context) {
      sessionStage("gitSnapshot");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = context.params.sessionId;
      if (!s.parseSafe(sessionIdSchema, sessionId).success) {
        return new Response("Session not found.", { status: 404 });
      }
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Session not found.", { status: 404 });

      const result = await sessionSpan("runner.git_snapshot", () =>
        Effect.runPromise(
          context.services.runnerConnections.getSessionGitSnapshot(workspaceId, sessionId),
        ));
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
    async gitPatchChunk(context) {
      sessionStage("gitPatchChunk");
      const workspaceId = context.auth.identity.workspaceId;
      const params = Schema.decodeUnknownOption(gitPatchChunkParamsSchema)(context.params);
      if (Option.isNone(params)) {
        return apiError("The Git patch range is invalid.", 400);
      }
      const { sessionId, snapshotId, section, offset } = params.value;
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const result = await sessionSpan(
        "runner.git_patch_chunk",
        () =>
          Effect.runPromise(context.services.runnerConnections.readSessionGitPatchChunk({
            workspaceId,
            sessionId,
            snapshotId,
            section,
            offset,
          })),
      );
      if (result.status !== "accepted") {
        return apiError(result.message, result.status === "rejected" ? 409 : 503);
      }
      return Response.json({
        ...result.acknowledgement,
        bytes: encodeBase64(result.acknowledgement.bytes),
      }, {
        headers: { "Cache-Control": "no-store" },
      });
    },
    async artifact(context) {
      sessionStage("artifact");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      const artifactId = Schema.decodeUnknownOption(SessionArtifactId)(
        context.params.artifactId,
      );
      if (sessionId === null || Option.isNone(artifactId)) {
        return new Response("Published media not found.", { status: 404 });
      }
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Published media not found.", { status: 404 });

      const readChunk = (offset: number) =>
        Effect.runPromise(context.services.runnerConnections.readSessionArtifactChunk({
          workspaceId,
          sessionId,
          artifactId: artifactId.value,
          offset,
        }));
      const first = await sessionSpan("runner.artifact_chunk", () => readChunk(0));
      if (first.status !== "accepted") {
        return new Response(first.message, {
          status: first.status === "rejected" ? 400 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const artifact = first.acknowledgement.artifact;
      const range = parseByteRange(context.request.headers.get("range"), artifact.byteLength);
      if (range === null) {
        return new Response("Requested range not satisfiable.", {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "Content-Range": `bytes */${artifact.byteLength}`,
          },
        });
      }
      const responseLength = range.end - range.start + 1;
      const body = createArtifactStream({
        artifactId: artifact.id,
        byteLength: artifact.byteLength,
        ...(range.start === 0 ? { first: first.acknowledgement } : {}),
        range,
        readChunk,
      });
      const partial = context.request.headers.has("range");
      return new Response(body, {
        status: partial ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
          "Content-Disposition": `inline; filename="${
            safeContentDispositionName(artifact.fileName)
          }"`,
          "Content-Length": String(responseLength),
          "Content-Type": artifact.mediaType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          ...(partial
            ? { "Content-Range": `bytes ${range.start}-${range.end}/${artifact.byteLength}` }
            : {}),
        },
      });
    },
    async events(context) {
      sessionStage("events");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = context.params.sessionId;
      if (!s.parseSafe(sessionIdSchema, sessionId).success) {
        return new Response("Session not found.", { status: 404 });
      }
      const session = await sessionSpan(
        "catalog.lookup",
        () => context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Session not found.", { status: 404 });

      const afterCursor = parseCursor(context.request);
      if (afterCursor === null) {
        sessionRejection("invalid_event_cursor");
        return new Response("Invalid event cursor.", { status: 400 });
      }

      const stream = await sessionSpan("events.subscribe", () =>
        Effect.runPromise(
          createSessionEventStream(
            context.services.runnerConnections.watchSession(workspaceId, sessionId, afterCursor),
          ),
          { signal: context.request.signal },
        ));

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

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseByteRange(header: string | null, byteLength: number): ByteRange | null {
  if (header === null) return { start: 0, end: byteLength - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, byteLength - suffixLength), end: byteLength - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText === "" ? byteLength - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start < 0 || start >= byteLength || requestedEnd < start
  ) return null;
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
}

function createArtifactStream(options: {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly first?: SessionArtifactChunk;
  readonly range: ByteRange;
  readonly readChunk: (offset: number) => Promise<
    | { status: "accepted"; acknowledgement: SessionArtifactChunk }
    | { status: "rejected" | "unavailable" | "delivery-uncertain"; message: string }
  >;
}): ReadableStream<Uint8Array> {
  let offset = options.range.start;
  let first = options.first;
  return new ReadableStream({
    async pull(controller) {
      if (offset > options.range.end) {
        controller.close();
        return;
      }
      const result = first === undefined
        ? await options.readChunk(offset)
        : { status: "accepted" as const, acknowledgement: first };
      first = undefined;
      if (result.status !== "accepted") {
        controller.error(new Error("Published media became unavailable."));
        return;
      }
      const chunk = result.acknowledgement;
      if (
        chunk.artifact.id !== options.artifactId ||
        chunk.artifact.byteLength !== options.byteLength ||
        chunk.offset !== offset || chunk.bytes.byteLength === 0
      ) {
        controller.error(new Error("Published media returned an invalid chunk."));
        return;
      }
      const remaining = options.range.end - offset + 1;
      const bytes = chunk.bytes.byteLength > remaining
        ? chunk.bytes.subarray(0, remaining)
        : chunk.bytes;
      controller.enqueue(bytes);
      offset += bytes.byteLength;
      if (offset > options.range.end) controller.close();
    },
  });
}

function safeContentDispositionName(fileName: string): string {
  const safe = Array.from(fileName, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\"
      ? character
      : "_";
  }).join("");
  return safe || "media";
}

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
