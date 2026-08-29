import type { SessionGitFileData } from "../../../../protocol/src/browser-session-git-snapshot.ts";
import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";

export type SessionChangeFileState = "staged" | "unstaged";
export type SessionChangeDiffStats = {
  readonly additions: number;
  readonly deletions: number;
};

export type PreparedSessionChangeRow = {
  readonly key: string;
  readonly label: string;
  readonly state: SessionChangeFileState;
  readonly startsSection: boolean;
  readonly file: SessionGitFileData;
  readonly fileDiff?: FileDiffMetadata;
  readonly fallback: string;
  readonly stats?: SessionChangeDiffStats;
};

export type SessionChangeItemRecord = {
  readonly row: PreparedSessionChangeRow;
  readonly item: CodeViewItem;
};

export interface ReconciledSessionChangeItems {
  readonly items: readonly CodeViewItem[];
  readonly records: ReadonlyMap<string, SessionChangeItemRecord>;
}

export function reconcileSessionChangeItems(
  rows: readonly PreparedSessionChangeRow[],
  previous: ReadonlyMap<string, SessionChangeItemRecord>,
): ReconciledSessionChangeItems {
  const nextIds = new Set(rows.map((row) => row.key));
  const unmatchedRows = rows.filter((row) => !previous.has(row.key));
  const unmatchedPrevious = Array.from(previous.values()).filter((record) =>
    !nextIds.has(record.row.key)
  );
  const transitions = matchFileTransitions(unmatchedRows, unmatchedPrevious);
  const records = new Map<string, SessionChangeItemRecord>();
  const items = rows.map((row) => {
    const exact = previous.get(row.key);
    const prior = exact ?? transitions.get(row.key);
    const item = exact !== undefined && sameSessionChangeRow(exact.row, row)
      ? exact.item
      : createCodeViewItem(
        row,
        prior?.item.collapsed ?? true,
        exact === undefined ? 0 : (exact.item.version ?? 0) + 1,
      );
    records.set(row.key, { row, item });
    return item;
  });
  return { items, records };
}

export function isRenderableSessionChange(
  row: PreparedSessionChangeRow,
): row is PreparedSessionChangeRow & { readonly fileDiff: FileDiffMetadata } {
  return row.file.diffState === "available" && row.fileDiff !== undefined &&
    row.fileDiff.hunks.length > 0;
}

export function sessionChangeRowKey(
  state: SessionChangeFileState,
  file: SessionGitFileData,
): string {
  return JSON.stringify([state, filePreviousPath(file) ?? null, file.path]);
}

export function filePreviousPath(file: SessionGitFileData): string | undefined {
  return "previousPath" in file ? file.previousPath : undefined;
}

export function filePreviousDisplayPath(file: SessionGitFileData): string | undefined {
  return "previousDisplayPath" in file ? file.previousDisplayPath : undefined;
}

function createCodeViewItem(
  row: PreparedSessionChangeRow,
  collapsed: boolean,
  version: number,
): CodeViewItem {
  if (isRenderableSessionChange(row)) {
    return {
      id: row.key,
      type: "diff",
      fileDiff: row.fileDiff,
      collapsed,
      version,
    };
  }
  return {
    id: row.key,
    type: "file",
    file: {
      name: row.file.displayPath,
      contents: "",
      cacheKey: `${row.key}:fallback`,
    },
    collapsed,
    version,
  };
}

function sameSessionChangeRow(
  left: PreparedSessionChangeRow,
  right: PreparedSessionChangeRow,
): boolean {
  return left.label === right.label &&
    left.state === right.state &&
    left.startsSection === right.startsSection &&
    left.fallback === right.fallback &&
    JSON.stringify(left.file) === JSON.stringify(right.file) &&
    JSON.stringify(left.stats) === JSON.stringify(right.stats) &&
    sameFileDiff(left.fileDiff, right.fileDiff);
}

function sameFileDiff(
  left: FileDiffMetadata | undefined,
  right: FileDiffMetadata | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify({ ...left, cacheKey: undefined }) ===
    JSON.stringify({ ...right, cacheKey: undefined });
}

function matchFileTransitions(
  rows: readonly PreparedSessionChangeRow[],
  previous: readonly SessionChangeItemRecord[],
): ReadonlyMap<string, SessionChangeItemRecord> {
  const candidates = new Map<string, SessionChangeItemRecord[]>();
  const destinationCounts = new Map<string, number>();
  for (const row of rows) {
    for (const record of previous) {
      if (!sameLogicalFile(row.file, record.row.file)) continue;
      const rowCandidates = candidates.get(row.key) ?? [];
      rowCandidates.push(record);
      candidates.set(row.key, rowCandidates);
      destinationCounts.set(record.row.key, (destinationCounts.get(record.row.key) ?? 0) + 1);
    }
  }

  const transitions = new Map<string, SessionChangeItemRecord>();
  for (const row of rows) {
    const rowCandidates = candidates.get(row.key);
    if (rowCandidates?.length !== 1) continue;
    const record = rowCandidates[0];
    if (record !== undefined && destinationCounts.get(record.row.key) === 1) {
      transitions.set(row.key, record);
    }
  }
  return transitions;
}

function sameLogicalFile(left: SessionGitFileData, right: SessionGitFileData): boolean {
  const leftPrevious = filePreviousPath(left);
  const rightPrevious = filePreviousPath(right);
  return left.path === right.path ||
    left.path === rightPrevious ||
    leftPrevious === right.path ||
    leftPrevious !== undefined && leftPrevious === rightPrevious;
}
