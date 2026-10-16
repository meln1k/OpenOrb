import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@jsr/std__assert";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";
import {
  ConversationProjection,
  detectMediaType,
  findInlineImage,
  inlineImageId,
} from "../app/cells/session/media.ts";
import { SCRIPTED_PNG_BASE64 } from "./session-fixture.ts";

function view(
  entries: readonly JsonObject[],
  docs: Readonly<Record<string, JsonObject>> = {},
): ConversationView {
  // SAFETY: fixtures build the JSON shape of Conversation Views; projection reads only JSON, and
  // branded Durable identifiers cannot be constructed outside a Harness.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  return { conversation: {}, entries, docs } as unknown as ConversationView;
}

const image = { type: "image", mimeType: "image/png", data: SCRIPTED_PNG_BASE64 };

test("inline image identifiers are content-derived UUIDs", async () => {
  const id = await inlineImageId("image/png", SCRIPTED_PNG_BASE64);
  assertMatch(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assertEquals(await inlineImageId("image/png", SCRIPTED_PNG_BASE64), id);
  assert((await inlineImageId("image/jpeg", SCRIPTED_PNG_BASE64)) !== id);
});

test("projection replaces inline images with references and records where they live", async () => {
  const found: [string, string, number | undefined][] = [];
  const projection = new ConversationProjection({
    found: (id, mediaType, entryId) => found.push([id, mediaType, entryId]),
  });
  const entry = { id: 7, model: [{ role: "toolResult", content: [image] }] };
  const projected = await projection.project(
    view([entry], { "pi.live": { tools: [{ result: { content: [{ ...image }] } }] } }),
  );
  const id = await inlineImageId("image/png", SCRIPTED_PNG_BASE64);
  assert(!JSON.stringify(projected).includes(SCRIPTED_PNG_BASE64), "image bytes leaked");
  assert(JSON.stringify(projected).includes(`"artifactId":"${id}"`));
  assertEquals(found, [
    [id, "image/png", 7],
    [id, "image/png", undefined],
  ]);
});

test("projection rejects unsupported image types and reuses unchanged subtrees", async () => {
  const projection = new ConversationProjection({ found: () => {} });
  const entry = { id: 1, model: [{ content: [{ ...image, mimeType: "image/svg+xml" }] }] };
  const first = await projection.project(view([entry]));
  assert(JSON.stringify(first).includes("[Image unavailable: unsupported format]"));
  const second = await projection.project(view([entry, { id: 2, model: [] }]));
  // SAFETY: projections of views are JSON objects with an entries array.
  const entries = (value: unknown) => (value as { entries: unknown[] }).entries;
  assertStrictEquals(entries(second)[0], entries(first)[0]);
  assertNotStrictEquals(second, first);
  assertEquals(diffRevisions(first, second).length > 0, true);
});

test("inline images are found again in Harness State by identifier", async () => {
  const id = await inlineImageId("image/png", SCRIPTED_PNG_BASE64);
  const found = await findInlineImage({ model: [{ content: [{ type: "text" }, image] }] }, id);
  assertEquals(found?.mediaType, "image/png");
  assertEquals(found?.bytes, Uint8Array.fromBase64(SCRIPTED_PNG_BASE64));
  assertEquals(await findInlineImage({ content: [image] }, crypto.randomUUID()), undefined);
});

test("published media types come from content signatures, not names", () => {
  assertEquals(detectMediaType(Uint8Array.fromBase64(SCRIPTED_PNG_BASE64)), "image/png");
  assertEquals(detectMediaType(new TextEncoder().encode("<svg/>")), null);
});
