import type { WorkspaceId } from "@openorb/protocol/runner-api";
import type { WorkspaceEvent } from "./api.ts";

/** Frames a viewer may leave unread before it is dropped; it reconnects for a fresh snapshot. */
const MAX_QUEUED_FRAMES = 64;
const KEEPALIVE_MS = 15_000;

interface Viewer {
  readonly workspaceId: WorkspaceId;
  send(frame: string): void;
}

/** Live Server-Sent Event streams of Workspace events, held in memory only. */
export class WorkspaceEventStreams {
  readonly #viewers = new Set<Viewer>();

  publish(workspaceId: WorkspaceId, event: WorkspaceEvent): void {
    const frame = eventFrame(event);
    for (const viewer of this.#viewers) {
      if (viewer.workspaceId === workspaceId) viewer.send(frame);
    }
  }

  /**
   * A stream that opens with `snapshot`. `subscribe` calls `attach` where no event can be published
   * between taking the snapshot and attaching, so the viewer sees every later event.
   */
  async open(
    workspaceId: WorkspaceId,
    signal: AbortSignal,
    subscribe: (attach: (snapshot: WorkspaceEvent) => void) => Promise<void>,
  ): Promise<Response> {
    const encoder = new TextEncoder();
    const viewers = this.#viewers;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return false;
      stopped = true;
      viewers.delete(viewer);
      clearInterval(heartbeat);
      return true;
    };
    const end = () => {
      if (stop()) controller.close();
    };
    const viewer: Viewer = {
      workspaceId,
      send(frame) {
        if (stopped) return;
        if ((controller.desiredSize ?? 0) <= 0) end();
        else controller.enqueue(encoder.encode(frame));
      },
    };
    const body = new ReadableStream<Uint8Array>(
      { start: (started) => void (controller = started), cancel: () => void stop() },
      new CountQueuingStrategy({ highWaterMark: MAX_QUEUED_FRAMES }),
    );
    await subscribe((snapshot) => {
      if (stopped) return;
      viewers.add(viewer);
      viewer.send(eventFrame(snapshot));
      heartbeat = setInterval(() => viewer.send(": keepalive\n\n"), KEEPALIVE_MS);
    });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

function eventFrame(event: WorkspaceEvent): string {
  return `event: workspace\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Opens a Workspace event stream through the Workspace Durable Object's HTTP handler. */
export function workspaceEventsFrom(workspace: {
  fetch(request: Request): Promise<Response>;
}): (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<Response> {
  return (workspaceId, signal) => {
    const url = new URL("https://workspace.internal/events");
    url.searchParams.set("workspaceId", workspaceId);
    return workspace.fetch(new Request(url, { signal }));
  };
}
