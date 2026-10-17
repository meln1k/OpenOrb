import type {
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import { Schema } from "effect";

/**
 * The Session pulls a codemode execution from its facet, because celld cannot pass Pi's `exchange`
 * callback into a loaded isolate (ADR 0009). Each batch is one `exchange` call of Pi's remote
 * protocol, numbered in the order the VM made them; the Session answers each with `reply`.
 */
export interface CodemodeVmRpc {
  /** Runs one execution's VM; resolves once it has stopped and its last batch was answered. */
  run(id: string, request: CodemodeRemoteRequest): Promise<void>;
  /**
   * Waits for the execution's next batches; `done` once it has stopped and none remain. The
   * Session decodes the reply against `CodemodeNext` anyway, because the facet is untrusted.
   */
  next(id: string): Promise<CodemodeNext>;
  reply(id: string, seq: number, reply: CodemodeRemoteReply): Promise<void>;
}

const During = Schema.Struct({ seq: Schema.Int, issued: Schema.Int });

/** Pi's `CodemodeRemoteMessage`, which the Session decodes because the facet is untrusted. */
const CodemodeMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("call"),
    id: Schema.Int,
    target: Schema.Literals(["tool", "global"]),
    name: Schema.String,
    args: Schema.UndefinedOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("output"),
    item: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("text"),
        text: Schema.String,
        console: Schema.optionalKey(Schema.Literal(true)),
      }),
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    ok: Schema.Literal(true),
    value: Schema.UndefinedOr(Schema.String),
    writes: Schema.String,
    during: Schema.optionalKey(During),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    ok: Schema.Literal(false),
    error: Schema.String,
    during: Schema.optionalKey(During),
  }),
  Schema.Struct({ type: Schema.Literal("crash"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("started"), fingerprint: Schema.String }),
  Schema.Struct({ type: Schema.Literal("idle"), seq: Schema.Int, issued: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    error: Schema.Struct({
      kind: Schema.Literals(["script", "timeout", "aborted", "sandbox"]),
      name: Schema.optionalKey(Schema.String),
      message: Schema.String,
      stack: Schema.optionalKey(Schema.String),
    }),
  }),
]);

/** What `next` returns: the batches in the order the VM made them, and whether it has stopped. */
export const CodemodeNext = Schema.Struct({
  batches: Schema.Array(
    Schema.Struct({ seq: Schema.Int, messages: Schema.Array(CodemodeMessage) }),
  ),
  done: Schema.Boolean,
});
export type CodemodeNext = typeof CodemodeNext.Type;
