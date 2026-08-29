import {
  type SessionGitSnapshotData,
  sessionGitSnapshotSchema,
} from "../../../../protocol/src/browser-session-git-snapshot.ts";
import { tryAsync, trySync } from "../../../../result/src/index.ts";
import { object, parseSafe, string } from "remix/data-schema";
import { clientEntry, css, type Handle } from "remix/ui";

import { Icon } from "../components/icons.tsx";
import {
  type PreparedSessionChanges,
  prepareSessionChanges,
  SessionChangeFiles,
} from "./session-change-files.tsx";

const errorResponseSchema = object({ error: string() }, { unknownKeys: "error" });

export type SessionChangesPanelProps = {
  changesHref: string;
  csrfToken: string;
  gitSnapshotHref: string;
  sessionId: string;
};

type LoadedSessionChanges = {
  readonly snapshot: SessionGitSnapshotData;
  readonly changes: PreparedSessionChanges;
  readonly renderError?: string;
};

export const SessionChangesPanel = clientEntry<SessionChangesPanelProps>(
  import.meta.url,
  function SessionChangesPanel(handle: Handle<SessionChangesPanelProps>) {
    let loaded: LoadedSessionChanges | undefined;
    let loadError: string | undefined;
    let operationError: string | undefined;
    let refreshInFlight = false;
    let refreshPending = true;
    let mutationInFlight = false;
    let sidebar: HTMLDetailsElement | undefined;

    function setMutationButtons(disabled: boolean, activeButton?: HTMLButtonElement) {
      const panel = document.getElementById(handle.id);
      for (
        const button of panel?.querySelectorAll<HTMLButtonElement>("[data-git-file-action]") ?? []
      ) {
        button.disabled = disabled;
        const active = disabled && button === activeButton;
        if (active) button.setAttribute("aria-busy", "true");
        else button.removeAttribute("aria-busy");
        button.querySelector("[data-slot='git-file-action-idle']")?.toggleAttribute(
          "hidden",
          active,
        );
        button.querySelector("[data-slot='git-file-action-spinner']")?.toggleAttribute(
          "hidden",
          !active,
        );
      }
    }

    async function prepareSnapshotChanges(
      nextSnapshot: SessionGitSnapshotData,
    ): Promise<{ readonly changes: PreparedSessionChanges; readonly error?: string }> {
      if (!nextSnapshot.sections.staged.patch && !nextSnapshot.sections.unstaged.patch) {
        return { changes: prepareSessionChanges(nextSnapshot) };
      }
      const [diffs, importError] = await tryAsync(import("@pierre/diffs"), () => true);
      if (importError !== undefined) {
        return {
          changes: prepareSessionChanges(nextSnapshot),
          error: "The diff viewer could not be loaded.",
        };
      }
      const [prepared, parseError] = trySync(
        () =>
          prepareSessionChanges(
            nextSnapshot,
            diffs,
            `${handle.props.sessionId}:${nextSnapshot.generatedAt}`,
          ),
        () => true,
      );
      if (parseError !== undefined) {
        return {
          changes: prepareSessionChanges(nextSnapshot),
          error: nextSnapshot.truncated
            ? "The truncated patch could not be rendered."
            : "The patch could not be rendered.",
        };
      }
      return { changes: prepared };
    }

    async function updateFile(
      action: "stage" | "unstage",
      path: string,
      button: HTMLButtonElement,
      previousPath?: string,
    ) {
      if (mutationInFlight) return;
      mutationInFlight = true;
      operationError = undefined;
      setMutationButtons(true, button);
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        mutationInFlight = false;
        setMutationButtons(false);
        if (handle.signal.aborted) return;
        await handle.update();
        await requestRefresh();
      });
      const body = new URLSearchParams();
      body.set("_csrf", handle.props.csrfToken);
      body.set("action", action);
      body.set("path", path);
      if (previousPath !== undefined) body.set("previousPath", previousPath);
      const [response, requestError] = await tryAsync(
        fetch(handle.props.changesHref, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          body,
          signal: handle.signal,
        }),
        () => true,
      );
      if (requestError !== undefined) {
        if (!handle.signal.aborted) {
          operationError = "The Git index update could not reach the runner.";
        }
        return;
      }
      if (!response.ok) {
        const [responseBody, bodyError] = await tryAsync(response.json(), () => true);
        if (bodyError !== undefined) {
          operationError = "The Git index could not be updated.";
          return;
        }
        const parsedError = parseSafe(errorResponseSchema, responseBody);
        operationError = parsedError.success
          ? parsedError.value.error
          : "The Git index could not be updated.";
      }
    }

    async function refresh() {
      const initialLoad = loaded === undefined;
      loadError = undefined;
      if (initialLoad) {
        await handle.update();
      }
      if (handle.signal.aborted) return;
      const [response, requestError] = await tryAsync(
        fetch(handle.props.gitSnapshotHref, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: handle.signal,
        }),
        () => true,
      );
      if (requestError !== undefined) {
        if (handle.signal.aborted) return;
        loadError = "Changes are unavailable because the runner could not be reached.";
        await handle.update();
        return;
      }
      if (handle.signal.aborted) return;
      const [body, bodyError] = await tryAsync(response.json(), () => true);
      if (bodyError !== undefined) {
        if (handle.signal.aborted) return;
        loadError = response.ok
          ? "The runner returned an invalid Git Snapshot."
          : "The cached Git Snapshot is unavailable.";
        await handle.update();
        return;
      }
      if (handle.signal.aborted) return;
      if (!response.ok) {
        const parsedError = parseSafe(errorResponseSchema, body);
        loadError = parsedError.success
          ? parsedError.value.error
          : "The cached Git Snapshot is unavailable.";
        await handle.update();
        return;
      }
      const parsed = parseSafe(sessionGitSnapshotSchema, body);
      if (!parsed.success) {
        loadError = "The runner returned an invalid Git Snapshot.";
        await handle.update();
        return;
      }

      const nextSnapshot = parsed.value;
      const preparation = await prepareSnapshotChanges(nextSnapshot);
      if (handle.signal.aborted) return;
      loaded = {
        snapshot: nextSnapshot,
        changes: preparation.changes,
        ...(preparation.error === undefined ? {} : { renderError: preparation.error }),
      };
      await handle.update();
    }

    async function requestRefresh() {
      refreshPending = true;
      if (mutationInFlight || !sidebar?.open || refreshInFlight || handle.signal.aborted) return;
      refreshInFlight = true;
      using cleanup = new DisposableStack();
      cleanup.defer(() => {
        refreshInFlight = false;
      });
      while (refreshPending && sidebar.open && !handle.signal.aborted) {
        refreshPending = false;
        await refresh();
      }
    }

    handle.queueTask(() => {
      const panel = document.getElementById(handle.id);
      const ancestor = panel?.closest<HTMLDetailsElement>(
        'details[data-slot="sidebar-desktop"][data-side="right"]',
      );
      if (!(ancestor instanceof HTMLDetailsElement)) return;
      sidebar = ancestor;
      const onSnapshotChanged = (event: Event) => {
        if (
          !(event instanceof CustomEvent) ||
          event.detail?.sessionId !== handle.props.sessionId
        ) return;
        void requestRefresh();
      };
      const onSidebarToggle = () => {
        if (sidebar?.open) void requestRefresh();
      };
      globalThis.addEventListener("openorb:session-git-snapshot-changed", onSnapshotChanged);
      sidebar.addEventListener("toggle", onSidebarToggle);
      handle.signal.addEventListener("abort", () => {
        globalThis.removeEventListener(
          "openorb:session-git-snapshot-changed",
          onSnapshotChanged,
        );
        sidebar?.removeEventListener("toggle", onSidebarToggle);
      }, { once: true });
      void requestRefresh();
    });

    return () => (
      <section id={handle.id} data-slot="changes-panel" mix={changesPanelStyle}>
        <header mix={panelHeaderStyle}>
          <span mix={panelTitleStyle}>
            <Icon name="file-diff" size={18} />
            <strong data-slot="changes-tab">Changes</strong>
          </span>
          {loaded ? <span mix={changedCountStyle}>{changedFileCount(loaded.snapshot)}</span> : null}
        </header>
        <div mix={panelContentStyle}>
          {!loaded && !loadError
            ? <p role="status" mix={panelMessageStyle}>Loading changes…</p>
            : loadError && !loaded
            ? <p role="alert" mix={panelMessageStyle}>{loadError}</p>
            : loaded
            ? (
              <>
                {loadError ? <p role="alert" mix={operationErrorStyle}>{loadError}</p> : null}
                {loaded.snapshot.stale || loaded.snapshot.completeness === "incomplete" ||
                    loaded.snapshot.truncated
                  ? (
                    <div mix={snapshotWarningsStyle}>
                      {loaded.snapshot.stale ? <span>Stale</span> : null}
                      {loaded.snapshot.completeness === "incomplete"
                        ? <span>Incomplete</span>
                        : null}
                      {loaded.snapshot.truncated ? <span>Truncated</span> : null}
                    </div>
                  )
                  : null}
                {loaded.snapshot.message
                  ? <p role="status" mix={snapshotNoticeStyle}>{loaded.snapshot.message}</p>
                  : null}
                {operationError
                  ? <p role="alert" mix={operationErrorStyle}>{operationError}</p>
                  : null}
                {loaded.renderError
                  ? <p role="alert" mix={operationErrorStyle}>{loaded.renderError}</p>
                  : null}
                {changedFileCount(loaded.snapshot) === 0
                  ? <p mix={panelMessageStyle}>No staged or unstaged changes.</p>
                  : (
                    <SessionChangeFiles
                      {...loaded.changes}
                      onUpdate={(action, path, button, previousPath) =>
                        void updateFile(action, path, button, previousPath)}
                    />
                  )}
              </>
            )
            : null}
        </div>
      </section>
    );
  },
);

function changedFileCount(snapshot: SessionGitSnapshotData): number {
  return new Set([
    ...snapshot.sections.staged.files.map((file) => file.path),
    ...snapshot.sections.unstaged.files.map((file) => file.path),
  ]).size;
}

const changesPanelStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  color: "var(--sidebar-foreground)",
  background: "var(--sidebar)",
});
const panelHeaderStyle = css({
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  height: "64px",
  padding: "0 14px",
  borderBottom: "1px solid var(--sidebar-border)",
});
const panelTitleStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  color: "var(--foreground)",
  "& strong": { fontSize: "14px", fontWeight: 600 },
});
const changedCountStyle = css({
  minWidth: "22px",
  marginLeft: "auto",
  padding: "1px 7px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderRadius: "999px",
  fontSize: "12px",
  textAlign: "center",
});
const panelContentStyle = css({ flex: 1, minHeight: 0, overflow: "auto" });
const snapshotWarningsStyle = css({
  display: "flex",
  gap: "10px",
  padding: "8px 14px",
  color: "var(--destructive)",
  borderBottom: "1px solid var(--sidebar-border)",
  fontSize: "12px",
  fontWeight: 600,
});
const snapshotNoticeStyle = css({
  margin: 0,
  padding: "8px 14px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderBottom: "1px solid var(--sidebar-border)",
  fontSize: "12px",
});
const operationErrorStyle = css({
  margin: 0,
  padding: "8px 14px",
  color: "var(--destructive)",
  borderBottom: "1px solid var(--sidebar-border)",
  fontSize: "12px",
});
const panelMessageStyle = css({
  margin: "auto",
  padding: "24px",
  color: "var(--muted-foreground)",
  fontSize: "13px",
  textAlign: "center",
});
