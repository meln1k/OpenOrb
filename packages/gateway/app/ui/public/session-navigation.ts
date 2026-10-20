import { trySync } from "../../../../result/src/index.ts";
import { parseSafe, string } from "remix/data-schema";

import type { SessionNavigationEntry, WorkspaceEvent } from "../../cells/workspace/api.ts";
import { routes } from "../../routes.ts";

/**
 * The sidebar's live Session list, shared by both sidebars and the navigation behavior of a page
 * through one Workspace event stream. Until the stream's first snapshot arrives, and on the server,
 * the server-rendered list stands.
 */
class SessionNavigation {
  #sessions: SessionNavigationEntry[] | undefined;
  #selectedSessionId: string | undefined;
  /** Sessions whose Agent Run settled since the viewer last opened them. */
  readonly #settled = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #stream: EventSource | undefined;

  sessions(rendered: SessionNavigationEntry[]): SessionNavigationEntry[] {
    return this.#sessions ?? rendered;
  }

  selectedSessionId(rendered: string | undefined): string | undefined {
    return this.#selectedSessionId ?? rendered;
  }

  settled(sessionId: string): boolean {
    return this.#settled.has(sessionId);
  }

  /** The viewer opened this Session, or none, so the open one's finished work is seen. */
  select(sessionId: string | undefined): void {
    const seen = sessionId !== undefined && this.#settled.delete(sessionId);
    if (this.#selectedSessionId === sessionId && !seen) return;
    this.#selectedSessionId = sessionId;
    this.#notify();
  }

  /** Calls `listener` after each change until `signal` aborts; the last one closes the stream. */
  subscribe(listener: () => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.#listeners.add(listener);
    this.#stream ??= this.#open();
    signal.addEventListener(
      "abort",
      () => {
        this.#listeners.delete(listener);
        if (this.#listeners.size > 0) return;
        this.#stream?.close();
        this.#stream = undefined;
      },
      { once: true },
    );
  }

  #open(): EventSource {
    const stream = new EventSource(routes.api.sessions.updates.href());
    stream.addEventListener("workspace", (message) => {
      if (message instanceof MessageEvent) this.#apply(parseWorkspaceEvent(message.data));
    });
    return stream;
  }

  #apply(event: WorkspaceEvent | undefined): void {
    const sessions = this.#sessions;
    switch (event?.type) {
      case "sessions.snapshot":
        // Every (re)connection starts here, so a Session created while disconnected appears.
        this.#sessions = event.sessions;
        break;
      case "session.created":
        // The snapshot, which always comes first, may already list it.
        if (sessions === undefined || sessions.some(({ id }) => id === event.session.id)) return;
        this.#sessions = [event.session, ...sessions];
        break;
      case "session.settled":
        if (event.sessionId === this.#selectedSessionId) return;
        this.#settled.add(event.sessionId);
        break;
      default:
        return;
    }
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const sessionNavigation = new SessionNavigation();

function parseWorkspaceEvent(data: unknown): WorkspaceEvent | undefined {
  const encoded = parseSafe(string(), data);
  if (!encoded.success) return undefined;
  const [event, error] = trySync(
    // SAFETY: the Workspace Durable Object emits only WorkspaceEvent values it constructs, and the
    // gateway serves the matching browser assets in the same deployment.
    () => JSON.parse(encoded.value) as WorkspaceEvent,
    () => true,
  );
  if (error !== undefined) return undefined;
  return event;
}
