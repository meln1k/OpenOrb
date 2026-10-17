import {
  type CodemodeRemote,
  type CodemodeRemoteExchange,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_ITEMS,
} from "@earendil-works/pi-codemode/portable";
import { Schema } from "effect";
import { CODEMODE_WORKER } from "./code.ts";
import { CodemodeNext, type CodemodeVmRpc } from "./protocol.ts";

const FACET = "codemode";
/** Backstops the interrupt budget: the runtime terminates a call that computes longer. */
const CODEMODE_CPU_MS = 5_000;
let quickjs: ArrayBuffer | undefined;

/** This build carries no codemode worker; Pi reports it as a failed sandbox. */
export class CodemodeUnavailableError extends Error {
  constructor() {
    super("This gateway build does not include codemode.");
    this.name = "CodemodeUnavailableError";
  }
}

export interface CodemodeFacetOptions {
  readonly loader: WorkerLoader;
  readonly facets: DurableObjectFacets;
  readonly sessionId: string;
}

/**
 * Runs each codemode execution's VM in a facet loaded into its own isolate, with no bindings and
 * no network (ADR 0009). Pi's host side stays here: the Session pulls the VM's messages and
 * answers them, so every call starts in the Session. The facet keeps no state, so it is loaded
 * for the first running execution and discarded after the last, freeing its loader admission slot.
 */
export function codemodeFacet({ loader, facets, sessionId }: CodemodeFacetOptions): CodemodeRemote {
  // celld's explicit disposal extension is not declared by Cloudflare's WorkerStub types.
  let worker: (ReturnType<WorkerLoader["get"]> & { dispose(): void }) | undefined;
  let stub: CodemodeVmRpc | undefined;
  let running = 0;
  const facet = (): CodemodeVmRpc => {
    if (stub !== undefined) return stub;
    const { code, hash, wasm } = CODEMODE_WORKER;
    // Sources run unbundled in Vitest; only the build embeds the codemode worker.
    if (code === "") throw new CodemodeUnavailableError();
    // SAFETY: the facet runs the codemode worker's CodemodeVm class, whose RPC is CodemodeVmRpc.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    stub = facets.get(FACET, () => {
      // SAFETY: WorkerLoader.get returns the loaded worker synchronously or throws, never undefined.
      worker = loader.get(`openorb-codemode:${sessionId}:${hash}`, () => ({
        compatibilityDate: "2026-10-07",
        mainModule: "codemode.js",
        modules: {
          "codemode.js": code,
          // celld's Worker Loader takes WebAssembly as bytes, not as a compiled module.
          "quickjs.wasm": { wasm: (quickjs ??= Uint8Array.fromBase64(wasm).buffer) },
        },
        env: {},
        globalOutbound: null,
        limits: { cpuMs: CODEMODE_CPU_MS },
      })) as NonNullable<typeof worker>;
      return { class: worker.getDurableObjectClass("CodemodeVm") };
    }) as unknown as CodemodeVmRpc;
    return stub;
  };
  const retire = () => {
    // Stops a VM that still waits for a reply; its pending calls then reject.
    facets.abort(FACET, "Codemode stopped.");
    // The VM never writes storage; deleting it leaves nothing behind the Session.
    facets.delete(FACET);
    worker?.dispose();
    worker = undefined;
    stub = undefined;
  };
  return {
    async execute(request, exchange) {
      const vm = facet();
      const id = crypto.randomUUID();
      // A failed facet was already replaced; only this execution's facet may be stopped.
      const stop = () => {
        if (stub === vm) retire();
      };
      running++;
      using _running = {
        [Symbol.dispose]: () => {
          if (--running === 0) stop();
        },
      };
      const run = vm.run(id, request);
      const pull = relay(vm, id, guardExchange(exchange)).catch((cause: unknown) => {
        // A VM that outlives its relay would wait for replies forever.
        stop();
        throw cause;
      });
      await Promise.all([run, pull]);
    },
  };
}

/**
 * Hands the VM's batches to Pi's host in the order the VM made them and returns each answer.
 * Pi's host handles a batch synchronously when `exchange` is called, so issuing the calls in
 * order keeps output before the call or result that follows.
 */
async function relay(vm: CodemodeVmRpc, id: string, exchange: CodemodeRemoteExchange) {
  const replies: Promise<void>[] = [];
  for (;;) {
    // The facet is untrusted: a batch that is not Pi's protocol fails the execution.
    const next = Schema.decodeUnknownSync(CodemodeNext)(await vm.next(id));
    for (const { seq, messages } of next.batches) {
      replies.push(exchange([...messages]).then((reply) => vm.reply(id, seq, reply)));
    }
    if (next.done) break;
  }
  await Promise.all(replies);
}

/**
 * Pi's output limits run inside the untrusted facet, so the Session enforces them again.
 * Past them the execution fails, and every later batch is told to stop.
 */
function guardExchange(exchange: CodemodeRemoteExchange): CodemodeRemoteExchange {
  let stopped = false;
  let chars = 0;
  let items = 0;
  return (messages) => {
    if (stopped) return Promise.resolve({ type: "stop" });
    for (const message of messages) {
      if (message.type !== "output") continue;
      const { item } = message;
      chars += item.type === "text" ? item.text.length : item.data.length;
      items++;
    }
    if (chars <= MAX_OUTPUT_CHARS && items <= MAX_OUTPUT_ITEMS) return exchange(messages);
    stopped = true;
    return exchange([{ type: "crash", message: "Codemode output exceeded its limit." }]).then(
      () => ({ type: "stop" }) as const,
    );
  };
}
