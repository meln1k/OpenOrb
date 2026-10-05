// Keep the namespace import so Remix retains the import-map entry used by import.meta.resolve.
import * as worker from "@pierre/diffs/worker";

export function getPierreWorkerPool(): worker.WorkerPoolManager {
  return worker.getOrCreateWorkerPoolSingleton({
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
