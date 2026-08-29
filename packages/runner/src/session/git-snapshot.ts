import {
  isSafeGitReference,
  MAX_SESSION_GIT_SNAPSHOT_FILES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  type SessionGitDiffState,
  type SessionGitFile,
  type SessionGitFileAction,
  type SessionGitFileStatus,
  SessionGitSnapshot,
} from "@openorb/protocol/runner-api";
import { Effect } from "effect";

import { AGENT_WORKSPACE, type AgentEnvironment } from "../environment/agent-environment.ts";
import type { RunnerSessionMetadata } from "./store.ts";

const MAX_STATUS_BYTES = 256 * 1024;
const MAX_DIFF_CAPTURE_BYTES = MAX_STATUS_BYTES + MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES;
const GIT_TIMEOUT = "15s";

interface CapturedCommand {
  readonly exitCode: number;
  readonly stdout: string;
  readonly truncated: boolean;
}

interface Utf8Capture {
  readonly value: string;
  readonly truncated: boolean;
}

interface FilesCapture {
  readonly value: GitSnapshotFiles;
  readonly truncated: boolean;
}

interface PatchesCapture {
  readonly staged: string;
  readonly unstaged: string;
  readonly stagedTruncated: boolean;
  readonly unstagedTruncated: boolean;
}

type SessionGitTrackedFile = Extract<SessionGitFile, { readonly kind: "tracked" }>;

interface GitSnapshotFiles {
  readonly staged: SessionGitTrackedFile[];
  readonly unstaged: SessionGitFile[];
}

interface ParsedGitStatus {
  readonly branch?: string;
  readonly head?: string;
  readonly files: ParsedGitFile[];
}

interface ParsedGitFile {
  readonly path: string;
  readonly displayPath: string;
  readonly previousPath?: string;
  readonly previousDisplayPath?: string;
  readonly staged?: SessionGitFileStatus;
  readonly unstaged?: SessionGitFileStatus;
  readonly untracked: boolean;
}

interface ParsedDiffCapture {
  readonly binaryPaths: ReadonlySet<string>;
  readonly patch: string;
  readonly truncated: boolean;
  readonly valid: boolean;
}

interface ParsedUntrackedDiffCapture {
  readonly states: ReadonlyMap<string, SessionGitDiffState>;
  readonly patch: string;
  readonly truncated: boolean;
}

export type SessionGitFileUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function generateSessionGitSnapshot(
  environment: AgentEnvironment,
  metadata: RunnerSessionMetadata,
): Effect.Effect<SessionGitSnapshot, unknown> {
  if (metadata.checkoutState !== "available" || metadata.baseCommit === undefined) {
    return Effect.succeed(incompleteSnapshot(
      "Git changes are unavailable because the session checkout is incomplete.",
    ));
  }

  return Effect.gen(function* () {
    const { status, stagedDiff, unstagedDiff } = yield* Effect.all({
      status: captureSnapshotGit(environment, [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--no-ahead-behind",
        "--renames",
        "--ignore-submodules=all",
      ], MAX_STATUS_BYTES),
      stagedDiff: captureSnapshotGit(environment, [
        "diff",
        "--cached",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=1000000",
        "--ignore-submodules=all",
        "HEAD",
        "--",
      ], MAX_DIFF_CAPTURE_BYTES),
      unstagedDiff: captureSnapshotGit(environment, [
        "diff",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=1000000",
        "--ignore-submodules=all",
        "--",
      ], MAX_DIFF_CAPTURE_BYTES),
    }, { concurrency: "unbounded" });

    const parsedStaged = parseDiffCapture(stagedDiff);
    const parsedUnstaged = parseDiffCapture(unstagedDiff);
    const parsedStatus = parsePorcelain(status.stdout);
    const files = sectionFiles(
      parsedStatus.files,
      parsedStaged.binaryPaths,
      parsedUnstaged.binaryPaths,
    );
    const boundedFiles = takeFilesByJsonBytes(
      files,
      MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
    );
    const untrackedFiles = boundedFiles.value.unstaged.filter((file) => file.kind === "untracked");
    const untrackedCapture = untrackedFiles.length === 0 ? undefined : yield* captureCommand(
      environment,
      untrackedDiffCommand(untrackedFiles.map((file) => file.path)),
      MAX_DIFF_CAPTURE_BYTES,
    );
    const parsedUntracked = untrackedCapture
      ? parseUntrackedDiffCapture(untrackedCapture, untrackedFiles)
      : { states: new Map(), patch: "", truncated: false };
    const sectionFilesWithUntrackedStates: GitSnapshotFiles = {
      staged: boundedFiles.value.staged,
      unstaged: boundedFiles.value.unstaged.map((file) =>
        file.kind === "untracked"
          ? { ...file, diffState: parsedUntracked.states.get(file.path) ?? "truncated" }
          : file
      ),
    };
    const boundedPatches = boundPatches(
      parsedStaged.patch,
      `${parsedUnstaged.patch}${parsedUntracked.patch}`,
    );
    const stagedTruncated = parsedStaged.truncated || boundedPatches.stagedTruncated;
    const unstagedTruncated = parsedUnstaged.truncated || parsedUntracked.truncated ||
      boundedPatches.unstagedTruncated;
    const commandFailed = status.exitCode !== 0 || stagedDiff.exitCode !== 0 ||
      unstagedDiff.exitCode !== 0 || (untrackedCapture?.exitCode ?? 0) !== 0 ||
      !parsedStaged.valid || !parsedUnstaged.valid;
    const truncated = status.truncated || boundedFiles.truncated || stagedTruncated ||
      unstagedTruncated;
    const completeness = commandFailed ? "incomplete" as const : "complete" as const;

    return new SessionGitSnapshot({
      generatedAt: new Date().toISOString(),
      ...(parsedStatus.branch === undefined ? {} : { branch: parsedStatus.branch }),
      ...(parsedStatus.head === undefined ? {} : { head: parsedStatus.head }),
      completeness,
      stale: false,
      truncated,
      ...(commandFailed
        ? { message: "Some Git changes could not be read. This snapshot may be incomplete." }
        : truncated
        ? { message: "The Git Snapshot was truncated to its safety limits." }
        : {}),
      sections: {
        staged: {
          files: sectionFilesWithUntrackedStates.staged,
          patch: boundedPatches.staged,
          truncated: stagedTruncated,
        },
        unstaged: {
          files: sectionFilesWithUntrackedStates.unstaged,
          patch: boundedPatches.unstaged,
          truncated: unstagedTruncated,
        },
      },
    });
  });
}

export function updateSessionGitFile(
  environment: AgentEnvironment,
  metadata: RunnerSessionMetadata,
  input: {
    readonly action: SessionGitFileAction;
    readonly path: string;
    readonly previousPath?: string;
  },
): Effect.Effect<SessionGitFileUpdateResult> {
  if (metadata.checkoutState !== "available" || metadata.baseCommit === undefined) {
    return Effect.succeed({
      ok: false,
      message: "Git changes are unavailable because the session checkout is incomplete.",
    });
  }
  const paths = input.previousPath === undefined || input.previousPath === input.path
    ? [input.path]
    : [input.path, input.previousPath];
  const args = input.action === "stage"
    ? ["add", "-A", "--", ...paths]
    : ["restore", "--staged", "--", ...paths];
  return captureCommand(environment, mutationGitCommand(args), 4_096).pipe(
    Effect.match({
      onFailure: () => mutationResult(false),
      onSuccess: (result) => mutationResult(result.exitCode === 0),
    }),
  );

  function mutationResult(updated: boolean): SessionGitFileUpdateResult {
    return updated ? { ok: true } : {
      ok: false,
      message: input.action === "stage"
        ? "The file could not be staged. The latest Git Snapshot has been loaded."
        : "The file could not be unstaged. The latest Git Snapshot has been loaded.",
    };
  }
}

export function sameGitSnapshotContents(
  left: SessionGitSnapshot,
  right: SessionGitSnapshot,
): boolean {
  return left.completeness === right.completeness &&
    left.branch === right.branch &&
    left.head === right.head &&
    left.truncated === right.truncated &&
    left.message === right.message &&
    JSON.stringify(left.sections) === JSON.stringify(right.sections);
}

export function staleGitSnapshot(previous?: SessionGitSnapshot): SessionGitSnapshot {
  const message =
    "Git changes could not be refreshed. Showing the last saved snapshot; try again after the next agent action.";
  if (previous) {
    return new SessionGitSnapshot({
      ...previous,
      completeness: "incomplete",
      stale: true,
      message,
    });
  }
  return incompleteSnapshot(message, true);
}

function captureSnapshotGit(
  environment: AgentEnvironment,
  args: readonly string[],
  limit: number,
): Effect.Effect<CapturedCommand, unknown> {
  return captureCommand(environment, snapshotGitCommand(args), limit);
}

function captureCommand(
  environment: AgentEnvironment,
  command: readonly string[],
  limit: number,
): Effect.Effect<CapturedCommand, unknown> {
  let stdout = "";
  let bytes = 0;
  let truncated = false;

  return environment.run(command, {
    cwd: ".",
    onOutput: (output) =>
      Effect.sync(() => {
        if (output.stream !== "stdout") return;
        const remaining = limit - bytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const captured = takeUtf8(output.text, remaining);
        stdout += captured.value;
        bytes += new TextEncoder().encode(captured.value).byteLength;
        truncated ||= captured.truncated;
      }),
  }).pipe(
    Effect.map((result) => ({ exitCode: result.exitCode, stdout, truncated })),
  );
}

function snapshotGitCommand(args: readonly string[]): string[] {
  return [
    ...gitCommandPrefix(true),
    "/usr/bin/git",
    "--no-pager",
    "-c",
    `safe.directory=${AGENT_WORKSPACE}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.external=",
    "-c",
    "pager.diff=false",
    "-c",
    "pager.status=false",
    "-c",
    "status.submoduleSummary=false",
    ...args,
  ];
}

function mutationGitCommand(args: readonly string[]): string[] {
  return [
    ...gitCommandPrefix(false),
    "/usr/bin/git",
    "--no-pager",
    "-c",
    `safe.directory=${AGENT_WORKSPACE}`,
    ...args,
  ];
}

function untrackedDiffCommand(paths: readonly string[]): string[] {
  const script = [
    "for path do",
    "  printf '\\0'",
    `  /usr/bin/git --no-pager -c safe.directory=${AGENT_WORKSPACE} -c core.attributesFile=/dev/null -c core.quotePath=true -c diff.external= diff --no-index --numstat --patch --no-color --no-ext-diff --no-textconv --unified=1000000 -- /dev/null "$path"`,
    "  status=$?",
    '  if [ "$status" -gt 1 ]; then exit "$status"; fi',
    "done",
  ].join("\n");
  return [
    ...gitCommandPrefix(true),
    "/bin/sh",
    "-c",
    script,
    "openorb-untracked-diff",
    ...paths,
  ];
}

function gitCommandPrefix(readOnly: boolean): string[] {
  return [
    "/usr/bin/timeout",
    "--signal=KILL",
    GIT_TIMEOUT,
    "/usr/bin/env",
    "-i",
    "HOME=/tmp",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_ATTR_NOSYSTEM=1",
    "GIT_LITERAL_PATHSPECS=1",
    "GIT_PAGER=cat",
    "PAGER=cat",
    "GIT_TERMINAL_PROMPT=0",
    ...(readOnly ? ["GIT_OPTIONAL_LOCKS=0"] : []),
    "GIT_EXTERNAL_DIFF=",
  ];
}

function parseDiffCapture(capture: CapturedCommand): ParsedDiffCapture {
  if (capture.stdout.length === 0) {
    return {
      binaryPaths: new Set(),
      patch: "",
      truncated: capture.truncated,
      valid: true,
    };
  }
  const separator = capture.stdout.indexOf("\0\0");
  if (separator < 0) {
    return {
      binaryPaths: new Set(),
      patch: "",
      truncated: true,
      valid: false,
    };
  }
  return {
    binaryPaths: binaryPathsFromNumstat(capture.stdout.slice(0, separator)),
    patch: capture.stdout.slice(separator + 2),
    truncated: capture.truncated,
    valid: true,
  };
}

function binaryPathsFromNumstat(value: string): ReadonlySet<string> {
  const binary = new Set<string>();
  let cursor = 0;
  while (cursor < value.length) {
    const additionsEnd = value.indexOf("\t", cursor);
    const deletionsEnd = additionsEnd < 0 ? -1 : value.indexOf("\t", additionsEnd + 1);
    if (additionsEnd < 0 || deletionsEnd < 0) break;
    const isBinary = value.slice(cursor, additionsEnd) === "-" &&
      value.slice(additionsEnd + 1, deletionsEnd) === "-";
    const pathStart = deletionsEnd + 1;
    if (value[pathStart] === "\0") {
      const previousEnd = value.indexOf("\0", pathStart + 1);
      if (previousEnd < 0) break;
      const currentEnd = value.indexOf("\0", previousEnd + 1);
      const end = currentEnd < 0 ? value.length : currentEnd;
      if (isBinary) binary.add(value.slice(previousEnd + 1, end));
      cursor = end + 1;
      continue;
    }
    const pathEnd = value.indexOf("\0", pathStart);
    const end = pathEnd < 0 ? value.length : pathEnd;
    if (isBinary) binary.add(value.slice(pathStart, end));
    cursor = end + 1;
  }
  return binary;
}

function parseUntrackedDiffCapture(
  capture: CapturedCommand,
  files: readonly SessionGitFile[],
): ParsedUntrackedDiffCapture {
  const states = new Map<string, SessionGitDiffState>();
  const chunks = capture.stdout.startsWith("\0") ? capture.stdout.slice(1).split("\0") : [];
  const completeChunks = capture.truncated ? Math.max(0, chunks.length - 1) : chunks.length;
  let patch = "";
  for (const [index, file] of files.entries()) {
    const chunk = index < completeChunks ? chunks[index] : undefined;
    if (!chunk) {
      states.set(file.path, "truncated");
      continue;
    }
    const statEnd = chunk.indexOf("\n");
    const diffStart = chunk.indexOf("diff --git ");
    if (statEnd < 0 || diffStart < 0) {
      states.set(file.path, "truncated");
      continue;
    }
    if (chunk.slice(0, statEnd).startsWith("-\t-\t")) {
      states.set(file.path, "binary");
      continue;
    }
    states.set(file.path, "available");
    patch += chunk.slice(diffStart);
  }
  return {
    states,
    patch,
    truncated: capture.truncated || states.size < files.length ||
      Array.from(states.values()).some((state) => state === "truncated"),
  };
}

function parsePorcelain(output: string): ParsedGitStatus {
  const records = output.split("\0");
  const files: ParsedGitFile[] = [];
  let branch: string | undefined;
  let head: string | undefined;
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const candidate = record.slice("# branch.oid ".length);
      if (/^[0-9a-f]{40,64}$/.test(candidate)) head = candidate;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const candidate = record.slice("# branch.head ".length);
      if (isSafeGitReference(candidate)) branch = candidate;
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      files.push({
        path,
        displayPath: sanitizePathForDisplay(path),
        untracked: true,
      });
      continue;
    }
    if (record.startsWith("! ")) continue;
    const kind = record[0];
    const fieldCount = kind === "2" ? 10 : kind === "u" ? 11 : kind === "1" ? 9 : 0;
    if (fieldCount === 0) continue;
    const fields = splitFields(record, fieldCount);
    if (fields.length !== fieldCount) continue;
    const path = fields[fieldCount - 1];
    const xy = fields[1] ?? "..";
    if (!path) continue;
    const staged = statusFromCode(xy[0] ?? ".");
    const unstaged = statusFromCode(xy[1] ?? ".");
    const previousPath = kind === "2" ? records[index++] : undefined;
    if (!staged && !unstaged) continue;
    files.push({
      path,
      displayPath: sanitizePathForDisplay(path),
      ...(previousPath
        ? {
          previousPath,
          previousDisplayPath: sanitizePathForDisplay(previousPath),
        }
        : {}),
      ...(staged ? { staged } : {}),
      ...(unstaged ? { unstaged } : {}),
      untracked: false,
    });
  }
  files.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    files,
  };
}

function sectionFiles(
  files: readonly ParsedGitFile[],
  stagedBinaryPaths: ReadonlySet<string>,
  unstagedBinaryPaths: ReadonlySet<string>,
): GitSnapshotFiles {
  const staged: SessionGitTrackedFile[] = [];
  const unstaged: SessionGitFile[] = [];
  for (const file of files) {
    if (file.untracked) {
      unstaged.push({
        kind: "untracked",
        path: file.path,
        displayPath: file.displayPath,
        status: "added",
        diffState: "available",
      });
      continue;
    }
    if (file.staged) {
      const row = trackedSectionFile(
        file,
        file.staged,
        stagedBinaryPaths.has(file.path) ? "binary" : "available",
      );
      if (row) staged.push(row);
    }
    if (file.unstaged) {
      const row = trackedSectionFile(
        file,
        file.unstaged,
        unstagedBinaryPaths.has(file.path) ? "binary" : "available",
      );
      if (row) unstaged.push(row);
    }
  }
  return { staged, unstaged };
}

function trackedSectionFile(
  file: ParsedGitFile,
  status: SessionGitFileStatus,
  diffState: SessionGitDiffState,
): SessionGitTrackedFile | undefined {
  const base = {
    kind: "tracked" as const,
    path: file.path,
    displayPath: file.displayPath,
    diffState,
  };
  if (status !== "renamed") return { ...base, status };
  if (!file.previousPath || !file.previousDisplayPath) return undefined;
  return {
    ...base,
    status,
    previousPath: file.previousPath,
    previousDisplayPath: file.previousDisplayPath,
  };
}

function splitFields(record: string, count: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 1; index < count; index++) {
    const separator = record.indexOf(" ", start);
    if (separator < 0) return fields;
    fields.push(record.slice(start, separator));
    start = separator + 1;
  }
  fields.push(record.slice(start));
  return fields;
}

function statusFromCode(code: string): SessionGitFileStatus | undefined {
  switch (code) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
    case "T":
    case "U":
      return "modified";
    default:
      return undefined;
  }
}

function sanitizePathForDisplay(value: string): string {
  return Array.from(sanitizeControls(value, false)).slice(0, 4_096).join("");
}

function sanitizePatch(value: string): string {
  return sanitizeControls(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), true);
}

function boundPatch(value: string): Utf8Capture {
  const utf8Bounded = takeUtf8(sanitizePatch(value), MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES);
  const jsonBounded = takeJsonStringBytes(
    utf8Bounded.value,
    MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  );
  return {
    value: jsonBounded.value,
    truncated: utf8Bounded.truncated || jsonBounded.truncated,
  };
}

function boundPatches(stagedValue: string, unstagedValue: string): PatchesCapture {
  const staged = boundPatch(stagedValue);
  const unstaged = boundPatch(unstagedValue);
  const emptyObjectJsonBytes = jsonByteLength({ staged: "", unstaged: "" });
  const stringBudget = MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES - emptyObjectJsonBytes + 4;
  const stagedBytes = jsonByteLength(staged.value);
  const unstagedBytes = jsonByteLength(unstaged.value);
  if (stagedBytes + unstagedBytes <= stringBudget) {
    return {
      staged: staged.value,
      unstaged: unstaged.value,
      stagedTruncated: staged.truncated,
      unstagedTruncated: unstaged.truncated,
    };
  }

  const equalShare = Math.floor(stringBudget / 2);
  let stagedBudget = Math.min(stagedBytes, equalShare);
  let unstagedBudget = Math.min(unstagedBytes, equalShare);
  let remaining = stringBudget - stagedBudget - unstagedBudget;
  const stagedExtra = Math.min(remaining, stagedBytes - stagedBudget);
  stagedBudget += stagedExtra;
  remaining -= stagedExtra;
  unstagedBudget += Math.min(remaining, unstagedBytes - unstagedBudget);
  const boundedStaged = takeJsonStringBytes(staged.value, stagedBudget);
  const boundedUnstaged = takeJsonStringBytes(unstaged.value, unstagedBudget);
  return {
    staged: boundedStaged.value,
    unstaged: boundedUnstaged.value,
    stagedTruncated: staged.truncated || boundedStaged.truncated,
    unstagedTruncated: unstaged.truncated || boundedUnstaged.truncated,
  };
}

function sanitizeControls(value: string, preserveWhitespace: boolean): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const allowedWhitespace = preserveWhitespace && (code === 9 || code === 10);
    if (!allowedWhitespace && isUnsafeControl(code)) {
      sanitized += `\\u{${code.toString(16).toUpperCase()}}`;
    } else {
      sanitized += character;
    }
  }
  return sanitized;
}

function isUnsafeControl(code: number): boolean {
  return code < 32 || (code >= 127 && code <= 159) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function takeUtf8(value: string, maxBytes: number): Utf8Capture {
  const encoder = new TextEncoder();
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) return { value: value.slice(0, end), truncated: true };
    bytes += size;
    end += character.length;
  }
  return { value, truncated: false };
}

function takeFilesByJsonBytes(files: GitSnapshotFiles, maxBytes: number): FilesCapture {
  const encoder = new TextEncoder();
  const groups = new Map<string, { staged?: SessionGitFile; unstaged?: SessionGitFile }>();
  for (const file of files.staged) {
    const key = gitFileIdentity(file);
    groups.set(key, { ...groups.get(key), staged: file });
  }
  for (const file of files.unstaged) {
    const key = gitFileIdentity(file);
    groups.set(key, { ...groups.get(key), unstaged: file });
  }
  let bytes = 2;
  let rowCount = 0;
  const selected = new Set<string>();
  for (const group of groups.values()) {
    const rows = [group.staged, group.unstaged].filter((file) => file !== undefined);
    const encoded = rows.reduce(
      (total, file) => total + encoder.encode(JSON.stringify(file)).byteLength,
      0,
    );
    const separators = Math.max(0, rows.length - (rowCount === 0 ? 1 : 0));
    if (
      rowCount + rows.length > MAX_SESSION_GIT_SNAPSHOT_FILES ||
      bytes + separators + encoded > maxBytes
    ) {
      return { value: selectedFiles(), truncated: true };
    }
    selected.add(gitFileIdentity(rows[0]!));
    rowCount += rows.length;
    bytes += separators + encoded;
  }
  return { value: selectedFiles(), truncated: false };

  function selectedFiles(): GitSnapshotFiles {
    return {
      staged: files.staged.filter((file) => selected.has(gitFileIdentity(file))),
      unstaged: files.unstaged.filter((file) => selected.has(gitFileIdentity(file))),
    };
  }
}

function gitFileIdentity(file: SessionGitFile): string {
  return `${"previousPath" in file ? file.previousPath : ""}\0${file.path}`;
}

function takeJsonStringBytes(value: string, maxBytes: number): Utf8Capture {
  const encoder = new TextEncoder();
  let end = 0;
  let bytes = 2;
  for (const character of value) {
    const encoded = encoder.encode(JSON.stringify(character)).byteLength - 2;
    if (bytes + encoded > maxBytes) {
      return { value: value.slice(0, end), truncated: true };
    }
    bytes += encoded;
    end += character.length;
  }
  return { value, truncated: false };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function incompleteSnapshot(message: string, stale = false): SessionGitSnapshot {
  return new SessionGitSnapshot({
    generatedAt: new Date().toISOString(),
    completeness: "incomplete",
    stale,
    truncated: false,
    message,
    sections: {
      staged: { files: [], patch: "", truncated: false },
      unstaged: { files: [], patch: "", truncated: false },
    },
  });
}
