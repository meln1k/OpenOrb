import type {
  SessionGitFileData,
  SessionGitSnapshotData,
} from "../../../../protocol/src/browser-session-git-snapshot.ts";
import type { CodeViewItem, CodeViewOptions, FileDiffMetadata } from "@pierre/diffs";
import { css, type Handle } from "remix/ui";

import { createIconElement } from "../components/icons.tsx";
import { RemixCodeView, type RemixCodeViewProps } from "../components/remix-code-view.tsx";
import {
  filePreviousDisplayPath,
  filePreviousPath,
  isRenderableSessionChange,
  type PreparedSessionChangeRow,
  reconcileSessionChangeItems,
  type SessionChangeDiffStats,
  type SessionChangeFileState,
  type SessionChangeItemRecord,
  sessionChangeRowKey,
} from "./session-change-items.ts";

type DiffsModule = typeof import("@pierre/diffs");
type ChangeHeaderContext = {
  readonly item: Pick<CodeViewItem, "collapsed" | "id">;
};

export type PreparedSessionChanges = {
  readonly rows: readonly PreparedSessionChangeRow[];
  readonly CodeView?: DiffsModule["CodeView"];
};

export type SessionChangeFilesProps = PreparedSessionChanges & {
  readonly onUpdate: (
    action: "stage" | "unstage",
    path: string,
    previousPath?: string,
  ) => Promise<void>;
};

export function prepareSessionChanges(
  snapshot: SessionGitSnapshotData,
  diffs?: DiffsModule,
  cacheKey = snapshot.generatedAt,
): PreparedSessionChanges {
  const parsed = diffs
    ? {
      staged: parsePatchSection(diffs, snapshot, "staged", cacheKey),
      unstaged: parsePatchSection(diffs, snapshot, "unstaged", cacheKey),
    }
    : { staged: new Map(), unstaged: new Map() };
  const rows = fileSections(snapshot).flatMap((section) =>
    section.files.map((file, index) => {
      const fileDiff = findFileDiff(parsed[section.state], file);
      return {
        key: sessionChangeRowKey(section.state, file),
        label: section.label,
        state: section.state,
        startsSection: index === 0,
        file,
        ...(fileDiff === undefined ? {} : { fileDiff }),
        fallback: diffFallbackMessage(file, section.truncated, fileDiff),
        ...(fileDiff === undefined ? {} : { stats: summarizeDiff(fileDiff) }),
      };
    })
  );
  return {
    rows,
    ...(diffs === undefined ? {} : { CodeView: diffs.CodeView }),
  };
}

export function SessionChangeFiles(handle: Handle<SessionChangeFilesProps>) {
  let preparedRows: readonly PreparedSessionChangeRow[] | undefined;
  let items: readonly CodeViewItem[] = [];
  let rowsById = new Map<string, PreparedSessionChangeRow>();
  let itemRecords: ReadonlyMap<string, SessionChangeItemRecord> = new Map();
  let mutationKey: string | undefined;

  const renderCustomHeader = (
    _input: unknown,
    context: ChangeHeaderContext,
  ) => {
    const row = rowsById.get(context.item.id);
    return row === undefined
      ? undefined
      : createSessionChangeHeader(row, context.item.collapsed ?? false, mutationKey);
  };

  const codeViewOptions: CodeViewOptions<undefined> = {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    diffStyle: "unified",
    hunkSeparators: "line-info",
    expansionLineCount: 100,
    overflow: "wrap",
    stickyHeaders: false,
    layout: { paddingTop: 0, paddingBottom: 12, gap: 0 },
    renderCustomHeader,
  };

  const setMutationButtons = (host: HTMLElement) => {
    for (
      const button of host.querySelectorAll<HTMLButtonElement>("[data-git-file-action]")
    ) {
      button.disabled = mutationKey !== undefined;
      const active = button.dataset.changeFileId === mutationKey;
      if (active) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
      button.querySelector("[data-slot='git-file-action-idle']")?.toggleAttribute(
        "hidden",
        active,
      );
      button.querySelector("[data-slot='git-file-action-spinner']")?.toggleAttribute(
        "hidden",
        !active,
      );
    }
  };

  const prepareItems = () => {
    const rows = handle.props.rows;
    if (rows === preparedRows) return;
    rowsById = new Map(rows.map((row) => [row.key, row]));
    const reconciled = reconcileSessionChangeItems(rows, itemRecords);
    items = reconciled.items;
    itemRecords = reconciled.records;
    preparedRows = rows;
  };

  const updateFile = async (
    action: "stage" | "unstage",
    row: PreparedSessionChangeRow,
    host: HTMLElement,
  ) => {
    if (mutationKey !== undefined) return;
    mutationKey = row.key;
    setMutationButtons(host);
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      mutationKey = undefined;
      setMutationButtons(host);
    });
    await handle.props.onUpdate(action, row.file.path, filePreviousPath(row.file));
  };

  const handleViewerClick: NonNullable<RemixCodeViewProps["onViewerClick"]> = (event, viewer) => {
    const target = event.target;
    const host = event.currentTarget;
    if (!(target instanceof Element) || !(host instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>("button[data-change-file-command]");
    if (button === null || !host.contains(button)) return;

    const row = rowsById.get(button.dataset.changeFileId ?? "");
    if (row === undefined) return;
    const command = button.dataset.changeFileCommand;
    if (command === "toggle") {
      const item = viewer.getItem(row.key);
      if (item === undefined) return;
      const updatedItem: CodeViewItem = {
        ...item,
        collapsed: !item.collapsed,
        version: (item.version ?? 0) + 1,
      };
      if (!viewer.updateItem(updatedItem)) return;
      const record = itemRecords.get(row.key);
      if (record !== undefined) {
        itemRecords = new Map(itemRecords).set(row.key, { ...record, item: updatedItem });
      }
      return;
    }
    if (command !== "stage" && command !== "unstage") return;
    void updateFile(command, row, host);
  };

  return () => {
    prepareItems();
    return (
      <RemixCodeView
        aria-label="Changed files"
        CodeView={handle.props.CodeView}
        items={items}
        options={codeViewOptions}
        onViewerClick={handleViewerClick}
        mix={codeViewStyle}
      />
    );
  };
}

function createSessionChangeHeader(
  row: PreparedSessionChangeRow,
  collapsed: boolean,
  mutationKey?: string,
): HTMLElement {
  const { file, stats } = row;
  const action = row.state === "staged" ? "unstage" as const : "stage" as const;
  const actionLabel = action === "stage" ? "Stage" : "Unstage";
  const path = splitFilePath(file.displayPath);
  const previousDisplayPath = filePreviousDisplayPath(file);
  const root = document.createElement("div");
  root.dataset.changeFile = "";

  if (row.startsSection) {
    const heading = document.createElement("h3");
    heading.textContent = row.label;
    heading.dataset.changeGroupHeading = "";
    root.append(heading);
  }

  const header = document.createElement("header");
  header.dataset.changeFileHeader = "";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.changeFileCommand = "toggle";
  toggle.dataset.changeFileId = row.key;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute(
    "aria-label",
    `${collapsed ? "Expand" : "Collapse"} ${file.displayPath}`,
  );
  toggle.title = previousDisplayPath
    ? `${previousDisplayPath} → ${file.displayPath}`
    : file.displayPath;

  const chevron = document.createElement("span");
  chevron.dataset.fileChevron = "";
  chevron.append(createIconElement("chevron-right", 14));
  toggle.append(chevron);

  const fileLabel = document.createElement("span");
  fileLabel.dataset.fileLabel = "";
  const fileName = document.createElement("strong");
  fileName.dir = "ltr";
  fileName.textContent = path.name;
  fileLabel.append(fileName);
  if (path.directory) {
    const directory = document.createElement("small");
    directory.title = path.directory;
    const directoryText = document.createElement("span");
    directoryText.dir = "ltr";
    directoryText.textContent = path.directory;
    directory.append(directoryText);
    fileLabel.append(directory);
  }
  toggle.append(fileLabel);

  if (stats !== undefined) {
    const statsElement = document.createElement("span");
    statsElement.dataset.fileStats = "";
    statsElement.setAttribute(
      "aria-label",
      `${stats.additions} additions, ${stats.deletions} deletions`,
    );
    if (stats.additions > 0) {
      const additions = document.createElement("span");
      additions.dataset.additions = "";
      additions.textContent = `+${stats.additions}`;
      statsElement.append(additions);
    }
    if (stats.deletions > 0) {
      const deletions = document.createElement("span");
      deletions.dataset.deletions = "";
      deletions.textContent = `-${stats.deletions}`;
      statsElement.append(deletions);
    }
    toggle.append(statsElement);
  }

  const status = document.createElement("span");
  status.dataset.status = file.status;
  status.title = statusTitle(file.status);
  status.textContent = statusLabel(file.status);
  toggle.append(status);
  header.append(toggle);

  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.dataset.changeFileCommand = action;
  actionButton.dataset.changeFileId = row.key;
  actionButton.dataset.gitFileAction = action;
  actionButton.setAttribute("aria-label", `${actionLabel} ${file.displayPath}`);
  actionButton.title = `${actionLabel} ${file.displayPath}`;
  actionButton.disabled = mutationKey !== undefined;
  if (mutationKey === row.key) actionButton.setAttribute("aria-busy", "true");

  const idle = document.createElement("span");
  idle.dataset.slot = "git-file-action-idle";
  idle.hidden = mutationKey === row.key;
  idle.append(createIconElement(action === "stage" ? "circle-plus" : "circle-minus", 17));
  actionButton.append(idle);

  const spinner = document.createElement("span");
  spinner.dataset.slot = "git-file-action-spinner";
  spinner.setAttribute("aria-hidden", "true");
  spinner.hidden = mutationKey !== row.key;
  actionButton.append(spinner);
  header.append(actionButton);
  root.append(header);

  if (!isRenderableSessionChange(row) && !collapsed) {
    const fallback = document.createElement("p");
    fallback.dataset.changeFallbackMessage = "";
    fallback.textContent = row.fallback;
    root.append(fallback);
  }
  return root;
}

function parsePatchSection(
  diffs: DiffsModule,
  snapshot: SessionGitSnapshotData,
  state: SessionChangeFileState,
  cacheKey: string,
): Map<string, FileDiffMetadata> {
  const patch = snapshot.sections[state].patch;
  if (!patch) return new Map();
  const sectionCacheKey = `${cacheKey}:${state}`;
  const compactFiles = diffs.parsePatchFiles(
    diffs.trimPatchContext(patch, 3),
    `${sectionCacheKey}:compact`,
  ).flatMap((item) => item.files);
  if (!snapshot.sections[state].truncated) {
    const fullFiles = diffs.parsePatchFiles(patch, `${sectionCacheKey}:full`).flatMap((item) =>
      item.files
    );
    const complete = new Map(fullFiles.map((file) => [file.name, file]));
    for (const file of compactFiles) {
      const fullFile = complete.get(file.name);
      if (
        fullFile?.hunks.length && (file.type === "change" || file.type === "rename-changed")
      ) {
        diffs.hydratePartialDiff("merge", file, {
          oldFile: {
            name: fullFile.prevName ?? fullFile.name,
            contents: fullFile.deletionLines.join(""),
          },
          newFile: {
            name: fullFile.name,
            contents: fullFile.additionLines.join(""),
          },
        });
      }
    }
  }
  return new Map(compactFiles.map((file) => [file.name, file]));
}

function fileSections(snapshot: SessionGitSnapshotData) {
  return [
    { label: "Unstaged", state: "unstaged" as const, ...snapshot.sections.unstaged },
    { label: "Staged", state: "staged" as const, ...snapshot.sections.staged },
  ].filter((section) => section.files.length > 0);
}

function findFileDiff(
  files: ReadonlyMap<string, FileDiffMetadata>,
  file: SessionGitFileData,
): FileDiffMetadata | undefined {
  return files.get(file.displayPath) ?? files.get(file.path) ??
    files.get(JSON.stringify(file.path).slice(1, -1));
}

function diffFallbackMessage(
  file: SessionGitFileData,
  sectionTruncated: boolean,
  fileDiff?: FileDiffMetadata,
): string {
  if (file.diffState === "binary") return "Binary files cannot be displayed.";
  if (file.diffState === "truncated" || sectionTruncated && !fileDiff) {
    return "This diff was omitted because the Git Snapshot was truncated.";
  }
  if (fileDiff?.hunks.length === 0) {
    return file.status === "renamed"
      ? "This file was renamed without content changes."
      : "This file is empty.";
  }
  return "No renderable patch is available for this file.";
}

function summarizeDiff(fileDiff: FileDiffMetadata): SessionChangeDiffStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

function splitFilePath(path: string): { readonly directory: string; readonly name: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, separator), name: path.slice(separator + 1) };
}

function statusLabel(status: SessionGitFileData["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "modified":
      return "M";
  }
}

function statusTitle(status: SessionGitFileData["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const codeViewStyle = css({
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  background: "var(--sidebar)",
  "& diffs-container": {
    display: "block",
    minWidth: 0,
    background: "var(--sidebar)",
    borderBottom: "1px solid var(--sidebar-border)",
  },
  "& [data-change-file]": { display: "block", minWidth: 0 },
  "& [data-change-group-heading]": {
    margin: 0,
    padding: "15px 14px 7px",
    color: "var(--muted-foreground)",
    fontSize: "11px",
    fontWeight: 650,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  "& [data-change-file-header]": {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    minHeight: "46px",
    background: "var(--sidebar)",
    borderTop: "1px solid var(--sidebar-border)",
  },
  "& [data-change-file-header]:hover": { background: "var(--sidebar-accent)" },
  "& [data-change-file-header]:has([aria-expanded='true'])": {
    background: "var(--sidebar-accent)",
  },
  "& [data-change-file-command='toggle']": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    padding: "9px 4px 9px 12px",
    color: "var(--foreground)",
    background: "transparent",
    border: 0,
    cursor: "pointer",
    font: "inherit",
    fontSize: "12px",
    textAlign: "left",
  },
  "& [data-change-file-command='toggle']:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "-2px",
  },
  "& [data-file-chevron]": {
    display: "flex",
    flexShrink: 0,
    color: "var(--muted-foreground)",
    transition: "transform 120ms ease",
  },
  "& [aria-expanded='true'] [data-file-chevron]": { transform: "rotate(90deg)" },
  "& [data-file-label]": {
    display: "flex",
    flex: 1,
    alignItems: "baseline",
    gap: "5px",
    isolation: "isolate",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
  },
  "& [data-file-label] strong": {
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    maxWidth: "100%",
    fontSize: "13px",
    fontWeight: 600,
    overflowWrap: "anywhere",
    whiteSpace: "normal",
  },
  "& [data-file-label] small": {
    display: "flex",
    flex: "0 1 auto",
    justifyContent: "flex-end",
    minWidth: 0,
    marginLeft: "-14px",
    paddingLeft: "14px",
    overflow: "hidden",
    color: "var(--muted-foreground)",
    fontSize: "11px",
    maskImage: "linear-gradient(to right, transparent 0, black 14px)",
    whiteSpace: "nowrap",
  },
  "& [data-file-label] small span": { flexShrink: 0 },
  "& [data-file-stats]": {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    flexShrink: 0,
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontWeight: 600,
  },
  "& [data-additions]": { color: "#16834b" },
  "& [data-deletions]": { color: "var(--destructive)" },
  "& [data-status]": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "24px",
    height: "22px",
    color: "var(--muted-foreground)",
    border: "1px solid var(--sidebar-border)",
    borderRadius: "6px",
    fontSize: "11px",
    fontWeight: 700,
  },
  "& [data-status='added']": {
    color: "#16834b",
    borderColor: "color-mix(in oklab, #16834b 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, #16834b 7%, transparent)",
  },
  "& [data-status='deleted']": {
    color: "var(--destructive)",
    borderColor: "color-mix(in oklab, var(--destructive) 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, var(--destructive) 7%, transparent)",
  },
  "& [data-status='modified'], & [data-status='renamed']": {
    color: "#9a6700",
    borderColor: "color-mix(in oklab, #9a6700 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, #9a6700 7%, transparent)",
  },
  "& [data-git-file-action]": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "26px",
    height: "26px",
    marginRight: "10px",
    padding: 0,
    color: "var(--muted-foreground)",
    background: "transparent",
    border: 0,
    borderRadius: "50%",
    cursor: "pointer",
  },
  "& [data-git-file-action]:hover, & [data-git-file-action]:focus-visible": {
    color: "var(--foreground)",
    background: "var(--background)",
    outline: "none",
  },
  "& [data-git-file-action]:disabled": { opacity: 0.5, cursor: "pointer" },
  "& [data-git-file-action][aria-busy='true']": { opacity: 1 },
  "& [data-slot='git-file-action-idle']": { display: "inline-flex" },
  "& [data-slot='git-file-action-idle'][hidden]": { display: "none" },
  "& [data-slot='git-file-action-spinner']": {
    display: "block",
    width: "17px",
    height: "17px",
    border: "2px solid color-mix(in oklab, currentColor 35%, transparent)",
    borderTopColor: "currentColor",
    borderRadius: "999px",
    animation: "openorb-git-file-action-spin 800ms linear infinite",
  },
  "& [data-slot='git-file-action-spinner'][hidden]": { display: "none" },
  "& [data-change-fallback-message]": {
    margin: 0,
    padding: "14px",
    color: "var(--muted-foreground)",
    background: "var(--sidebar)",
    borderTop: "1px solid var(--sidebar-border)",
    fontSize: "12px",
    textAlign: "center",
  },
  "@keyframes openorb-git-file-action-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": {
    "& [data-slot='git-file-action-spinner']": { animation: "none" },
  },
});
