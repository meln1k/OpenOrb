import type {
  SessionGitFileData,
  SessionGitSnapshotData,
} from "../../../../protocol/src/browser-session-git-snapshot.ts";
import type { FileDiff, FileDiffMetadata } from "@pierre/diffs";
import { css, type Handle, on, ref } from "remix/ui";

import { Icon } from "../components/icons.tsx";

type DiffsModule = typeof import("@pierre/diffs");
type FileState = "staged" | "unstaged";
type DiffStats = { readonly additions: number; readonly deletions: number };
type DiffViewer = Pick<FileDiff, "cleanUp">;

export type PreparedSessionChangeRow = {
  readonly key: string;
  readonly file: SessionGitFileData;
  readonly fileDiff?: FileDiffMetadata;
  readonly fallback: string;
  readonly stats?: DiffStats;
};

export type PreparedSessionChangeSection = {
  readonly label: string;
  readonly state: FileState;
  readonly rows: readonly PreparedSessionChangeRow[];
};

export type PreparedSessionChanges = {
  readonly sections: readonly PreparedSessionChangeSection[];
  readonly Viewer?: DiffsModule["FileDiff"];
};

export type SessionChangeFilesProps = PreparedSessionChanges & {
  readonly onUpdate: (
    action: "stage" | "unstage",
    path: string,
    button: HTMLButtonElement,
    previousPath?: string,
  ) => void;
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
  const sections = fileSections(snapshot).map((section) => ({
    label: section.label,
    state: section.state,
    rows: section.files.map((file) => {
      const fileDiff = findFileDiff(parsed[section.state], file);
      return {
        key: rowKey(section.state, file),
        file,
        ...(fileDiff === undefined ? {} : { fileDiff }),
        fallback: diffFallbackMessage(file, section.truncated, fileDiff),
        ...(fileDiff === undefined ? {} : { stats: summarizeDiff(fileDiff) }),
      };
    }),
  }));
  return {
    sections,
    ...(diffs === undefined ? {} : { Viewer: diffs.FileDiff }),
  };
}

export function SessionChangeFiles(handle: Handle<SessionChangeFilesProps>) {
  return () => (
    <nav aria-label="Changed files" mix={fileSectionsStyle}>
      {handle.props.sections.map((section) => (
        <section key={section.state} aria-label={section.label}>
          <h3 mix={fileGroupHeadingStyle}>{section.label}</h3>
          {section.rows.map((row) => (
            <SessionChangeFileRow
              key={row.key}
              label={section.label}
              state={section.state}
              row={row}
              {...(handle.props.Viewer === undefined ? {} : { Viewer: handle.props.Viewer })}
              onUpdate={handle.props.onUpdate}
            />
          ))}
        </section>
      ))}
    </nav>
  );
}

type SessionChangeFileRowProps = {
  readonly label: string;
  readonly state: FileState;
  readonly row: PreparedSessionChangeRow;
  readonly Viewer?: DiffsModule["FileDiff"];
  readonly onUpdate: SessionChangeFilesProps["onUpdate"];
};

function SessionChangeFileRow(handle: Handle<SessionChangeFileRowProps>) {
  let expanded = false;
  let host: HTMLElement | undefined;
  let mountedDiff: FileDiffMetadata | undefined;
  let viewer: DiffViewer | undefined;

  const cleanViewer = () => {
    viewer?.cleanUp();
    viewer = undefined;
    mountedDiff = undefined;
    host?.replaceChildren();
  };
  const attachHost = (node: HTMLElement, signal: AbortSignal) => {
    host = node;
    signal.addEventListener("abort", () => {
      if (host !== node) return;
      cleanViewer();
      host = undefined;
    }, { once: true });
  };
  const mountViewer = () => {
    const { file, fileDiff } = handle.props.row;
    const Viewer = handle.props.Viewer;
    if (
      !expanded || host === undefined || Viewer === undefined || fileDiff === undefined ||
      file.diffState !== "available" || fileDiff.hunks.length === 0
    ) return;
    if (viewer !== undefined && mountedDiff === fileDiff) return;
    cleanViewer();
    const fileContainer = document.createElement("diffs-container");
    host.replaceChildren(fileContainer);
    const nextViewer = new Viewer({
      theme: { light: "pierre-light", dark: "pierre-dark" },
      diffStyle: "unified",
      disableFileHeader: true,
      hunkSeparators: "line-info",
      expansionLineCount: 100,
      overflow: "wrap",
    });
    nextViewer.render({ fileContainer, fileDiff });
    viewer = nextViewer;
    mountedDiff = fileDiff;
  };

  handle.signal.addEventListener("abort", cleanViewer, { once: true });

  return () => {
    const { label, onUpdate, row, state, Viewer } = handle.props;
    const { file, fileDiff, stats } = row;
    const renderable = Viewer !== undefined && file.diffState === "available" &&
      fileDiff !== undefined && fileDiff.hunks.length > 0;
    if (!expanded || !renderable || mountedDiff !== fileDiff) cleanViewer();
    if (expanded && renderable) handle.queueTask(mountViewer);

    const action = state === "staged" ? "unstage" as const : "stage" as const;
    const actionLabel = action === "stage" ? "Stage" : "Unstage";
    const path = splitFilePath(file.displayPath);
    const previousDisplayPath = filePreviousDisplayPath(file);
    const bodyId = `${handle.id}-body`;
    return (
      <article id={handle.id} mix={fileItemStyle}>
        <header mix={fileRowStyle}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${file.displayPath}`}
            title={previousDisplayPath
              ? `${previousDisplayPath} → ${file.displayPath}`
              : file.displayPath}
            mix={[
              fileToggleStyle,
              on<HTMLButtonElement, "click">("click", async () => {
                expanded = !expanded;
                if (!expanded) cleanViewer();
                await handle.update();
              }),
            ]}
          >
            <span data-file-chevron>
              <Icon name="chevron-right" size={14} />
            </span>
            <span data-file-label>
              <strong dir="ltr">{path.name}</strong>
              {path.directory
                ? (
                  <small title={path.directory}>
                    <span dir="ltr">{path.directory}</span>
                  </small>
                )
                : null}
            </span>
            {stats
              ? (
                <span
                  aria-label={`${stats.additions} additions, ${stats.deletions} deletions`}
                  mix={fileStatsStyle}
                >
                  {stats.additions > 0 ? <span data-additions>+{stats.additions}</span> : null}
                  {stats.deletions > 0 ? <span data-deletions>-{stats.deletions}</span> : null}
                </span>
              )
              : null}
            <span
              data-status={file.status}
              title={statusTitle(file.status)}
              mix={statusBadgeStyle}
            >
              {statusLabel(file.status)}
            </span>
          </button>
          <button
            type="button"
            data-git-file-action={action}
            aria-label={`${actionLabel} ${file.displayPath}`}
            title={`${actionLabel} ${file.displayPath}`}
            mix={[
              fileActionStyle,
              on<HTMLButtonElement, "click">("click", (event) =>
                onUpdate(
                  action,
                  file.path,
                  event.currentTarget,
                  filePreviousPath(file),
                )),
            ]}
          >
            <span data-slot="git-file-action-idle" mix={fileActionIdleStyle}>
              <Icon name={action === "stage" ? "circle-plus" : "circle-minus"} size={17} />
            </span>
            <span
              aria-hidden="true"
              data-slot="git-file-action-spinner"
              hidden
              mix={fileActionSpinnerStyle}
            />
          </button>
        </header>
        <div
          id={bodyId}
          hidden={!expanded}
          aria-label={`${label}: ${file.displayPath}`}
          mix={diffBodyStyle}
        >
          {renderable
            ? <div mix={[diffHostStyle, ref(attachHost)]} />
            : <p mix={diffFallbackStyle}>{row.fallback}</p>}
        </div>
      </article>
    );
  };
}

function parsePatchSection(
  diffs: DiffsModule,
  snapshot: SessionGitSnapshotData,
  state: FileState,
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

function summarizeDiff(fileDiff: FileDiffMetadata): DiffStats {
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

function rowKey(state: FileState, file: SessionGitFileData): string {
  return `${state}\0${filePreviousPath(file) ?? ""}\0${file.path}`;
}

function filePreviousPath(file: SessionGitFileData): string | undefined {
  return "previousPath" in file ? file.previousPath : undefined;
}

function filePreviousDisplayPath(file: SessionGitFileData): string | undefined {
  return "previousDisplayPath" in file ? file.previousDisplayPath : undefined;
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

const fileSectionsStyle = css({
  display: "flex",
  flexDirection: "column",
  paddingBottom: "12px",
  "& > section + section": { marginTop: "12px" },
});
const fileGroupHeadingStyle = css({
  margin: 0,
  padding: "15px 14px 7px",
  color: "var(--muted-foreground)",
  fontSize: "11px",
  fontWeight: 650,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
});
const fileItemStyle = css({
  borderTop: "1px solid transparent",
  borderBottom: "1px solid var(--sidebar-border)",
  "&:first-of-type": { borderTopColor: "var(--sidebar-border)" },
});
const fileRowStyle = css({
  display: "flex",
  alignItems: "center",
  minWidth: 0,
  minHeight: "46px",
  background: "var(--sidebar)",
  "&:hover": { background: "var(--sidebar-accent)" },
  "&:has([aria-expanded='true'])": { background: "var(--sidebar-accent)" },
});
const fileToggleStyle = css({
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
  "&:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  "& [data-file-chevron]": {
    display: "flex",
    flexShrink: 0,
    color: "var(--muted-foreground)",
    transition: "transform 120ms ease",
  },
  "&[aria-expanded='true'] [data-file-chevron]": { transform: "rotate(90deg)" },
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
});
const fileStatsStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "3px",
  flexShrink: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "11px",
  fontWeight: 600,
  "& [data-additions]": { color: "#16834b" },
  "& [data-deletions]": { color: "var(--destructive)" },
});
const statusBadgeStyle = css({
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
  "&[data-status='added']": {
    color: "#16834b",
    borderColor: "color-mix(in oklab, #16834b 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, #16834b 7%, transparent)",
  },
  "&[data-status='deleted']": {
    color: "var(--destructive)",
    borderColor: "color-mix(in oklab, var(--destructive) 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, var(--destructive) 7%, transparent)",
  },
  "&[data-status='modified'], &[data-status='renamed']": {
    color: "#9a6700",
    borderColor: "color-mix(in oklab, #9a6700 42%, var(--sidebar-border))",
    background: "color-mix(in oklab, #9a6700 7%, transparent)",
  },
});
const fileActionStyle = css({
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
  "&:hover, &:focus-visible": {
    color: "var(--foreground)",
    background: "var(--background)",
    outline: "none",
  },
  "&:disabled": { opacity: 0.5, cursor: "pointer" },
  "&[aria-busy='true']": { opacity: 1 },
});
const fileActionIdleStyle = css({
  display: "inline-flex",
  "&[hidden]": { display: "none" },
});
const fileActionSpinnerStyle = css({
  display: "block",
  width: "17px",
  height: "17px",
  border: "2px solid color-mix(in oklab, currentColor 35%, transparent)",
  borderTopColor: "currentColor",
  borderRadius: "999px",
  animation: "openorb-git-file-action-spin 800ms linear infinite",
  "&[hidden]": { display: "none" },
  "@keyframes openorb-git-file-action-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});
const diffBodyStyle = css({
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  background: "var(--sidebar)",
  borderTop: "1px solid var(--sidebar-border)",
  "&[hidden]": { display: "none" },
});
const diffHostStyle = css({ display: "block", minWidth: 0 });
const diffFallbackStyle = css({
  margin: 0,
  padding: "14px",
  color: "var(--muted-foreground)",
  fontSize: "12px",
  textAlign: "center",
});
