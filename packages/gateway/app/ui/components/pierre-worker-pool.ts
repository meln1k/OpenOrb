import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from "@pierre/diffs/worker";

export function getPierreWorkerPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {
      poolSize: 2,
      workerFactory: () =>
        new Worker(
          new URL("./worker-portable.js", import.meta.resolve("@pierre/diffs/worker")),
          { type: "module" },
        ),
    },
    highlighterOptions: {
      theme: { light: "pierre-light", dark: "pierre-dark" },
      preferredHighlighter: "shiki-js",
    },
  });
}
