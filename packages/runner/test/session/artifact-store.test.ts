import { assertEquals, assertRejects } from "@std/assert";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Layer, Schema } from "effect";
import { join } from "node:path";

import {
  makeSessionArtifactStore,
  SessionArtifactStoreError,
} from "@/src/session/artifact-store.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const platform = Layer.merge(DenoFileSystem.layer, DenoPath.layer);

Deno.test("published session media remains private, immutable, and readable in ranges", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(workingDirectory, "sessions", SESSION_ID), {
      recursive: true,
      mode: 0o700,
    });
    const store = await Effect.runPromise(
      makeSessionArtifactStore({ workingDirectory }).pipe(Effect.provide(platform)),
    );
    const artifact = await Effect.runPromise(store.publish(SESSION_ID, {
      fileName: "demo.webm",
      mediaType: "video/webm",
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
    }));

    const artifactDirectory = join(workingDirectory, "sessions", SESSION_ID, "artifacts");
    assertEquals((await Deno.stat(artifactDirectory)).mode! & 0o777, 0o700);
    for (const extension of ["bin", "json"]) {
      assertEquals(
        (await Deno.stat(join(artifactDirectory, `${artifact.id}.${extension}`))).mode! & 0o777,
        0o600,
      );
    }
    const first = await Effect.runPromise(store.readChunk(SESSION_ID, artifact.id, 2, 3));
    assertEquals(first.artifact, artifact);
    assertEquals(first.bytes, new Uint8Array([3, 4, 5]));

    const restarted = await Effect.runPromise(
      makeSessionArtifactStore({ workingDirectory }).pipe(Effect.provide(platform)),
    );
    const final = await Effect.runPromise(restarted.readChunk(SESSION_ID, artifact.id, 5, 3));
    assertEquals(final.bytes, new Uint8Array([6]));
    await assertRejects(
      () => Effect.runPromise(restarted.readChunk(SESSION_ID, artifact.id, 7, 3)),
      SessionArtifactStoreError,
      "The session artifact range is invalid.",
    );
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("reconciles interrupted publications before quota accounting", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(workingDirectory, "sessions", SESSION_ID), {
      recursive: true,
      mode: 0o700,
    });
    const initial = await Effect.runPromise(
      makeSessionArtifactStore({ workingDirectory }).pipe(Effect.provide(platform)),
    );
    const committed = await Effect.runPromise(initial.publish(SESSION_ID, {
      fileName: "committed.webm",
      mediaType: "video/webm",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const artifactDirectory = join(workingDirectory, "sessions", SESSION_ID, "artifacts");
    const contentOnlyId = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
    const metadataTemporaryId = "01989d78-65ee-7f6a-a97e-0f16ad134c12";
    await Deno.writeFile(
      join(artifactDirectory, `${contentOnlyId}.bin`),
      new Uint8Array([4, 5, 6]),
    );
    await Deno.writeFile(
      join(artifactDirectory, `${metadataTemporaryId}.bin`),
      new Uint8Array([7, 8, 9]),
    );
    await Deno.writeTextFile(
      join(artifactDirectory, `${metadataTemporaryId}.json.interrupted.tmp`),
      '{"partial":',
    );
    await Deno.writeTextFile(join(artifactDirectory, "metadata-only.json.interrupted.tmp"), "{}");

    const restarted = await Effect.runPromise(
      makeSessionArtifactStore({ workingDirectory }).pipe(Effect.provide(platform)),
    );
    const published = await Effect.runPromise(restarted.publish(SESSION_ID, {
      fileName: "after-recovery.webm",
      mediaType: "video/webm",
      bytes: new Uint8Array([10, 11, 12]),
    }));

    assertEquals(
      await directoryEntries(artifactDirectory),
      [
        `${committed.id}.bin`,
        `${committed.id}.json`,
        `${published.id}.bin`,
        `${published.id}.json`,
      ].sort(),
    );
    const retained = await Effect.runPromise(restarted.readChunk(SESSION_ID, committed.id, 0, 3));
    assertEquals(retained.bytes, new Uint8Array([1, 2, 3]));
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

async function directoryEntries(path: string): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry.name);
  return entries.sort();
}
