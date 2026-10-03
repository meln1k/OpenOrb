import type { JsonValue } from "@earendil-works/chord/delta";
import { ConversationViewSchema, type SessionId } from "@openorb/protocol/runner-api";
import { SessionArtifactMediaType } from "@openorb/protocol/runner-bulk-api";
import { Effect, Schema } from "effect";
import { Buffer } from "node:buffer";
import type { ConversationView } from "../harness/agent-harness.ts";
import type { SessionArtifactStore } from "./artifact-store.ts";

/** Project only the transport replica; Durable and model messages retain their inline images. */
export function conversationMedia(sessionId: SessionId, artifacts: SessionArtifactStore) {
  const cache = new WeakMap<object, JsonValue>();
  const project = (value: JsonValue): Effect.Effect<JsonValue> =>
    Effect.gen(function* () {
      // deno-lint-ignore openorb/no-runtime-typeof -- Traverse the validated Durable JSON view.
      if (value === null || typeof value !== "object") return value;
      const previous = cache.get(value);
      if (previous !== undefined) return previous;
      let result: JsonValue;
      if (!Array.isArray(value) && value.type === "image") {
        result = yield* Effect.gen(function* () {
          const mediaType = value.mimeType;
          if (!Schema.is(SessionArtifactMediaType)(mediaType) || !mediaType.startsWith("image/")) {
            return { type: "image", text: "[Image unavailable: unsupported format]" };
          }
          const data = yield* Schema.decodeUnknownEffect(Schema.String)(value.data);
          const bytes = Buffer.from(data, "base64");
          const artifact = yield* artifacts.publish(sessionId, {
            fileName: `image.${mediaType.slice("image/".length)}`,
            mediaType,
            bytes,
          });
          return { type: "image", artifactId: artifact.id };
        }).pipe(Effect.catch(() =>
          Effect.succeed({ type: "image", text: "[Image unavailable: media could not be stored]" })
        ));
      } else if (Array.isArray(value)) {
        result = yield* Effect.forEach(value, project);
      } else {
        result = Object.fromEntries(
          yield* Effect.forEach(
            Object.entries(value),
            ([key, child]) =>
              project(child).pipe(Effect.map((child) => [key, child])),
          ),
        );
      }
      cache.set(value, result);
      return result;
    });
  return (view: ConversationView): Effect.Effect<ConversationView> =>
    // SAFETY: Durable declares entries readonly; projection only reads the JSON tree.
    // deno-lint-ignore openorb/no-chained-type-assertions -- Adapt Durable's readonly JSON to Chord's mutable JSON type without mutation.
    project(view as unknown as JsonValue).pipe(
      Effect.map(Schema.decodeUnknownSync(ConversationViewSchema)),
    );
}
