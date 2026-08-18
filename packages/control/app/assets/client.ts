import {
  runnerSessionStateForProvisioningStage,
  type SessionProvisioningEvent,
  sessionProvisioningEventSchema,
} from "../../../../packages/protocol/src/runner-session-events.ts";
import { parseSafe, string } from "remix/data-schema";
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

const sessionStreams = new Map<HTMLElement, EventSource>();

function synchronizeSessionStreams() {
  for (const [element, stream] of sessionStreams) {
    if (element.isConnected) continue;
    stream.close();
    sessionStreams.delete(element);
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-session-events]")) {
    if (sessionStreams.has(element)) continue;
    const href = element.dataset.sessionEvents;
    if (!href) continue;
    const stream = new EventSource(href);
    sessionStreams.set(element, stream);
    connectSessionStream(element, stream);
  }
}

function connectSessionStream(element: HTMLElement, stream: EventSource) {
  const status = element.querySelector<HTMLElement>("[data-session-status]");
  const output = element.querySelector<HTMLElement>("[data-session-output]");
  const warning = element.querySelector<HTMLElement>("[data-session-warning]");
  const retry = element.querySelector<HTMLElement>("[data-session-retry]");
  let hasOutput = false;

  stream.addEventListener("session", (message) => {
    if (!(message instanceof MessageEvent)) return;
    const source = parseSafe(string(), message.data);
    if (!source.success) return;
    const event = parseSessionEvent(source.value);
    if (!event) return;
    if (event.type === "provisioning.log") {
      if (output) {
        if (!hasOutput) output.textContent = "";
        output.textContent += event.text;
        output.scrollTop = output.scrollHeight;
        hasOutput = true;
      }
      return;
    }

    const state = runnerSessionStateForProvisioningStage(event.stage);
    element.dataset.sessionState = state;
    if (status) {
      status.dataset.state = state;
      status.textContent = sessionStageLabel(event.stage);
    }
    if (warning && event.checkoutState === "unavailable") {
      warning.hidden = false;
      warning.textContent =
        "Repository checkout is unavailable. Provisioning completed without branch or setup steps.";
    }
    if (retry) retry.hidden = state !== "error";
  });

  stream.addEventListener("error", () => {
    if (
      status && element.dataset.sessionState !== "ready" && element.dataset.sessionState !== "error"
    ) {
      status.textContent = "Connection interrupted";
    }
  });
}

function parseSessionEvent(source: string): SessionProvisioningEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const parsed = parseSafe(sessionProvisioningEventSchema, value);
  return parsed.success ? parsed.value : null;
}

function sessionStageLabel(
  stage: Extract<SessionProvisioningEvent, {
    type: "session.state";
  }>["stage"],
): string {
  switch (stage) {
    case "created":
      return "Queued";
    case "starting-vm":
      return "Starting VM";
    case "cloning":
      return "Cloning repository";
    case "creating-branch":
      return "Creating branch";
    case "setup":
      return "Running setup";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

new MutationObserver(synchronizeSessionStreams).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
synchronizeSessionStreams();
