import { test } from "vite-plus/test";
import { assert, assertEquals, assertRejects, assertThrows } from "@jsr/std__assert";
import { Schema } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type BinaryReader, type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import {
  generateGitSnapshot,
  GIT_SNAPSHOT_DIRECTORY,
  GitSnapshotError,
  readGitPatchChunk,
  staleGitSnapshot,
} from "../app/cells/session/git-snapshot.ts";
import {
  MAX_GIT_PATCH_CHUNK_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  SessionGitSnapshot,
} from "../app/cells/session/git-snapshot-schema.ts";

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
  const filler = "x".repeat(MAX_GIT_PATCH_CHUNK_BYTES - 1);
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
  assertEquals(first.nextOffset, MAX_GIT_PATCH_CHUNK_BYTES - 1);
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

test("SessionGitSnapshot rejects payloads that would exceed its JSON budgets", () => {
  const largeFiles = Array.from({ length: 5_000 }, (_, index) => {
    const path = `${index}-${"x".repeat(220)}`;
    return {
      kind: "tracked" as const,
      path,
      displayPath: path,
      status: "modified" as const,
      diffState: "available" as const,
    };
  });
  assertEquals(largeFiles.length, 5_000);
  assert(byteLength(JSON.stringify(largeFiles)) > MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES);
  const oversizedFilesSnapshot = gitSnapshot({ unstagedFiles: largeFiles });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedFilesSnapshot));

  const escapingPatch = "\u001b".repeat(40_000);
  assert(byteLength(escapingPatch) < MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES);
  assert(
    byteLength(JSON.stringify(escapingPatch)) > MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  );
  const oversizedPatchSnapshot = gitSnapshot({
    stagedPatch: escapingPatch,
  });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedPatchSnapshot));

  const individuallyValidPatch = "\u001b".repeat(17_000);
  assert(
    byteLength(JSON.stringify(individuallyValidPatch)) <
      MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  );
  assert(
    byteLength(
      JSON.stringify({
        staged: individuallyValidPatch,
        unstaged: individuallyValidPatch,
      }),
    ) > MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  );
  const oversizedCombinedPatches = gitSnapshot({
    stagedPatch: individuallyValidPatch,
    unstagedPatch: individuallyValidPatch,
  });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedCombinedPatches));
});

test("SessionGitSnapshot rejects excess keys at every nesting level despite permissive decoding", () => {
  const snapshot = gitSnapshot();
  const decode = Schema.decodeUnknownSync(SessionGitSnapshot, { onExcessProperty: "ignore" });
  assertEquals<object>(Schema.encodeSync(SessionGitSnapshot)(decode(snapshot)), snapshot);
  const sections = snapshot.sections;
  for (const candidate of [
    { ...snapshot, extra: true },
    { ...snapshot, sections: { ...sections, extra: true } },
    { ...snapshot, sections: { ...sections, staged: { ...sections.staged, extra: true } } },
    { ...snapshot, sections: { ...sections, unstaged: { ...sections.unstaged, extra: true } } },
    gitSnapshot({
      unstagedFiles: [
        {
          kind: "tracked",
          path: "src/main.ts",
          displayPath: "src/main.ts",
          status: "modified",
          diffState: "available",
          previousPath: "not-a-rename.ts",
        },
      ],
    }),
  ]) {
    assertThrows(() => decode(candidate));
  }
});

test("SessionGitSnapshot accepts only explicit section-owned file states", () => {
  const oldFlatSnapshot = {
    generatedAt: "2026-08-23T12:00:00Z",
    completeness: "complete",
    stale: false,
    truncated: false,
    summary: { changed: 1, staged: 1, unstaged: 0, untracked: 0 },
    files: [],
    patches: { staged: "", unstaged: "" },
  };
  const contradictoryTrackedFile = gitSnapshot({
    unstagedFiles: [
      {
        kind: "tracked",
        path: "src/main.ts",
        displayPath: "src/main.ts",
        status: "modified",
        staged: "modified",
        diffState: "available",
      },
    ],
  });
  const invalidUntrackedFile = gitSnapshot({
    unstagedFiles: [
      {
        kind: "untracked",
        path: "new.txt",
        displayPath: "new.txt",
        status: "modified",
        diffState: "available",
      },
    ],
  });
  const stagedUntrackedFile = gitSnapshot({
    stagedFiles: [
      {
        kind: "untracked",
        path: "new.txt",
        displayPath: "new.txt",
        status: "added",
        diffState: "available",
      },
    ],
  });
  const incompleteRename = gitSnapshot({
    stagedFiles: [
      {
        kind: "tracked",
        path: "new.ts",
        displayPath: "new.ts",
        status: "renamed",
        diffState: "available",
      },
    ],
  });

  for (const candidate of [
    oldFlatSnapshot,
    contradictoryTrackedFile,
    invalidUntrackedFile,
    stagedUntrackedFile,
    incompleteRename,
  ]) {
    assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(candidate));
  }
});

test("Git Snapshot paths preserve exact mutation operands separately from display text", () => {
  const path = "src/literal*\nname.ts";
  const displayPath = "src/literal*\\u{A}name.ts";
  const previousPath = "src/old?\nname.ts";
  const previousDisplayPath = "src/old?\\u{A}name.ts";
  const candidate = gitSnapshot({
    stagedFiles: [
      {
        kind: "tracked",
        path,
        displayPath,
        previousPath,
        previousDisplayPath,
        status: "renamed",
        diffState: "available",
      },
    ],
  });

  const decoded = Schema.decodeUnknownSync(SessionGitSnapshot)(candidate);
  assertEquals(decoded.sections.staged.files[0]?.path, path);
  assertEquals(decoded.sections.staged.files[0]?.displayPath, displayPath);
});

test("SessionGitSnapshot accepts payloads that fill its file and patch budgets", () => {
  const files: Array<{
    kind: "tracked";
    path: string;
    displayPath: string;
    status: "modified";
    diffState: "available";
  }> = [];
  for (let index = 0; index < 1_000; index++) {
    const path = `${index}-${"x".repeat(4_090 - String(index).length)}`;
    const file = {
      kind: "tracked" as const,
      path,
      displayPath: path,
      status: "modified" as const,
      diffState: "available" as const,
    };
    if (byteLength(JSON.stringify([...files, file])) > MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES)
      break;
    files.push(file);
  }
  const largestFileBytes = Math.max(...files.map((file) => byteLength(JSON.stringify(file)) + 1));
  assert(
    byteLength(JSON.stringify(files)) >
      MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES - largestFileBytes,
  );

  const patchJsonBudget = Math.floor((MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES - 64) / 2);
  const patch = "\n".repeat(Math.floor((patchJsonBudget - 2) / 2));
  assertEquals(byteLength(JSON.stringify(patch)), patchJsonBudget);
  const candidate = gitSnapshot({
    unstagedFiles: files,
    stagedPatch: patch,
    unstagedPatch: patch,
  });
  Schema.decodeUnknownSync(SessionGitSnapshot)(candidate);
});

function gitSnapshot(
  overrides: {
    readonly stagedFiles?: ReadonlyArray<object>;
    readonly unstagedFiles?: ReadonlyArray<object>;
    readonly stagedPatch?: string;
    readonly unstagedPatch?: string;
  } = {},
) {
  return {
    mutationRevision: 0,
    generatedAt: "2026-08-23T12:00:00Z",
    branch: "openorb/session",
    head: "0123456789abcdef0123456789abcdef01234567",
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: {
        files: overrides.stagedFiles ?? [],
        patch: overrides.stagedPatch ?? "",
        truncated: false,
      },
      unstaged: {
        files: overrides.unstagedFiles ?? [],
        patch: overrides.unstagedPatch ?? "",
        truncated: false,
      },
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
