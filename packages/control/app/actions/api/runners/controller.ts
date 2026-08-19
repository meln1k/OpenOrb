import { type RunnerEnrollmentRequest, runnerEnrollmentRequestSchema } from "@openorb/protocol";
import { tryAsync, trySync } from "@openorb/result";
import { LimitedBytesTransformStream } from "@std/streams/limited-bytes-transform-stream";
import { ContentType } from "remix/headers/content-type";
import { parse } from "remix/data-schema";
import { createController } from "remix/router";

import { requestRateLimitKey } from "@/app/middleware/services.ts";
import { routes } from "@/app/routes.ts";

const MAX_ENROLLMENT_BODY_BYTES = 16 * 1024;

export default createController(routes.api.runners, {
  actions: {
    async enroll(context) {
      const limiter = context.services.runnerEnrollmentRateLimiter;
      const rateLimitKey = requestRateLimitKey(context.request);
      if (!limiter.allow(rateLimitKey)) {
        return Response.json({ error: "Too many enrollment attempts." }, { status: 429 });
      }

      const contentType = ContentType.from(context.request.headers.get("content-type"));
      if (contentType.mediaType?.toLowerCase() !== "application/json") {
        return Response.json({ error: "Expected application/json." }, { status: 415 });
      }

      const [rawBody, bodyError] = await tryAsync(
        Promise.resolve().then(() =>
          new Response(
            context.request.body?.pipeThrough(
              new LimitedBytesTransformStream(MAX_ENROLLMENT_BODY_BYTES, { error: true }),
            ),
          ).text()
        ),
        (cause) => new EnrollmentRequestReadError(cause),
      );
      if (bodyError !== undefined) {
        if (bodyError.cause instanceof RangeError) {
          return Response.json({ error: "Enrollment request is too large." }, { status: 413 });
        }
        return Response.json({ error: "Unable to read enrollment request." }, { status: 400 });
      }

      const [input, parseError] = trySync(
        (): RunnerEnrollmentRequest => parse(runnerEnrollmentRequestSchema, JSON.parse(rawBody)),
        () => new Error("Invalid enrollment request"),
      );
      if (parseError !== undefined) {
        return Response.json({ error: "Invalid enrollment request." }, { status: 400 });
      }

      const runner = await context.services.store.enrollRunner(input);
      if (!runner) {
        return Response.json({ error: "Invalid or revoked enrollment PSK." }, { status: 401 });
      }
      limiter.reset(rateLimitKey);
      return Response.json(runner, {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    },

    connect() {
      return new Response("WebSocket upgrade required.", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    },
  },
});

class EnrollmentRequestReadError extends Error {
  constructor(override readonly cause: unknown) {
    super("The runner enrollment request body could not be read.", { cause });
    this.name = "EnrollmentRequestReadError";
  }
}
