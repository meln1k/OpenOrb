import { run } from "remix/ui";

const app = run({
  async loadModule(moduleUrl, exportName) {
    const module = await import(moduleUrl);
    return module[exportName];
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
