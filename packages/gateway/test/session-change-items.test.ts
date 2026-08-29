import { assert, assertEquals, assertStrictEquals } from "@std/assert";

import { type CodeViewItem, type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import {
  type PreparedSessionChangeRow,
  reconcileSessionChangeItems,
  type SessionChangeItemRecord,
  sessionChangeRowKey,
} from "@/app/ui/session/session-change-items.ts";

Deno.test("unchanged snapshots retain the exact Pierre item", () => {
  const initialRow = changeRow("unstaged", "src/value.ts", "before", "after", "initial");
  const initial = reconcileSessionChangeItems([initialRow], new Map());
  const expanded = updateItem(initial.records, initialRow.key, (item) => ({
    ...item,
    collapsed: false,
    version: (item.version ?? 0) + 1,
  }));

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
  const expanded = updateItem(initial.records, unstaged.key, (item) => ({
    ...item,
    collapsed: false,
    version: (item.version ?? 0) + 1,
  }));
  const staged = changeRow("staged", "src/value.ts", "before", "after", "staged");

  const moved = reconcileSessionChangeItems([staged], expanded);

  assertEquals(moved.items[0]?.id, staged.key);
  assertEquals(moved.items[0]?.collapsed, false);
});

Deno.test("collapse state follows an unambiguous rename", () => {
  const original = changeRow("unstaged", "src/old.ts", "before", "after", "original");
  const initial = reconcileSessionChangeItems([original], new Map());
  const expanded = updateItem(initial.records, original.key, (item) => ({
    ...item,
    collapsed: false,
    version: (item.version ?? 0) + 1,
  }));
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
  const expandedUnstaged = updateItem(initial.records, unstaged.key, (item) => ({
    ...item,
    collapsed: false,
    version: (item.version ?? 0) + 1,
  }));
  const nextStaged = changeRow("staged", "src/value.ts", "base", "worktree", "next");

  const moved = reconcileSessionChangeItems([nextStaged], expandedUnstaged);

  assertEquals(moved.items[0]?.collapsed, true);
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

function updateItem(
  records: ReadonlyMap<string, SessionChangeItemRecord>,
  id: string,
  update: (item: CodeViewItem) => CodeViewItem,
): ReadonlyMap<string, SessionChangeItemRecord> {
  const record = records.get(id);
  if (record === undefined) throw new Error(`Missing test item ${id}.`);
  return new Map(records).set(id, { ...record, item: update(record.item) });
}
