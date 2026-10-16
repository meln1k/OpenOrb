import { Effect, Schema } from "effect";

// A Git Snapshot is derived from guest output and persisted in the Session Durable Object, so it is
// validated against these budgets before it is stored or served (ADR 0006).
export const MAX_SESSION_GIT_PATH_CHARACTERS = 4_096;
export const MAX_SESSION_GIT_SNAPSHOT_FILES = 5_000;
export const MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES = 768 * 1024;
export const MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES = 256 * 1024;
export const MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES = 192 * 1024;
export const MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES = 256 * 1024;
export const MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES = 110 * 1024;
/** A full patch is read from the guest in chunks of at most this many bytes. */
export const MAX_GIT_PATCH_CHUNK_BYTES = 1024 * 1024;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const GitMutationRevision = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const SessionGitSnapshotId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const SessionGitPatchSection = Schema.Literals(["staged", "unstaged"]);
export type SessionGitPatchSection = typeof SessionGitPatchSection.Type;
export type SessionGitFileAction = "stage" | "unstage";

export function isSafeGitReference(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

const SessionGitReference = Schema.String.check(
  Schema.makeFilter((value) =>
    isSafeGitReference(value) ? undefined : "Expected a valid Git branch or tag reference.",
  ),
);
const SessionGitHead = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40,64}$/, { message: "Expected a Git object identifier." }),
);
const Instant = Schema.String.check(
  Schema.makeFilter((value) =>
    Schema.decodeUnknownResult(Schema.DateTimeUtcFromString)(value)._tag === "Success"
      ? undefined
      : "Expected an ISO 8601 instant.",
  ),
);
const SafeMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));

function strictObject<F extends Schema.Struct.Fields>(schema: Schema.Struct<F>): Schema.Struct<F> {
  // Reject undeclared keys even when this struct is nested.
  const isExtra = (key: PropertyKey) => !Object.hasOwn(schema.fields, key);
  return schema.rebuild(
    Schema.StructWithRest(schema, [
      Schema.Record(Schema.String.check(Schema.makeFilter(isExtra)), Schema.Never),
      Schema.Record(Schema.Symbol.check(Schema.makeFilter(isExtra)), Schema.Never),
    ]).ast,
  );
}

const SessionGitPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) =>
    Array.from(value).length <= MAX_SESSION_GIT_PATH_CHARACTERS
      ? undefined
      : `Git paths must contain at most ${MAX_SESSION_GIT_PATH_CHARACTERS} characters.`,
  ),
);
const SessionGitFileBase = {
  path: SessionGitPath,
  displayPath: SessionGitPath,
  diffState: Schema.Literals(["available", "binary", "truncated"]),
} as const;
const SessionGitTrackedFile = Schema.Union([
  Schema.Struct({
    ...SessionGitFileBase,
    kind: Schema.Literal("tracked"),
    status: Schema.Literals(["added", "modified", "deleted"]),
  }).pipe(strictObject),
  Schema.Struct({
    ...SessionGitFileBase,
    kind: Schema.Literal("tracked"),
    status: Schema.Literal("renamed"),
    previousPath: SessionGitPath,
    previousDisplayPath: SessionGitPath,
  }).pipe(strictObject),
]);
const SessionGitUntrackedFile = Schema.Struct({
  ...SessionGitFileBase,
  kind: Schema.Literal("untracked"),
  status: Schema.Literal("added"),
}).pipe(strictObject);
export const SessionGitFile = Schema.Union([SessionGitTrackedFile, SessionGitUntrackedFile]);
export type SessionGitFile = typeof SessionGitFile.Type;
export type SessionGitFileStatus = SessionGitFile["status"];
export type SessionGitDiffState = SessionGitFile["diffState"];

const SessionGitPatch = Schema.String.check(
  Schema.makeFilter((value) =>
    utf8Length(value) <= MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES
      ? undefined
      : `Git Snapshot patch sections must be at most ${MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_BYTES} UTF-8 bytes.`,
  ),
  Schema.makeFilter((value) =>
    utf8Length(JSON.stringify(value)) <= MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES
      ? undefined
      : `Git Snapshot patch sections must fit within ${MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES} JSON bytes.`,
  ),
);
const SessionGitSectionBase = {
  patch: SessionGitPatch,
  fullPatchBytes: Schema.optionalKey(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES)),
  ),
  truncated: Schema.Boolean,
} as const;
const SessionGitSections = Schema.Struct({
  staged: Schema.Struct({
    ...SessionGitSectionBase,
    files: Schema.Array(SessionGitTrackedFile),
  }).pipe(strictObject),
  unstaged: Schema.Struct({ ...SessionGitSectionBase, files: Schema.Array(SessionGitFile) }).pipe(
    strictObject,
  ),
})
  .pipe(strictObject)
  .check(
    Schema.makeFilter((value) => {
      const files = [...value.staged.files, ...value.unstaged.files];
      return files.length <= MAX_SESSION_GIT_SNAPSHOT_FILES &&
        utf8Length(JSON.stringify(files)) <= MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES
        ? undefined
        : `Git Snapshot file metadata must fit within ${MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES} JSON bytes and ${MAX_SESSION_GIT_SNAPSHOT_FILES} rows.`;
    }),
    Schema.makeFilter((value) =>
      utf8Length(value.staged.patch) + utf8Length(value.unstaged.patch) <=
        MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES &&
      utf8Length(
        JSON.stringify({
          staged: value.staged.patch,
          unstaged: value.unstaged.patch,
        }),
      ) <= MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES
        ? undefined
        : `Git Snapshot patches must fit within ${MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES} JSON bytes.`,
    ),
  );

/** A plain object, so it crosses Durable Object RPC and reaches the browser as it is. */
export const SessionGitSnapshot = Schema.Struct({
  snapshotId: Schema.optionalKey(SessionGitSnapshotId),
  mutationRevision: GitMutationRevision.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0)),
  ),
  generatedAt: Instant,
  branch: Schema.optionalKey(SessionGitReference),
  head: Schema.optionalKey(SessionGitHead),
  completeness: Schema.Literals(["complete", "incomplete"]),
  stale: Schema.Boolean,
  truncated: Schema.Boolean,
  message: Schema.optionalKey(SafeMessage),
  sections: SessionGitSections,
}).pipe(strictObject);
export type SessionGitSnapshot = typeof SessionGitSnapshot.Type;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
