import type { SessionGitFileData } from "../../../../protocol/src/browser-session-git-snapshot.ts";
import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";

export type SessionChangeFileState = "staged" | "unstaged";
export type SessionChangeDiffStats = {
  readonly additions: number;
  readonly deletions: number;
};

export type SessionChangeMutationPaths = {
  readonly path: string;
  readonly previousPath?: string;
};

export type PreparedSessionChangeRow = {
  readonly key: string;
  readonly label: string;
  readonly state: SessionChangeFileState;
  readonly startsSection: boolean;
  readonly pending?: SessionChangeMutationPaths & { readonly requestPending: boolean };
  readonly file: SessionGitFileData;
  readonly fileDiff?: FileDiffMetadata;
  readonly fallback: string;
  readonly stats?: SessionChangeDiffStats;
};

export type PendingSessionChangeIntent = {
  readonly action: "stage" | "unstage";
  readonly generation: number;
  readonly path: string;
  readonly previousPath?: string;
  readonly ambiguousDiff: boolean;
  readonly acknowledgedRevision?: number;
  readonly row: PreparedSessionChangeRow;
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

export function toggleSessionChangeItem(
  row: PreparedSessionChangeRow,
  item: CodeViewItem,
): CodeViewItem {
  return createCodeViewItem(row, !item.collapsed, (item.version ?? 0) + 1);
}

export function projectPendingSessionChanges(
  rows: readonly PreparedSessionChangeRow[],
  pending: Iterable<PendingSessionChangeIntent>,
): readonly PreparedSessionChangeRow[] {
  let projected = [...rows];
  const intents = Array.from(pending).sort((left, right) => left.generation - right.generation);
  for (const intent of intents) {
    const matching = projected.filter((row) =>
      sessionChangeFileMatches(row.file, intent.path, intent.previousPath)
    );
    const targetState = intent.action === "stage" ? "staged" as const : "unstaged" as const;
    const sourceState = targetState === "staged" ? "unstaged" : "staged";
    const target = matching.find((row) => row.state === targetState) ??
      matching.find((row) => row.state === sourceState) ?? intent.row;
    const optimistic = optimisticSessionChangeRow(
      target,
      targetState,
      intent,
      intent.ambiguousDiff || matching.length > 1,
    );
    projected = [
      ...projected.filter((row) =>
        !sessionChangeFileMatches(row.file, intent.path, intent.previousPath)
      ),
      optimistic,
    ];
  }

  return (["unstaged", "staged"] as const).flatMap((state) =>
    projected.filter((row) => row.state === state)
      .sort((left, right) => left.file.displayPath.localeCompare(right.file.displayPath))
      .map((row, index) => ({
        ...row,
        label: state === "staged" ? "Staged" : "Unstaged",
        startsSection: index === 0,
      }))
  );
}

function optimisticSessionChangeRow(
  target: PreparedSessionChangeRow,
  state: SessionChangeFileState,
  intent: Pick<
    PendingSessionChangeIntent,
    "path" | "previousPath" | "acknowledgedRevision"
  >,
  ambiguousDiff: boolean,
): PreparedSessionChangeRow {
  const optimistic: PreparedSessionChangeRow = {
    ...target,
    key: sessionChangeRowKey(state, target.file),
    label: state === "staged" ? "Staged" : "Unstaged",
    state,
    startsSection: false,
    pending: {
      path: intent.path,
      ...(intent.previousPath === undefined ? {} : { previousPath: intent.previousPath }),
      requestPending: intent.acknowledgedRevision === undefined,
    },
  };
  if (!ambiguousDiff) return optimistic;
  const { fileDiff: _fileDiff, stats: _stats, ...withoutDiff } = optimistic;
  return { ...withoutDiff, fallback: "Updating the combined diff…" };
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

export function sessionChangeMutationPaths(
  row: PreparedSessionChangeRow,
): SessionChangeMutationPaths {
  if (row.pending !== undefined) {
    return {
      path: row.pending.path,
      ...(row.pending.previousPath === undefined ? {} : { previousPath: row.pending.previousPath }),
    };
  }
  const previousPath = filePreviousPath(row.file);
  return {
    path: row.file.path,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}

export function sessionChangeFileMatches(
  file: SessionGitFileData,
  path: string,
  intentPreviousPath?: string,
): boolean {
  const previousPath = filePreviousPath(file);
  return sessionChangeMutationPathsMatch(
    { path: file.path, ...(previousPath === undefined ? {} : { previousPath }) },
    { path, ...(intentPreviousPath === undefined ? {} : { previousPath: intentPreviousPath }) },
  );
}

export function sessionChangeMutationPathsMatch(
  left: SessionChangeMutationPaths,
  right: SessionChangeMutationPaths,
): boolean {
  return left.path === right.path || left.path === right.previousPath ||
    left.previousPath === right.path ||
    left.previousPath !== undefined && left.previousPath === right.previousPath;
}

function createCodeViewItem(
  row: PreparedSessionChangeRow,
  collapsed: boolean,
  version: number,
): CodeViewItem {
  if (!collapsed && isRenderableSessionChange(row)) {
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
    JSON.stringify(left.pending) === JSON.stringify(right.pending) &&
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
