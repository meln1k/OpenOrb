import { DurableObject } from "cloudflare:workers";
import {
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
  serveCodemodeRemote,
} from "@earendil-works/pi-codemode/portable";
import { Cause, Deferred, Effect, Queue } from "effect";
import wasm from "quickjs-wasi/quickjs.wasm";
import { CODEMODE_INTERRUPT_BUDGET, CODEMODE_MEMORY_BYTES } from "./limits.ts";
import type { CodemodeNext, CodemodeVmRpc } from "./protocol.ts";

interface Execution {
  readonly batches: Queue.Queue<CodemodeNext["batches"][number], Cause.Done>;
  readonly replies: Map<number, Deferred.Deferred<CodemodeRemoteReply>>;
  seq: number;
}

/**
 * Codemode's VM, loaded by the Session Durable Object as a facet with no bindings and no network
 * (ADR 0009). Its limits are advisory: they run in the isolate whose code they limit.
 */
export class CodemodeVm extends DurableObject<unknown> implements CodemodeVmRpc {
  readonly #executions = new Map<string, Execution>();

  async run(id: string, request: CodemodeRemoteRequest): Promise<void> {
    const execution = this.#execution(id);
    const exchange = (messages: CodemodeRemoteMessage[]) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const reply = yield* Deferred.make<CodemodeRemoteReply>();
          const seq = execution.seq++;
          execution.replies.set(seq, reply);
          yield* Queue.offer(execution.batches, { seq, messages });
          return yield* Deferred.await(reply);
        }),
      );
    using _ended = {
      [Symbol.dispose]: () => Effect.runSync(Queue.end(execution.batches)),
    };
    await serveCodemodeRemote(request, exchange, {
      wasm,
      maxInterruptBudget: CODEMODE_INTERRUPT_BUDGET,
      maxMemoryLimitBytes: CODEMODE_MEMORY_BYTES,
    });
  }

  next(id: string): Promise<CodemodeNext> {
    const execution = this.#execution(id);
    return Effect.runPromise(
      Queue.takeAll(execution.batches).pipe(
        Effect.map((batches) => ({ batches, done: false })),
        Effect.catchIf(Cause.isDone, () => {
          this.#executions.delete(id);
          return Effect.succeed({ batches: [], done: true });
        }),
      ),
    );
  }

  async reply(id: string, seq: number, reply: CodemodeRemoteReply): Promise<void> {
    const replies = this.#executions.get(id)?.replies;
    const waiting = replies?.get(seq);
    if (waiting === undefined) return;
    replies?.delete(seq);
    Effect.runSync(Deferred.succeed(waiting, reply));
  }

  /** `run` and the first `next` may arrive in either order. */
  #execution(id: string): Execution {
    let execution = this.#executions.get(id);
    if (execution === undefined) {
      execution = { batches: Effect.runSync(Queue.unbounded()), replies: new Map(), seq: 0 };
      this.#executions.set(id, execution);
    }
    return execution;
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
