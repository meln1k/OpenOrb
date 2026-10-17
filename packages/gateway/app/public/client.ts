import { type LoadModule, run } from "remix/component";

const app = run({
  async loadModule(moduleUrl, exportName) {
    // The document import map already covers every client entry; see build-assets.ts.
    const module = await import(moduleUrl);
    // SAFETY: Remix hydration metadata names function exports produced by clientEntry().
    return module[exportName] as Awaited<ReturnType<LoadModule>>;
  },
});

app.addEventListener("error", (event) => {
  console.error(event.error);
});

await app.ready();

let visualViewportFrame = 0;

function synchronizeVisualViewport() {
  const viewport = globalThis.visualViewport;
  const height = Math.max(0, viewport?.height ?? globalThis.innerHeight);
  const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
  const root = document.documentElement;
  root.style.setProperty("--openorb-visual-viewport-height", `${height}px`);
  root.style.setProperty("--openorb-visual-viewport-center", `${offsetTop + height / 2}px`);
}

function scheduleVisualViewportSynchronization() {
  synchronizeVisualViewport();
  cancelAnimationFrame(visualViewportFrame);
  visualViewportFrame = requestAnimationFrame(synchronizeVisualViewport);
}

globalThis.addEventListener("resize", scheduleVisualViewportSynchronization);
globalThis.visualViewport?.addEventListener("resize", scheduleVisualViewportSynchronization);
globalThis.visualViewport?.addEventListener("scroll", scheduleVisualViewportSynchronization);
synchronizeVisualViewport();
