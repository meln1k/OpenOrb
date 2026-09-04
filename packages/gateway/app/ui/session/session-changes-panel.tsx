import { css, type Handle } from "remix/ui";

import { Icon } from "../components/icons.tsx";
import { screens } from "../responsive.ts";
import { SessionChangeFiles } from "./session-change-files.tsx";
import { changedFileCount, SessionChangesScope } from "./session-changes-resource.tsx";

export type SessionChangesPanelProps = {
  sessionId: string;
  variant?: "sidebar" | "content";
};

export function SessionChangesPanel(handle: Handle<SessionChangesPanelProps>) {
  const changes = handle.context.get(SessionChangesScope);
  const variant = handle.props.variant ?? "sidebar";
  const panelId = `session-${handle.props.sessionId}-${variant}-changes`;
  const activation = { variant };
  let active = false;
  let sidebar: HTMLDetailsElement | undefined;

  handle.queueTask(() => {
    const desktop = globalThis.matchMedia(`(min-width: ${screens.xl})`);
    if (variant === "sidebar") {
      const panel = document.getElementById(panelId);
      const ancestor = panel?.closest<HTMLDetailsElement>(
        'details[data-slot="sidebar-desktop"][data-side="right"]',
      );
      if (ancestor instanceof HTMLDetailsElement) sidebar = ancestor;
    }

    const reconcileActivation = () => {
      const next = variant === "sidebar"
        ? desktop.matches && sidebar?.open === true
        : !desktop.matches;
      if (active === next) return;
      active = next;
      changes.setViewActive(activation, active);
      void handle.update();
    };
    const updateActiveView = () => {
      if (active) void handle.update();
    };
    changes.addEventListener("change", updateActiveView, { signal: handle.signal });
    desktop.addEventListener("change", reconcileActivation);
    sidebar?.addEventListener("toggle", reconcileActivation);
    handle.signal.addEventListener("abort", () => {
      desktop.removeEventListener("change", reconcileActivation);
      sidebar?.removeEventListener("toggle", reconcileActivation);
      changes.setViewActive(activation, false);
    }, { once: true });
    reconcileActivation();
  });

  return () => {
    const { loaded, loadError, operationError } = changes.projection;
    return (
      <section
        id={panelId}
        data-slot="changes-panel"
        data-variant={variant}
        mix={changesPanelStyle}
      >
        {variant === "sidebar"
          ? (
            <header mix={panelHeaderStyle}>
              <span mix={panelTitleStyle}>
                <Icon name="file-diff" size={18} />
                <strong data-slot="changes-tab">Changes</strong>
              </span>
              {loaded
                ? <span mix={changedCountStyle}>{changedFileCount(loaded.snapshot)}</span>
                : null}
            </header>
          )
          : null}
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
                {loaded.snapshot.branch || loaded.snapshot.head
                  ? (
                    <div data-slot="git-revision" mix={gitRevisionStyle}>
                      {loaded.snapshot.branch
                        ? <span title={loaded.snapshot.branch}>{loaded.snapshot.branch}</span>
                        : <span>Detached HEAD</span>}
                      {loaded.snapshot.head
                        ? (
                          <code title={loaded.snapshot.head}>
                            {loaded.snapshot.head.slice(0, 12)}
                          </code>
                        )
                        : null}
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
                  : active
                  ? (
                    <SessionChangeFiles
                      {...loaded.changes}
                      onUpdate={(action, path, previousPath) =>
                        changes.updateFile(action, path, previousPath)}
                    />
                  )
                  : null}
              </>
            )
            : null}
        </div>
      </section>
    );
  };
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
  "&[data-variant='content']": {
    color: "var(--foreground)",
    background: "var(--background)",
  },
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
const panelContentStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
  overflow: "hidden",
});
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
const gitRevisionStyle = css({
  display: "flex",
  gap: "8px",
  justifyContent: "space-between",
  minWidth: 0,
  padding: "8px 14px",
  color: "var(--muted-foreground)",
  borderBottom: "1px solid var(--sidebar-border)",
  fontSize: "12px",
  "& span": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  "& code": { flexShrink: 0, color: "var(--foreground)" },
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
