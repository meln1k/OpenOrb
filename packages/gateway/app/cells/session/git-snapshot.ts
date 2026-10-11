import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  isSafeGitReference,
  MAX_RUNNER_BULK_CHUNK_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FILES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  type SessionGitDiffState,
  type SessionGitFile,
  type SessionGitFileAction,
  type SessionGitFileStatus,
  SessionGitSnapshot,
} from "@openorb/protocol/runner-api";
import type { SessionGitPatchSection } from "@openorb/protocol/runner-bulk-api";

// Git Snapshots for every Agent Environment Provider (ADR 0006): hardened Git runs in the guest
// over ExecutionEnv. Only the summary crosses the Environment Link; full patches stay in a guest
// file and are read in byte ranges when a viewer pages past a preview.

/** Outside /workspace, on persistent guest storage where the provider has it. */
export const GIT_SNAPSHOT_DIRECTORY = "/var/lib/openorb/git";
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
/** Per section; together they stay within the protocol's full-patch bound. */
const MAX_SECTION_PATCH_BYTES = MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES / 2;
const GIT_TIMEOUT = "60s";
const WORKSPACE = "/workspace";

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

/** One section's full patch as written in the guest. */
interface StoredPatch {
  readonly bytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
  readonly preview: string;
}

export interface CheckoutFacts {
  readonly checkoutState: "pending" | "available" | "unavailable";
  readonly baseCommit?: string;
}

export interface GitPatchChunk {
  readonly bytes: Uint8Array;
  readonly nextOffset: number;
  readonly done: boolean;
}

export type GitFileUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export async function generateGitSnapshot(
  env: ExecutionEnv,
  checkout: CheckoutFacts,
  context: Context,
): Promise<SessionGitSnapshot> {
  if (checkout.checkoutState !== "available" || checkout.baseCommit === undefined) {
    return incompleteSnapshot(
      "Git changes are unavailable because the session checkout is incomplete.",
    );
  }
  const status = await capture(
    env,
    snapshotGitCommand([
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--no-ahead-behind",
      "--renames",
      "--ignore-submodules=all",
    ]),
    MAX_STATUS_BYTES,
    context,
  );
  const diffOptions = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    "--ignore-submodules=all",
  ];
  const [stagedStat, unstagedStat] = await Promise.all([
    capture(
      env,
      snapshotGitCommand(["diff", "--cached", "--numstat", "-z", ...diffOptions, "HEAD", "--"]),
      MAX_STATUS_BYTES,
      context,
    ),
    capture(
      env,
      snapshotGitCommand(["diff", "--numstat", "-z", ...diffOptions, "--"]),
      MAX_STATUS_BYTES,
      context,
    ),
  ]);
  const parsedStatus = parsePorcelain(status.stdout);
  const files = sectionFiles(
    parsedStatus.files,
    binaryPathsFromNumstat(stagedStat.stdout),
    binaryPathsFromNumstat(unstagedStat.stdout),
  );
  const boundedFiles = takeFilesByJsonBytes(files, MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES);
  const untracked = boundedFiles.value.unstaged.filter((file) => file.kind === "untracked");

  const directory = await createSnapshotDirectory(env, context);
  const write = await capture(
    env,
    writePatchesCommand(directory, untracked.map((file) => file.path)),
    MAX_STATUS_BYTES,
    context,
  );
  const written = parseWrittenPatches(write.stdout, untracked);
  const [staged, unstaged] = await Promise.all([
    readStoredPatch(env, `${directory}/staged.patch`, written.staged, context),
    readStoredPatch(env, `${directory}/unstaged.patch`, written.unstaged, context),
  ]);
  const files_: GitSnapshotFiles = {
    staged: boundedFiles.value.staged,
    unstaged: boundedFiles.value.unstaged.map((file) =>
      file.kind === "untracked"
        ? { ...file, diffState: written.untrackedStates.get(file.path) ?? "truncated" }
        : file
    ),
  };
  const previews = boundPatches(staged?.preview ?? "", unstaged?.preview ?? "");
  const stagedTruncated = staged?.truncated ?? true;
  const unstagedTruncated = (unstaged?.truncated ?? true) || written.untrackedTruncated;
  const commandFailed = status.exitCode !== 0 || stagedStat.exitCode !== 0 ||
    unstagedStat.exitCode !== 0 || write.exitCode !== 0 || staged === undefined ||
    unstaged === undefined;
  const truncated = status.truncated || boundedFiles.truncated || stagedTruncated ||
    unstagedTruncated;
  const snapshotId = await hashSnapshot(parsedStatus, files_, staged, unstaged);
  // Keep only this snapshot's patches; a viewer of an older snapshot refreshes.
  await capture(env, publishPatchesCommand(directory, snapshotId), 4_096, context);

  return new SessionGitSnapshot({
    snapshotId,
    generatedAt: new Date().toISOString(),
    ...(parsedStatus.branch === undefined ? {} : { branch: parsedStatus.branch }),
    ...(parsedStatus.head === undefined ? {} : { head: parsedStatus.head }),
    completeness: commandFailed ? "incomplete" : "complete",
    stale: false,
    truncated,
    ...(commandFailed
      ? { message: "Some Git changes could not be read. This snapshot may be incomplete." }
      : truncated
      ? { message: "The Git Snapshot was truncated to its safety limits." }
      : {}),
    sections: {
      staged: {
        files: files_.staged,
        patch: previews.staged,
        fullPatchBytes: staged?.bytes ?? 0,
        truncated: stagedTruncated,
      },
      unstaged: {
        files: files_.unstaged,
        patch: previews.unstaged,
        fullPatchBytes: unstaged?.bytes ?? 0,
        truncated: unstagedTruncated,
      },
    },
  });
}

/**
 * Reads one byte range of a stored patch, ending on a UTF-8 boundary. Unsafe control and
 * bidirectional characters are replaced by characters of the same encoded length, so offsets
 * still match the guest file the snapshot recorded.
 */
export async function readGitPatchChunk(
  env: ExecutionEnv,
  snapshotId: string,
  section: SessionGitPatchSection,
  offset: number,
  fullPatchBytes: number,
  context: Context,
): Promise<GitPatchChunk> {
  if (offset >= fullPatchBytes) return { bytes: new Uint8Array(), nextOffset: offset, done: true };
  const opened = await env.openBinaryReader(
    `${GIT_SNAPSHOT_DIRECTORY}/${snapshotId}/${section}.patch`,
    { noFollow: true },
    context,
  );
  if (!opened.ok) throw new GitSnapshotError("The full patch is no longer in the environment.");
  using cleanup = new DisposableStack();
  cleanup.defer(() => void opened.value.close(context));
  const length = Math.min(MAX_RUNNER_BULK_CHUNK_BYTES, fullPatchBytes - offset);
  const read = await opened.value.read(offset, length, context);
  if (!read.ok || read.value.length === 0) {
    throw new GitSnapshotError("The full patch could not be read from the environment.");
  }
  const end = offset + read.value.length >= fullPatchBytes
    ? read.value.length
    : utf8Boundary(read.value);
  const bytes = sanitizeSameLength(read.value.subarray(0, end));
  const nextOffset = offset + bytes.length;
  return { bytes, nextOffset, done: nextOffset >= fullPatchBytes };
}

export async function updateGitFile(
  env: ExecutionEnv,
  checkout: CheckoutFacts,
  input: {
    readonly action: SessionGitFileAction;
    readonly path: string;
    readonly previousPath?: string;
  },
  context: Context,
): Promise<GitFileUpdateResult> {
  if (checkout.checkoutState !== "available" || checkout.baseCommit === undefined) {
    return {
      ok: false,
      message: "Git changes are unavailable because the session checkout is incomplete.",
    };
  }
  const paths = input.previousPath === undefined || input.previousPath === input.path
    ? [input.path]
    : [input.path, input.previousPath];
  const args = input.action === "stage"
    ? ["add", "-A", "--", ...paths]
    : ["restore", "--staged", "--", ...paths];
  const result = await capture(env, mutationGitCommand(args), 4_096, context);
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    message: input.action === "stage"
      ? "The file could not be staged. Git changes are being refreshed."
      : "The file could not be unstaged. Git changes are being refreshed.",
  };
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

export class GitSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSnapshotError";
  }
}

async function capture(
  env: ExecutionEnv,
  argv: readonly string[],
  limit: number,
  context: Context,
): Promise<CapturedCommand> {
  let stdout = "";
  let bytes = 0;
  let truncated = false;
  const result = await env.exec(argv, {
    cwd: WORKSPACE,
    onOutput: (text, _context, info) => {
      if (info.stream !== "stdout") return;
      const remaining = limit - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = takeUtf8(text, remaining);
      stdout += captured.value;
      bytes += byteLength(captured.value);
      truncated ||= captured.truncated;
    },
  }, context);
  return { exitCode: result.ok ? result.value.exitCode : -1, stdout, truncated };
}

async function createSnapshotDirectory(env: ExecutionEnv, context: Context): Promise<string> {
  const created = await capture(
    env,
    [
      "/bin/sh",
      "-c",
      'mkdir -p "$1" && chmod 0700 "$1" && mktemp -d "$1/.pending.XXXXXXXX"',
      "openorb-git-snapshot",
      GIT_SNAPSHOT_DIRECTORY,
    ],
    4_096,
    context,
  );
  const directory = created.stdout.trim();
  if (created.exitCode !== 0 || !directory.startsWith(`${GIT_SNAPSHOT_DIRECTORY}/.pending.`)) {
    throw new GitSnapshotError("The Git Snapshot could not be stored in the environment.");
  }
  return directory;
}

/**
 * Writes the staged, unstaged, and untracked patches into `directory` and reports each section's
 * size and SHA-256, plus each untracked file's numstat, on stdout. Oversized patches are cut to
 * the section bound after recording their full size.
 */
function writePatchesCommand(directory: string, untrackedPaths: readonly string[]): string[] {
  const git = gitHardening().join(" ");
  const diff = "--no-color --no-ext-diff --no-textconv --find-renames --unified=1000000";
  const script = [
    'directory="$1"; shift',
    `/usr/bin/git ${git} diff --cached ${diff} --ignore-submodules=all HEAD -- > "$directory/staged.patch" || exit 3`,
    `/usr/bin/git ${git} diff ${diff} --ignore-submodules=all -- > "$directory/unstaged.patch" || exit 3`,
    "for path do",
    "  printf 'u\\0'",
    `  /usr/bin/git ${git} diff --no-index --numstat -- /dev/null "$path"`,
    '  status=$?; if [ "$status" -gt 1 ]; then exit "$status"; fi',
    "  printf '\\0'",
    `  /usr/bin/git ${git} diff --no-index ${diff} -- /dev/null "$path" >> "$directory/unstaged.patch"`,
    '  status=$?; if [ "$status" -gt 1 ]; then exit "$status"; fi',
    "done",
    "for section in staged unstaged; do",
    '  file="$directory/$section.patch"',
    '  size=$(stat -c %s "$file")',
    `  if [ "$size" -gt ${MAX_SECTION_PATCH_BYTES} ]; then truncate -s ${MAX_SECTION_PATCH_BYTES} "$file"; fi`,
    '  printf "s\\0%s\\0%s\\0%s\\0" "$section" "$size" "$(sha256sum "$file" | cut -d " " -f 1)"',
    "done",
  ].join("\n");
  return [
    ...gitCommandPrefix(true),
    "/bin/sh",
    "-c",
    script,
    "openorb-git-patches",
    directory,
    ...untrackedPaths,
  ];
}

/** Renames the pending directory to its snapshot ID and removes every other snapshot. */
function publishPatchesCommand(directory: string, snapshotId: string): string[] {
  return [
    "/bin/sh",
    "-c",
    [
      'root="$1"; pending="$2"; id="$3"',
      'if [ -d "$root/$id" ]; then rm -rf "$pending"; else mv "$pending" "$root/$id"; fi',
      'for entry in "$root"/* "$root"/.pending.*; do',
      '  [ -e "$entry" ] || continue',
      '  [ "$entry" = "$root/$id" ] || rm -rf "$entry"',
      "done",
    ].join("\n"),
    "openorb-git-publish",
    GIT_SNAPSHOT_DIRECTORY,
    directory,
    snapshotId,
  ];
}

interface WrittenPatches {
  readonly staged?: { readonly bytes: number; readonly sha256: string };
  readonly unstaged?: { readonly bytes: number; readonly sha256: string };
  readonly untrackedStates: ReadonlyMap<string, SessionGitDiffState>;
  readonly untrackedTruncated: boolean;
}

function parseWrittenPatches(
  output: string,
  untracked: readonly SessionGitFile[],
): WrittenPatches {
  const fields = output.split("\0");
  const sections: Record<string, { bytes: number; sha256: string }> = {};
  const numstats: string[] = [];
  for (let index = 0; index < fields.length;) {
    const tag = fields[index++];
    if (tag === "u") {
      numstats.push(fields[index++] ?? "");
    } else if (tag === "s") {
      const section = fields[index++] ?? "";
      const bytes = Number(fields[index++]);
      const sha256 = fields[index++] ?? "";
      if (Number.isSafeInteger(bytes) && bytes >= 0 && /^[0-9a-f]{64}$/.test(sha256)) {
        sections[section] = { bytes, sha256 };
      }
    }
  }
  const states = new Map<string, SessionGitDiffState>();
  for (const [index, file] of untracked.entries()) {
    const numstat = numstats[index];
    states.set(
      file.path,
      numstat === undefined ? "truncated" : numstat.startsWith("-\t-\t") ? "binary" : "available",
    );
  }
  return {
    ...(sections.staged === undefined ? {} : { staged: sections.staged }),
    ...(sections.unstaged === undefined ? {} : { unstaged: sections.unstaged }),
    untrackedStates: states,
    untrackedTruncated: numstats.length < untracked.length,
  };
}

async function readStoredPatch(
  env: ExecutionEnv,
  path: string,
  written: { readonly bytes: number; readonly sha256: string } | undefined,
  context: Context,
): Promise<StoredPatch | undefined> {
  if (written === undefined) return undefined;
  const stored = Math.min(written.bytes, MAX_SECTION_PATCH_BYTES);
  if (stored === 0) return { bytes: 0, truncated: false, sha256: written.sha256, preview: "" };
  const opened = await env.openBinaryReader(path, { noFollow: true }, context);
  if (!opened.ok) return undefined;
  using cleanup = new DisposableStack();
  cleanup.defer(() => void opened.value.close(context));
  const read = await opened.value.read(
    0,
    Math.min(stored, MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES + 4),
    context,
  );
  if (!read.ok) return undefined;
  return {
    bytes: stored,
    truncated: written.bytes > MAX_SECTION_PATCH_BYTES,
    sha256: written.sha256,
    preview: new TextDecoder().decode(read.value.subarray(0, utf8Boundary(read.value))),
  };
}

function snapshotGitCommand(args: readonly string[]): string[] {
  return [...gitCommandPrefix(true), "/usr/bin/git", ...gitHardening(), ...args];
}

function mutationGitCommand(args: readonly string[]): string[] {
  return [...gitCommandPrefix(false), "/usr/bin/git", "--no-pager", ...args];
}

function gitHardening(): string[] {
  return [
    "--no-pager",
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

/** The length of the longest prefix of `bytes` that ends on a UTF-8 character boundary. */
function utf8Boundary(bytes: Uint8Array): number {
  const end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? end - back : end;
  }
  return end;
}

/**
 * Replaces unsafe characters byte by byte with ones of the same encoded width, so no decoding is
 * needed and invalid UTF-8 cannot hide them: ASCII controls become `?`, C1 controls `¿`, and
 * bidirectional controls U+FFFD. Tabs and newlines remain.
 */
function sanitizeSameLength(input: Uint8Array): Uint8Array {
  const bytes = input.slice();
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f) {
      bytes[index] = 0x3f;
    } else if (byte === 0xc2 && index + 1 < bytes.length) {
      const next = bytes[index + 1]!;
      if (next >= 0x80 && next <= 0x9f) bytes[index + 1] = 0xbf;
    } else if (byte === 0xe2 && index + 2 < bytes.length) {
      const second = bytes[index + 1]!;
      const third = bytes[index + 2]!;
      const bidi = (second === 0x80 && third >= 0xaa && third <= 0xae) ||
        (second === 0x81 && third >= 0xa6 && third <= 0xa9);
      if (bidi) bytes.set([0xef, 0xbf, 0xbd], index);
    }
  }
  return bytes;
}

async function hashSnapshot(
  status: ParsedGitStatus,
  files: GitSnapshotFiles,
  staged: StoredPatch | undefined,
  unstaged: StoredPatch | undefined,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    `${JSON.stringify({ branch: status.branch, head: status.head, files })}\0${
      staged?.sha256 ?? ""
    }\0${unstaged?.sha256 ?? ""}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return byteLength(JSON.stringify(value));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
