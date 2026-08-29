import { array, literal, object, optional, string, union } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";

import {
  MAX_SESSION_GIT_PATH_CHARACTERS,
  MAX_SESSION_GIT_SNAPSHOT_FILES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
} from "./runner-api-limits.ts";

const booleanSchema = union([literal(true), literal(false)]);
const sessionGitPathSchema = string().refine(
  (value) => value.length > 0 && Array.from(value).length <= MAX_SESSION_GIT_PATH_CHARACTERS,
  `Git paths must contain 1 to ${MAX_SESSION_GIT_PATH_CHARACTERS} characters.`,
);

const sessionGitDiffStateSchema = union([
  literal("available" as const),
  literal("binary" as const),
  literal("truncated" as const),
]);
const sessionGitFileBase = {
  path: sessionGitPathSchema,
  displayPath: sessionGitPathSchema,
  diffState: sessionGitDiffStateSchema,
} as const;
const sessionGitTrackedFileSchema = union([
  object({
    ...sessionGitFileBase,
    kind: literal("tracked" as const),
    status: union([
      literal("added" as const),
      literal("modified" as const),
      literal("deleted" as const),
    ]),
  }, { unknownKeys: "error" }),
  object({
    ...sessionGitFileBase,
    kind: literal("tracked" as const),
    status: literal("renamed" as const),
    previousPath: sessionGitPathSchema,
    previousDisplayPath: sessionGitPathSchema,
  }, { unknownKeys: "error" }),
]);
const sessionGitUntrackedFileSchema = object({
  ...sessionGitFileBase,
  kind: literal("untracked" as const),
  status: literal("added" as const),
}, { unknownKeys: "error" });
export const sessionGitFileSchema = union([
  sessionGitTrackedFileSchema,
  sessionGitUntrackedFileSchema,
]);

const sessionGitPatchSchema = string().refine(
  (value) =>
    byteLength(value) <= MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES &&
    jsonByteLength(value) <= MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  `Git Snapshot patch sections must fit within ${MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES} JSON bytes.`,
);
const sessionGitSectionBase = {
  patch: sessionGitPatchSchema,
  truncated: booleanSchema,
} as const;
const sessionGitStagedSectionSchema = object({
  ...sessionGitSectionBase,
  files: array(sessionGitTrackedFileSchema),
}, { unknownKeys: "error" });
const sessionGitUnstagedSectionSchema = object({
  ...sessionGitSectionBase,
  files: array(sessionGitFileSchema),
}, { unknownKeys: "error" });
const sessionGitSectionsSchema = object({
  staged: sessionGitStagedSectionSchema,
  unstaged: sessionGitUnstagedSectionSchema,
}, { unknownKeys: "error" }).refine(
  (value) =>
    value.staged.files.length + value.unstaged.files.length <= MAX_SESSION_GIT_SNAPSHOT_FILES &&
    jsonByteLength([...value.staged.files, ...value.unstaged.files]) <=
      MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES &&
    byteLength(value.staged.patch) + byteLength(value.unstaged.patch) <=
      MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES &&
    jsonByteLength({ staged: value.staged.patch, unstaged: value.unstaged.patch }) <=
      MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  "Git Snapshot sections exceed their file or patch budgets.",
);

export const sessionGitSnapshotSchema = object({
  generatedAt: string(),
  completeness: union([literal("complete" as const), literal("incomplete" as const)]),
  stale: booleanSchema,
  truncated: booleanSchema,
  message: optional(string()),
  sections: sessionGitSectionsSchema,
}, { unknownKeys: "error" });

export type SessionGitFileData = InferOutput<typeof sessionGitFileSchema>;
export type SessionGitSnapshotData = InferOutput<typeof sessionGitSnapshotSchema>;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonByteLength(value: unknown): number {
  return byteLength(JSON.stringify(value));
}
