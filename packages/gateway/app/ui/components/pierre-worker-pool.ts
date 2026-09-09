import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from "@pierre/diffs/worker";

export function getPierreWorkerPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {
      poolSize: 2,
      workerFactory: () =>
        new Worker(new URL("./pierre-diff-worker.ts", import.meta.url), { type: "module" }),
    },
    highlighterOptions: {
      theme: { light: "pierre-light", dark: "pierre-dark" },
      preferredHighlighter: "shiki-js",
    },
  });
}
