import { test } from "vite-plus/test";
import { assertEquals, assertRejects } from "@jsr/std__assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type BinaryReader, type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { MAX_RUNNER_BULK_CHUNK_BYTES } from "@openorb/protocol/runner-api";
import {
  generateGitSnapshot,
  GIT_SNAPSHOT_DIRECTORY,
  GitSnapshotError,
  readGitPatchChunk,
  staleGitSnapshot,
} from "../app/cells/session/git-snapshot.ts";

/** A guest holding one stored patch file; nothing else is reachable. */
function guestWithPatch(path: string, patch: Uint8Array): ExecutionEnv {
  const reader: Partial<BinaryReader> = {
    read: (offset, length) =>
      Promise.resolve({ ok: true, value: patch.subarray(offset, offset + length) }),
    close: () => Promise.resolve(),
  };
  const fake: Partial<ExecutionEnv> = {
    openBinaryReader: (requested) =>
      Promise.resolve(
        requested === path
          ? // SAFETY: the chunk reader calls only read and close.
            { ok: true, value: reader as BinaryReader }
          : { ok: false, error: new FileError("not_found", "missing", requested) },
      ),
  };
  // SAFETY: readGitPatchChunk calls only openBinaryReader.
  return fake as ExecutionEnv;
}

const encoder = new TextEncoder();
const patchPath = `${GIT_SNAPSHOT_DIRECTORY}/snapshot-1/unstaged.patch`;

test("patch chunks keep byte offsets while neutralizing terminal and bidi controls", async () => {
  const patch = encoder.encode("+a\x1b[31m‮b\u0085c\td\n");
  const chunk = await readGitPatchChunk(
    guestWithPatch(patchPath, patch),
    "snapshot-1",
    "unstaged",
    0,
    patch.length,
    BACKGROUND_CONTEXT,
  );
  assertEquals(chunk.bytes.length, patch.length);
  assertEquals(new TextDecoder().decode(chunk.bytes), "+a?[31m�b¿c\td\n");
  assertEquals(chunk.nextOffset, patch.length);
  assertEquals(chunk.done, true);
});

test("patch chunks end on UTF-8 boundaries so pages decode independently", async () => {
  const filler = "x".repeat(MAX_RUNNER_BULK_CHUNK_BYTES - 1);
  const patch = encoder.encode(`${filler}é tail\n`);
  const env = guestWithPatch(patchPath, patch);
  const first = await readGitPatchChunk(
    env,
    "snapshot-1",
    "unstaged",
    0,
    patch.length,
    BACKGROUND_CONTEXT,
  );
  assertEquals(first.nextOffset, MAX_RUNNER_BULK_CHUNK_BYTES - 1);
  assertEquals(first.done, false);
  const second = await readGitPatchChunk(
    env,
    "snapshot-1",
    "unstaged",
    first.nextOffset,
    patch.length,
    BACKGROUND_CONTEXT,
  );
  assertEquals(new TextDecoder().decode(second.bytes), "é tail\n");
  assertEquals(second.done, true);
  const past = await readGitPatchChunk(
    env,
    "snapshot-1",
    "unstaged",
    patch.length,
    patch.length,
    BACKGROUND_CONTEXT,
  );
  assertEquals(past, { bytes: new Uint8Array(), nextOffset: patch.length, done: true });
});

test("a replaced snapshot's patch is reported as gone", async () => {
  await assertRejects(
    () =>
      readGitPatchChunk(
        guestWithPatch(patchPath, encoder.encode("x")),
        "snapshot-2",
        "unstaged",
        0,
        1,
        BACKGROUND_CONTEXT,
      ),
    GitSnapshotError,
    "no longer in the environment",
  );
});

test("snapshots before the checkout exists never reach the guest", async () => {
  const fake: Partial<ExecutionEnv> = {};
  // SAFETY: an incomplete checkout returns before any guest call; any call would throw.
  const snapshot = await generateGitSnapshot(
    fake as ExecutionEnv,
    { checkoutState: "pending" },
    BACKGROUND_CONTEXT,
  );
  assertEquals(snapshot.completeness, "incomplete");
  assertEquals([snapshot.snapshotId, snapshot.sections.unstaged.files], [undefined, []]);
});

test("a failed refresh keeps the last snapshot, marked stale", () => {
  const stale = staleGitSnapshot();
  assertEquals([stale.stale, stale.completeness], [true, "incomplete"]);
  const again = staleGitSnapshot(stale);
  assertEquals(again.generatedAt, stale.generatedAt);
  assertEquals(again.stale, true);
});
