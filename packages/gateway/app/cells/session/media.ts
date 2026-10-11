import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_TOTAL_BYTES,
} from "@openorb/protocol/runner-api";
import {
  SessionArtifactMediaType,
  type SessionArtifactMediaType as MediaType,
} from "@openorb/protocol/runner-bulk-api";
import { Schema } from "effect";

/** Agents publish media only from this guest directory (ADR 0003). */
export const ARTIFACTS_DIRECTORY = "/workspace/.openorb/artifacts";
/** R2 multipart parts; S3-backed buckets require at least 5 MiB for every part but the last. */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

/** The subset of an R2 binding the Session uses. */
export interface MediaBucket {
  createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<MediaUpload>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface MediaUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<{ readonly key: string }>;
  abort(): Promise<void>;
}

export interface PublishedMedia {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType: MediaType;
  readonly byteLength: number;
}

export function mediaPrefix(workspaceId: string, sessionId: string): string {
  return `workspaces/${workspaceId}/sessions/${sessionId}/media/`;
}

export function detectMediaType(bytes: Uint8Array): MediaType | null {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const ascii = (offset: number, text: string) =>
    Array.from(text).every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) return "video/mp4";
  if (starts([26, 69, 223, 163])) return "video/webm";
  return null;
}

/**
 * Copies a guest file from the artifacts directory into R2 in multipart pieces, so a video is
 * never held whole in the Durable Object. Only allowlisted media types are accepted.
 */
export async function publishGuestMedia(
  env: ExecutionEnv,
  bucket: MediaBucket,
  input: { path: string; prefix: string; usedBytes: number },
  context: Context,
): Promise<PublishedMedia> {
  const absolute = await env.absolutePath(input.path, context);
  if (!absolute.ok || !absolute.value.startsWith(`${ARTIFACTS_DIRECTORY}/`)) {
    throw new MediaError(`Published media must be under ${ARTIFACTS_DIRECTORY}`);
  }
  const opened = await env.openBinaryReader(absolute.value, { noFollow: true }, context);
  if (!opened.ok) throw new MediaError(`The file could not be opened: ${opened.error.message}`);
  using cleanup = new DisposableStack();
  cleanup.defer(() => void opened.value.close(context));
  const info = await opened.value.info(context);
  if (!info.ok || info.value.kind !== "file") {
    throw new MediaError("Published media must be a file.");
  }
  const size = info.value.size;
  if (size === 0 || size > MAX_SESSION_ARTIFACT_BYTES) {
    throw new MediaError(`Published media must be 1 byte to ${MAX_SESSION_ARTIFACT_BYTES} bytes.`);
  }
  if (input.usedBytes + size > MAX_SESSION_ARTIFACT_TOTAL_BYTES) {
    throw new MediaError("This session's published media quota is exhausted.");
  }
  const head = await opened.value.read(0, Math.min(size, 64), context);
  const mediaType = head.ok ? detectMediaType(head.value) : null;
  if (mediaType === null) {
    throw new MediaError("Published media must be PNG, JPEG, GIF, WebP, MP4, or WebM");
  }
  const id = crypto.randomUUID();
  const upload = await bucket.createMultipartUpload(`${input.prefix}${id}`, {
    httpMetadata: { contentType: mediaType },
  });
  const parts: { partNumber: number; etag: string }[] = [];
  for (let offset = 0; offset < size; offset += UPLOAD_PART_BYTES) {
    const chunk = await opened.value.read(
      offset,
      Math.min(UPLOAD_PART_BYTES, size - offset),
      context,
    );
    if (!chunk.ok) {
      await upload.abort();
      throw new MediaError("The file changed or could not be read while publishing.");
    }
    parts.push(await upload.uploadPart(parts.length + 1, chunk.value));
  }
  await upload.complete(parts);
  const name = absolute.value.slice(absolute.value.lastIndexOf("/") + 1);
  return { id, fileName: name, mediaType, byteLength: size };
}

/** Deletes every published object of a Session. */
export async function deleteSessionMedia(bucket: MediaBucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

/** A stable identifier for an inline conversation image: a UUIDv8 of its content hash. */
export async function inlineImageId(mediaType: string, data: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mediaType}\0${data}`)),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20, 32)
  }`;
}

export interface InlineImageSink {
  /** Records where an inline image lives so its bytes can be served from Harness State. */
  readonly found: (id: string, mediaType: MediaType, entryId: number | undefined) => void;
}

/**
 * The transport replica of a Conversation View: inline images become artifact references served
 * from Harness State; Durable and model messages keep their bytes (ADR 0005). Unchanged subtrees
 * project to the same objects, so viewers' diffs stay small.
 */
export class ConversationProjection {
  readonly #cache = new WeakMap<object, JsonValue>();
  readonly #sink: InlineImageSink;

  constructor(sink: InlineImageSink) {
    this.#sink = sink;
  }

  async project(view: ConversationView): Promise<JsonValue> {
    const entries: JsonValue[] = [];
    for (const entry of view.entries) {
      entries.push(await this.#node(asJson(entry), entry.id));
    }
    const docs: Record<string, JsonValue> = {};
    for (const [kind, doc] of Object.entries(view.docs)) {
      docs[kind] = await this.#node(asJson(doc), undefined);
    }
    return { conversation: asJson(view.conversation), entries, docs };
  }

  async #node(value: JsonValue, entryId: number | undefined): Promise<JsonValue> {
    if (value === null || !isObject(value) && !Array.isArray(value)) return value;
    const cached = this.#cache.get(value);
    if (cached !== undefined) return cached;
    let result: JsonValue;
    if (Array.isArray(value)) {
      result = [];
      for (const child of value) result.push(await this.#node(child, entryId));
    } else if (value.type === "image" && "data" in value) {
      result = await this.#image(value, entryId);
    } else {
      const projected: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        projected[key] = await this.#node(child, entryId);
      }
      result = projected;
    }
    this.#cache.set(value, result);
    return result;
  }

  async #image(
    value: { readonly [key: string]: JsonValue },
    entryId: number | undefined,
  ): Promise<JsonValue> {
    const mediaType = Schema.decodeUnknownOption(SessionArtifactMediaType)(value.mimeType);
    const data = value.data;
    if (mediaType._tag === "None" || !mediaType.value.startsWith("image/") || !isString(data)) {
      return { type: "image", text: "[Image unavailable: unsupported format]" };
    }
    const id = await inlineImageId(mediaType.value, data);
    this.#sink.found(id, mediaType.value, entryId);
    return { type: "image", artifactId: id };
  }
}

/** Finds an inline image's bytes in a Harness State subtree by its identifier. */
export async function findInlineImage(
  value: JsonValue,
  id: string,
): Promise<{ mediaType: MediaType; bytes: Uint8Array } | undefined> {
  if (value === null || !isObject(value) && !Array.isArray(value)) return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = await findInlineImage(child, id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value.type === "image" && isString(value.data)) {
    const mediaType = Schema.decodeUnknownOption(SessionArtifactMediaType)(value.mimeType);
    if (mediaType._tag === "Some" && await inlineImageId(mediaType.value, value.data) === id) {
      return { mediaType: mediaType.value, bytes: Uint8Array.fromBase64(value.data) };
    }
  }
  for (const child of Object.values(value)) {
    const found = await findInlineImage(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && !Array.isArray(value) && Schema.is(JsonRecord)(value);
}

function isString(value: JsonValue | undefined): value is string {
  return Schema.is(Schema.String)(value);
}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

/** Durable's readonly JSON records are Chord JSON values; projection only reads them. */
export function asJson(
  value:
    | ConversationView["conversation"]
    | ConversationView["entries"][number]
    | ConversationView["docs"][string],
): JsonValue {
  // SAFETY: Conversation Views are JSON documents; this only widens readonly modifiers.
  return value as JsonValue;
}
