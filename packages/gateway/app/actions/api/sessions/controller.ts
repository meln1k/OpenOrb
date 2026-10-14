import { MAX_SESSION_GIT_PATH_CHARACTERS, SessionId } from "@openorb/protocol/runner-api";
import {
  SessionArtifactId,
  SessionGitPatchSection,
  SessionGitSnapshotId,
} from "@openorb/protocol/runner-bulk-api";
import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { encodeBase64 } from "@jsr/std__encoding/base64";
import { validate as validateUuid } from "@jsr/std__uuid";

import type { Administrator } from "../../../cells/workspace/api.ts";
import {
  sessionApiTelemetry,
  sessionCsrfStage,
  sessionRejection,
  sessionSpan,
  sessionStage,
} from "./telemetry.ts";
import { csrf } from "../../../middleware/csrf.ts";
import { resolveSessionModelRuntime } from "../../../model-provider-runtime.ts";
import { routes } from "../../../routes.ts";
import { Option, Schema } from "effect";
import { tryAsync } from "@openorb/result";

const sessionIdSchema = s.string().refine(validateUuid, "Expected a session UUID.");
const gitPathSchema = s
  .string()
  .refine(
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
  offset: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

export default createController(routes.api.sessions, {
  middleware: [sessionApiTelemetry(), requireAuth<Administrator>(), sessionCsrfStage(), csrf()],
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
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const sessionApi = context.services.sessions(sessionId);
      const [snapshot] = await sessionSpan("session.view", () =>
        tryAsync(sessionApi.view(), () => "unavailable"),
      );
      if (!snapshot) return apiError("The session is unavailable.", 503);
      const [modelRuntime, modelCredentialError] = await sessionSpan("credentials.read", () =>
        resolveSessionModelRuntime(workspaceId, snapshot.model, context.services.workspace),
      );
      if (modelCredentialError !== undefined) {
        return apiError("The saved model provider credential could not be read.", 500);
      }
      if (modelRuntime === null) {
        return apiError("Reconfigure this session's model provider before continuing.", 409);
      }
      const [, wakeError] = await sessionSpan("session.wake", () =>
        tryAsync(sessionApi.wake(parsed.value.recovery), (cause) =>
          cause instanceof Error ? cause.message : "The session is unavailable.",
        ),
      );
      if (wakeError !== undefined) return apiError(wakeError, 503);
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
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const [updated, updateError] = await sessionSpan("session.git_file_update", () =>
        sessionCall(
          context.services.sessions(sessionId).updateGitFile({
            action: parsed.value.action,
            path: parsed.value.path,
            ...(parsed.value.previousPath === undefined
              ? {}
              : { previousPath: parsed.value.previousPath }),
          }),
        ),
      );
      if (updateError !== undefined) return apiError(updateError, 409);
      return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
    },
    async gitSnapshot(context) {
      sessionStage("gitSnapshot");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = context.params.sessionId;
      if (!s.parseSafe(sessionIdSchema, sessionId).success) {
        return new Response("Session not found.", { status: 404 });
      }
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Session not found.", { status: 404 });

      const [snapshot, snapshotError] = await sessionSpan("session.git_snapshot", () =>
        sessionCall(context.services.sessions(sessionId).gitSnapshot()),
      );
      if (snapshotError !== undefined) {
        return Response.json(
          { error: snapshotError },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    },
    async gitPatchChunk(context) {
      sessionStage("gitPatchChunk");
      const workspaceId = context.auth.identity.workspaceId;
      const params = Schema.decodeUnknownOption(gitPatchChunkParamsSchema)(context.params);
      if (Option.isNone(params)) {
        return apiError("The Git patch range is invalid.", 400);
      }
      const { sessionId, snapshotId, section, offset } = params.value;
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return apiError("Session not found.", 404);
      const [chunk, chunkError] = await sessionSpan("session.git_patch_chunk", () =>
        sessionCall(
          context.services.sessions(sessionId).gitPatchChunk({ snapshotId, section, offset }),
        ),
      );
      if (chunkError !== undefined) return apiError(chunkError, 409);
      return Response.json(
        {
          snapshotId,
          section,
          offset,
          bytes: encodeBase64(chunk.bytes),
          nextOffset: chunk.nextOffset,
          done: chunk.done,
        },
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
    },
    async artifact(context) {
      sessionStage("artifact");
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      const artifactId = Schema.decodeUnknownOption(SessionArtifactId)(context.params.artifactId);
      if (sessionId === null || Option.isNone(artifactId)) {
        return new Response("Published media not found.", { status: 404 });
      }
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Published media not found.", { status: 404 });

      const [media] = await sessionSpan("session.media", () =>
        sessionCall(context.services.sessions(sessionId).media(artifactId.value)),
      );
      if (!media) return new Response("Published media not found.", { status: 404 });
      const byteLength = media.kind === "published" ? media.byteLength : media.bytes.byteLength;
      const range = parseByteRange(context.request.headers.get("range"), byteLength);
      if (range === null) {
        return new Response("Requested range not satisfiable.", {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "Content-Range": `bytes */${byteLength}`,
          },
        });
      }
      const responseLength = range.end - range.start + 1;
      let body: BodyInit;
      if (media.kind === "inline") {
        body = media.bytes.slice(range.start, range.end + 1);
      } else {
        const object = await sessionSpan("media.read", () =>
          context.services.media.get(media.key, {
            range: { offset: range.start, length: responseLength },
          }),
        );
        if (object === null) return new Response("Published media not found.", { status: 404 });
        body = object.body;
      }
      const fileName =
        media.kind === "published"
          ? media.fileName
          : `image.${media.mediaType.slice("image/".length)}`;
      const partial = context.request.headers.has("range");
      return new Response(body, {
        status: partial ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
          "Content-Disposition": `inline; filename="${safeContentDispositionName(fileName)}"`,
          "Content-Length": String(responseLength),
          "Content-Type": media.mediaType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          ...(partial
            ? { "Content-Range": `bytes ${range.start}-${range.end}/${byteLength}` }
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
      const session = await sessionSpan("catalog.lookup", () =>
        context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
      );
      if (!session) return new Response("Session not found.", { status: 404 });

      return await sessionSpan("events.subscribe", () =>
        context.services.sessions(sessionId).events(context.request),
      );
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
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= byteLength ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
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

/** Session Durable Object calls; their errors carry user-facing messages across native RPC. */
async function sessionCall<T>(call: Promise<T>) {
  return await tryAsync(call, (cause) =>
    cause instanceof Error ? cause.message : "The session is unavailable.",
  );
}
