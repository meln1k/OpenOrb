import { assert, assertEquals, assertStrictEquals } from "@std/assert";

import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import {
  type PreparedSessionChangeRow,
  projectPendingSessionChanges,
  reconcileSessionChangeItems,
  type SessionChangeItemRecord,
  sessionChangeMutationPaths,
  sessionChangeRowKey,
  toggleSessionChangeItem,
} from "@/app/ui/session/session-change-items.ts";

Deno.test("collapsed renderable changes stay lightweight until expanded", () => {
  const row = changeRow("unstaged", "src/value.ts", "before", "after", "initial");
  const initial = reconcileSessionChangeItems([row], new Map());
  const collapsed = initial.items[0];
  if (collapsed === undefined) throw new Error("Missing initial item.");

  assertEquals(collapsed.type, "file");
  assertEquals(collapsed.collapsed, true);

  const expanded = toggleSessionChangeItem(row, collapsed);
  assertEquals(expanded.type, "diff");
  assertEquals(expanded.collapsed, false);
  if (expanded.type === "diff") assertStrictEquals(expanded.fileDiff, row.fileDiff);

  const recollapsed = toggleSessionChangeItem(row, expanded);
  assertEquals(recollapsed.type, "file");
  assertEquals(recollapsed.collapsed, true);
});

Deno.test("unchanged snapshots retain the exact Pierre item", () => {
  const initialRow = changeRow("unstaged", "src/value.ts", "before", "after", "initial");
  const initial = reconcileSessionChangeItems([initialRow], new Map());
  const expanded = expandItem(initial.records, initialRow.key);

  const refreshedRow = changeRow("unstaged", "src/value.ts", "before", "after", "refresh");
  const refreshed = reconcileSessionChangeItems([refreshedRow], expanded);

  assertStrictEquals(refreshed.items[0], expanded.get(initialRow.key)?.item);
  assertEquals(refreshed.items[0]?.collapsed, false);
});

Deno.test("a changed file invalidates only its own Pierre item", () => {
  const firstRows = [
    changeRow("unstaged", "src/one.ts", "one", "first", "initial"),
    changeRow("unstaged", "src/two.ts", "two", "second", "initial"),
  ];
  const first = reconcileSessionChangeItems(firstRows, new Map());
  const nextRows = [
    changeRow("unstaged", "src/one.ts", "one", "first", "refresh"),
    changeRow("unstaged", "src/two.ts", "two", "changed", "refresh"),
  ];
  const next = reconcileSessionChangeItems(nextRows, first.records);

  assertStrictEquals(next.items[0], first.items[0]);
  assert(next.items[1] !== first.items[1]);
  assertEquals(next.items[1]?.version, 1);
});

Deno.test("collapse state follows an unambiguous stage transition", () => {
  const unstaged = changeRow("unstaged", "src/value.ts", "before", "after", "unstaged");
  const initial = reconcileSessionChangeItems([unstaged], new Map());
  const expanded = expandItem(initial.records, unstaged.key);
  const staged = changeRow("staged", "src/value.ts", "before", "after", "staged");

  const moved = reconcileSessionChangeItems([staged], expanded);

  assertEquals(moved.items[0]?.id, staged.key);
  assertEquals(moved.items[0]?.collapsed, false);
});

Deno.test("collapse state follows an unambiguous rename", () => {
  const original = changeRow("unstaged", "src/old.ts", "before", "after", "original");
  const initial = reconcileSessionChangeItems([original], new Map());
  const expanded = expandItem(initial.records, original.key);
  const renamedBase = changeRow("unstaged", "src/new.ts", "before", "after", "renamed");
  const renamedFile = {
    kind: "tracked" as const,
    path: renamedBase.file.path,
    displayPath: renamedBase.file.displayPath,
    status: "renamed" as const,
    diffState: "available" as const,
    previousPath: original.file.path,
    previousDisplayPath: original.file.displayPath,
  };
  const renamed = {
    ...renamedBase,
    key: sessionChangeRowKey("unstaged", renamedFile),
    file: renamedFile,
  };

  const moved = reconcileSessionChangeItems([renamed], expanded);

  assertEquals(moved.items[0]?.collapsed, false);
});

Deno.test("an existing destination keeps its own collapse state", () => {
  const staged = changeRow("staged", "src/value.ts", "base", "index", "initial");
  const unstaged = changeRow("unstaged", "src/value.ts", "index", "worktree", "initial");
  const initial = reconcileSessionChangeItems([unstaged, staged], new Map());
  const expandedUnstaged = expandItem(initial.records, unstaged.key);
  const nextStaged = changeRow("staged", "src/value.ts", "base", "worktree", "next");

  const moved = reconcileSessionChangeItems([nextStaged], expandedUnstaged);

  assertEquals(moved.items[0]?.collapsed, true);
});

Deno.test("pending file intents optimistically move the latest logical file state", () => {
  const unstaged = changeRow("unstaged", "src/value.ts", "before", "after", "unstaged");
  const staged = projectPendingSessionChanges([unstaged], [{
    action: "stage",
    ambiguousDiff: false,
    generation: 1,
    path: unstaged.file.path,
    row: unstaged,
  }]);

  assertEquals(staged.length, 1);
  assertEquals(staged[0]?.state, "staged");
  assertEquals(staged[0]?.pending, { path: "src/value.ts", requestPending: true });
  assertStrictEquals(staged[0]?.fileDiff, unstaged.fileDiff);

  const optimisticStaged = staged[0];
  if (optimisticStaged === undefined) throw new Error("Missing optimistic staged row.");
  const latest = projectPendingSessionChanges([unstaged], [{
    action: "unstage",
    ambiguousDiff: false,
    generation: 2,
    path: unstaged.file.path,
    row: optimisticStaged,
  }]);

  assertEquals(latest.length, 1);
  assertEquals(latest[0]?.state, "unstaged");
  assertEquals(latest[0]?.pending, { path: "src/value.ts", requestPending: true });
});

Deno.test("pending intents do not present either half of a combined diff as authoritative", () => {
  const staged = changeRow("staged", "src/value.ts", "base", "index", "staged");
  const unstaged = changeRow("unstaged", "src/value.ts", "index", "worktree", "unstaged");

  const projected = projectPendingSessionChanges([unstaged, staged], [{
    action: "stage",
    ambiguousDiff: true,
    generation: 1,
    path: unstaged.file.path,
    row: unstaged,
  }]);

  assertEquals(projected.length, 1);
  assertEquals(projected[0]?.state, "staged");
  assertEquals(projected[0]?.fileDiff, undefined);
  assertEquals(projected[0]?.stats, undefined);
  assertEquals(projected[0]?.fallback, "Updating the combined diff…");

  const retained = projectPendingSessionChanges([], [{
    action: "stage",
    ambiguousDiff: true,
    generation: 1,
    path: unstaged.file.path,
    row: unstaged,
  }]);
  assertEquals(retained.length, 1);
  assertEquals(retained[0]?.fileDiff, undefined);
  assertEquals(retained[0]?.stats, undefined);
  assertEquals(retained[0]?.fallback, "Updating the combined diff…");
});

Deno.test("pending intent uses newer confirmed source contents before its captured row", () => {
  const captured = changeRow("unstaged", "src/value.ts", "base", "clicked", "captured");
  const refreshed = changeRow("unstaged", "src/value.ts", "base", "refreshed", "refreshed");

  const projected = projectPendingSessionChanges([refreshed], [{
    action: "stage",
    ambiguousDiff: false,
    generation: 1,
    path: captured.file.path,
    row: captured,
  }]);

  assertEquals(projected.length, 1);
  assertEquals(projected[0]?.state, "staged");
  assertStrictEquals(projected[0]?.fileDiff, refreshed.fileDiff);
});

Deno.test("pending rename identity survives projection through a modified destination row", () => {
  const renamedBase = changeRow("staged", "src/new.ts", "old", "index", "renamed");
  const renamedFile = {
    kind: "tracked" as const,
    path: renamedBase.file.path,
    displayPath: renamedBase.file.displayPath,
    status: "renamed" as const,
    diffState: renamedBase.file.diffState,
    previousPath: "src/old.ts",
    previousDisplayPath: "src/old.ts",
  };
  const renamed = {
    ...renamedBase,
    key: sessionChangeRowKey("staged", renamedFile),
    file: renamedFile,
  };
  const modified = changeRow("unstaged", "src/new.ts", "index", "working", "modified");

  const projected = projectPendingSessionChanges([modified, renamed], [{
    action: "unstage",
    ambiguousDiff: true,
    generation: 1,
    path: renamedFile.path,
    previousPath: renamedFile.previousPath,
    row: renamed,
  }]);
  const pending = projected[0];
  if (pending === undefined) throw new Error("Missing pending rename row.");

  assertEquals(pending.state, "unstaged");
  assertEquals(sessionChangeMutationPaths(pending), {
    path: "src/new.ts",
    previousPath: "src/old.ts",
  });
});

function changeRow(
  state: "staged" | "unstaged",
  path: string,
  before: string,
  after: string,
  cacheKey: string,
): PreparedSessionChangeRow {
  const file = {
    kind: "tracked" as const,
    path,
    displayPath: path,
    status: "modified" as const,
    diffState: "available" as const,
  };
  return {
    key: sessionChangeRowKey(state, file),
    label: state === "staged" ? "Staged" : "Unstaged",
    state,
    startsSection: true,
    file,
    fileDiff: parseFileDiff(path, before, after, cacheKey),
    fallback: "No renderable patch is available for this file.",
    stats: { additions: 1, deletions: 1 },
  };
}

function parseFileDiff(
  path: string,
  before: string,
  after: string,
  cacheKey: string,
): FileDiffMetadata {
  const patch = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
  const fileDiff = parsePatchFiles(patch, cacheKey)[0]?.files[0];
  if (fileDiff === undefined) throw new Error("Test patch did not produce a file diff.");
  return fileDiff;
}

function expandItem(
  records: ReadonlyMap<string, SessionChangeItemRecord>,
  id: string,
): ReadonlyMap<string, SessionChangeItemRecord> {
  const record = records.get(id);
  if (record === undefined) throw new Error(`Missing test item ${id}.`);
  return new Map(records).set(id, {
    ...record,
    item: toggleSessionChangeItem(record.row, record.item),
  });
}
