import { Layer, Predicate, Schema } from "effect";
import * as SchemaBinary from "effect/unstable/encoding/SchemaBinary";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

import { RunnerIdentity, SessionId } from "./runner-api-schemas.ts";
import {
  MAX_RUNNER_BULK_CHUNK_BYTES,
  MAX_RUNNER_BULK_RPC_FRAME_BYTES,
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_FILE_NAME_CHARACTERS,
} from "./runner-api-limits.ts";

export const SessionGitSnapshotId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);
export type SessionGitSnapshotId = typeof SessionGitSnapshotId.Type;

export const SessionGitPatchSection = Schema.Literals(["staged", "unstaged"]);
export type SessionGitPatchSection = typeof SessionGitPatchSection.Type;

export const SessionArtifactId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("SessionArtifactId"),
);
export type SessionArtifactId = typeof SessionArtifactId.Type;

export const SessionArtifactMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
]);
export type SessionArtifactMediaType = typeof SessionArtifactMediaType.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BinaryChunk = Schema.Uint8Array.check(
  Schema.isMaxLength(MAX_RUNNER_BULK_CHUNK_BYTES),
);

export class SessionArtifact extends Schema.Class<SessionArtifact>("SessionArtifact")({
  id: SessionArtifactId,
  fileName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SESSION_ARTIFACT_FILE_NAME_CHARACTERS),
  ),
  mediaType: SessionArtifactMediaType,
  byteLength: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_SESSION_ARTIFACT_BYTES),
  ),
}) {}

export class IdentifyBulkRunner extends Rpc.make("runner.bulk.identify", {
  success: RunnerIdentity,
}) {}

export class WatchBulkRunner extends Rpc.make("runner.bulk.watch", {
  success: Schema.Struct({ observedAt: NonNegativeInt }),
  stream: true,
}) {}

export class ReadSessionGitPatchChunkPayload
  extends Schema.Class<ReadSessionGitPatchChunkPayload>("ReadSessionGitPatchChunkPayload")({
    sessionId: SessionId,
    snapshotId: SessionGitSnapshotId,
    section: SessionGitPatchSection,
    offset: NonNegativeInt,
  }) {}

export class SessionGitPatchChunk extends Schema.Class<SessionGitPatchChunk>(
  "SessionGitPatchChunk",
)({
  snapshotId: SessionGitSnapshotId,
  section: SessionGitPatchSection,
  offset: NonNegativeInt,
  bytes: BinaryChunk,
  nextOffset: NonNegativeInt,
  done: Schema.Boolean,
}) {}

export class GitPatchReadError extends Schema.TaggedError<GitPatchReadError>()(
  "GitPatchReadError",
  {
    sessionId: SessionId,
    message: Schema.String,
  },
) {}

export class ReadSessionArtifactChunkPayload
  extends Schema.Class<ReadSessionArtifactChunkPayload>("ReadSessionArtifactChunkPayload")({
    sessionId: SessionId,
    artifactId: SessionArtifactId,
    offset: NonNegativeInt,
  }) {}

export class SessionArtifactChunk extends Schema.Class<SessionArtifactChunk>(
  "SessionArtifactChunk",
)({
  artifact: SessionArtifact,
  offset: NonNegativeInt,
  bytes: BinaryChunk,
}) {}

export class ArtifactReadError extends Schema.TaggedError<ArtifactReadError>()(
  "ArtifactReadError",
  {
    sessionId: SessionId,
    message: Schema.String,
  },
) {}

export class ReadSessionGitPatchChunk extends Rpc.make("session.git-patch.read-chunk", {
  payload: ReadSessionGitPatchChunkPayload,
  success: SessionGitPatchChunk,
  error: GitPatchReadError,
}) {}

export class ReadSessionArtifactChunk extends Rpc.make("session.artifact.read-chunk", {
  payload: ReadSessionArtifactChunkPayload,
  success: SessionArtifactChunk,
  error: ArtifactReadError,
}) {}

export const RunnerBulkApi = RpcGroup.make(
  IdentifyBulkRunner,
  WatchBulkRunner,
  ReadSessionGitPatchChunk,
  ReadSessionArtifactChunk,
);

const schemaBinaryTextEncoder = new TextEncoder();

const runnerBulkRpcSerialization = RpcSerialization.RpcSerialization.of({
  contentType: "application/vnd.effect.rpc+schema-binary",
  includesFraming: true,
  codecFor: SchemaBinary.toCodec,
  makeUnsafe: () => {
    // Effect rc.112's dictionary decoder is broken for repeated strings across frames.
    // https://github.com/Effect-TS/effect/commit/20bd53d4a9aeede26c28b725db29d1a384e905d0
    const options = { fingerprint: true, dictionary: false } as const;
    const parser = SchemaBinary.parser(RpcMessage.EncodedSchema, {
      ...options,
      maxFrameSize: MAX_RUNNER_BULK_RPC_FRAME_BYTES,
    });
    const encoder = SchemaBinary.encoder(RpcMessage.EncodedSchema, options);
    return {
      decode: (data: Uint8Array | string) =>
        parser.feedSync(
          Predicate.isString(data) ? schemaBinaryTextEncoder.encode(data) : data,
        ),
      encode: (message: unknown) => {
        if (!Array.isArray(message)) return encoder.encode(message);
        if (message.length === 0) return undefined;
        return encoder.encodeMany(message);
      },
    };
  },
});

export const runnerBulkRpcSerializationLayer = Layer.succeed(
  RpcSerialization.RpcSerialization,
  runnerBulkRpcSerialization,
);
