import {
  type SessionGitSnapshotData,
  sessionGitSnapshotSchema,
} from "../../../../protocol/src/browser-session-git-snapshot.ts";
import { tryAsync, trySync } from "../../../../result/src/index.ts";
import { object, parseSafe, string } from "remix/data-schema";
import { type Handle, type RemixNode, TypedEventTarget } from "remix/ui";

import { routes } from "@/app/routes.ts";
import {
  type PreparedSessionChanges,
  prepareSessionChanges,
} from "@/app/ui/session/session-change-files.tsx";
import {
  type SessionPageController,
  SessionPageScope,
} from "@/app/ui/session/session-page-controller.tsx";

const errorResponseSchema = object({ error: string() }, { unknownKeys: "error" });

export type LoadedSessionChanges = {
  readonly snapshot: SessionGitSnapshotData;
  readonly changes: PreparedSessionChanges;
  readonly renderError: string | undefined;
};

export interface SessionChangesProjection {
  readonly loaded: LoadedSessionChanges | undefined;
  readonly loadError: string | undefined;
  readonly operationError: string | undefined;
}

interface SessionChangesEventMap {
  readonly change: Event;
}

export interface SessionChangesViewOwner {
  readonly variant: "sidebar" | "content";
}

export class SessionChangesResource extends TypedEventTarget<SessionChangesEventMap> {
  readonly #activeViews = new Set<SessionChangesViewOwner>();
  readonly #csrfToken: string;
  readonly #sessionId: string;
  readonly #signal: AbortSignal;
  #connected = false;
  #mutationInFlight = false;
  #projection: SessionChangesProjection = {
    loaded: undefined,
    loadError: undefined,
    operationError: undefined,
  };
  #refreshInFlight = false;
  #refreshPending = true;

  constructor(csrfToken: string, sessionId: string, signal: AbortSignal) {
    super();
    this.#csrfToken = csrfToken;
    this.#sessionId = sessionId;
    this.#signal = signal;
  }

  get projection(): SessionChangesProjection {
    return this.#projection;
  }

  connect(page: SessionPageController): void {
    if (this.#connected) return;
    this.#connected = true;
    page.addEventListener("session", (message) => {
      if (message.detail.type === "git.snapshot.updated") void this.#requestRefresh();
    }, { signal: this.#signal });
    page.addEventListener("connection", () => {
      if (!page.projection.connectionInterrupted) void this.#requestRefresh();
    }, { signal: this.#signal });
  }

  setViewActive(view: SessionChangesViewOwner, active: boolean): void {
    const wasActive = this.#activeViews.size > 0;
    if (active) this.#activeViews.add(view);
    else this.#activeViews.delete(view);
    if (!wasActive && this.#activeViews.size > 0 && !this.#refreshInFlight) {
      void this.#requestRefresh();
    }
  }

  async updateFile(
    action: "stage" | "unstage",
    path: string,
    previousPath?: string,
  ): Promise<void> {
    if (this.#mutationInFlight) return;
    this.#mutationInFlight = true;
    this.#projection = { ...this.#projection, operationError: undefined };
    // Keep browser-side cleanup parseable by Safari, which does not support `using`.
    try {
      const body = new URLSearchParams();
      body.set("_csrf", this.#csrfToken);
      body.set("action", action);
      body.set("path", path);
      if (previousPath !== undefined) body.set("previousPath", previousPath);
      const [response, requestError] = await tryAsync(
        fetch(routes.api.sessions.changes.href({ sessionId: this.#sessionId }), {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          body,
          signal: this.#signal,
        }),
        () => true,
      );
      if (requestError !== undefined) {
        if (!this.#signal.aborted) {
          this.#projection = {
            ...this.#projection,
            operationError: "The Git index update could not reach the runner.",
          };
        }
        return;
      }
      if (!response.ok) {
        const [responseBody, bodyError] = await tryAsync(response.json(), () => true);
        if (bodyError !== undefined) {
          this.#projection = {
            ...this.#projection,
            operationError: "The Git index could not be updated.",
          };
          return;
        }
        this.#projection = {
          ...this.#projection,
          operationError: errorMessage(responseBody),
        };
      }
    } finally {
      this.#mutationInFlight = false;
      if (!this.#signal.aborted) {
        this.#notify();
        await this.#requestRefresh();
      }
    }
  }

  async #prepareSnapshotChanges(
    snapshot: SessionGitSnapshotData,
  ): Promise<{ readonly changes: PreparedSessionChanges; readonly error?: string }> {
    if (changedFileCount(snapshot) === 0) {
      return { changes: prepareSessionChanges(snapshot) };
    }
    const [diffs, importError] = await tryAsync(import("@pierre/diffs"), () => true);
    if (importError !== undefined) {
      return {
        changes: prepareSessionChanges(snapshot),
        error: "The diff viewer could not be loaded.",
      };
    }
    const [prepared, parseError] = trySync(
      () => prepareSessionChanges(snapshot, diffs, `${this.#sessionId}:${snapshot.generatedAt}`),
      () => true,
    );
    if (parseError !== undefined) {
      const fallback = prepareSessionChanges(snapshot);
      return {
        changes: { ...fallback, CodeView: diffs.CodeView },
        error: snapshot.truncated
          ? "The truncated patch could not be rendered."
          : "The patch could not be rendered.",
      };
    }
    return { changes: prepared };
  }

  async #refresh(): Promise<void> {
    this.#projection = { ...this.#projection, loadError: undefined };
    if (this.#signal.aborted) return;
    const [response, requestError] = await tryAsync(
      fetch(routes.api.sessions.gitSnapshot.href({ sessionId: this.#sessionId }), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: this.#signal,
      }),
      () => true,
    );
    if (requestError !== undefined) {
      if (!this.#signal.aborted) {
        this.#setLoadError("Changes are unavailable because the runner could not be reached.");
      }
      return;
    }
    if (this.#signal.aborted) return;
    const [body, bodyError] = await tryAsync(response.json(), () => true);
    if (bodyError !== undefined) {
      if (!this.#signal.aborted) {
        this.#setLoadError(
          response.ok
            ? "The runner returned an invalid Git Snapshot."
            : "The cached Git Snapshot is unavailable.",
        );
      }
      return;
    }
    if (this.#signal.aborted) return;
    if (!response.ok) {
      this.#setLoadError(errorMessage(body, "The cached Git Snapshot is unavailable."));
      return;
    }
    const parsed = parseSafe(sessionGitSnapshotSchema, body);
    if (!parsed.success) {
      this.#setLoadError("The runner returned an invalid Git Snapshot.");
      return;
    }

    const snapshot = parsed.value;
    const preparation = await this.#prepareSnapshotChanges(snapshot);
    if (this.#signal.aborted) return;
    this.#projection = {
      ...this.#projection,
      loaded: {
        snapshot,
        changes: preparation.changes,
        renderError: preparation.error,
      },
    };
    this.#notify();
  }

  async #requestRefresh(): Promise<void> {
    this.#refreshPending = true;
    if (
      this.#mutationInFlight || this.#activeViews.size === 0 || this.#refreshInFlight ||
      this.#signal.aborted
    ) return;
    this.#refreshInFlight = true;
    // Keep browser-side cleanup parseable by Safari, which does not support `using`.
    try {
      while (
        this.#refreshPending && this.#activeViews.size > 0 && !this.#signal.aborted
      ) {
        this.#refreshPending = false;
        await this.#refresh();
      }
    } finally {
      this.#refreshInFlight = false;
    }
  }

  #setLoadError(message: string): void {
    this.#projection = { ...this.#projection, loadError: message };
    this.#notify();
  }

  #notify(): void {
    this.dispatchEvent(new Event("change"));
  }
}

interface SessionChangesScopeProps {
  readonly children?: RemixNode;
  readonly csrfToken: string;
  readonly sessionId: string;
}

export function SessionChangesScope(
  handle: Handle<SessionChangesScopeProps, SessionChangesResource>,
) {
  const page = handle.context.get(SessionPageScope);
  const resource = new SessionChangesResource(
    handle.props.csrfToken,
    handle.props.sessionId,
    handle.signal,
  );
  handle.context.set(resource);
  handle.queueTask(() => resource.connect(page));

  return () => <>{handle.props.children}</>;
}

export function changedFileCount(snapshot: SessionGitSnapshotData): number {
  return new Set([
    ...snapshot.sections.staged.files.map((file) => file.path),
    ...snapshot.sections.unstaged.files.map((file) => file.path),
  ]).size;
}

function errorMessage(body: unknown, fallback = "The Git index could not be updated."): string {
  const parsed = parseSafe(errorResponseSchema, body);
  return parsed.success ? parsed.value.error : fallback;
}
