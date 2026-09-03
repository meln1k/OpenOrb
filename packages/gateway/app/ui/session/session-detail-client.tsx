import { clientEntry, css, type Handle, on } from "remix/ui";
import type { SessionIssue } from "@openorb/protocol/browser-session-events";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { routes } from "@/app/routes.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { media } from "@/app/ui/responsive.ts";
import { SessionChangesPanel } from "@/app/ui/session/session-changes-panel.tsx";
import { SessionPageScope } from "@/app/ui/session/session-page-controller.tsx";
import { SessionTranscript } from "@/app/ui/session/session-transcript.tsx";
import type { SessionState } from "@/app/ui/session/session-transcript-state.ts";
import { SessionVmControl } from "@/app/ui/session/session-vm-control.tsx";
import { AppShellLayout } from "@/app/ui/shell.tsx";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Icon,
} from "@/app/ui/components/index.ts";

type SerializableData<Value> = Value extends readonly (infer Item)[] ? SerializableData<Item>[]
  : Value extends object ? { [Key in keyof Value]: SerializableData<Value[Key]> }
  : Value;

type SessionMobileView = "agent" | "changes";

export type SessionDetailClientProps = {
  readonly composer: SerializableData<SessionComposerData>;
  readonly contextWindow: number;
  readonly csrfToken: string;
  readonly error: string | undefined;
  readonly initialState: SessionState;
  readonly initialIssues: SerializableData<readonly SessionIssue[]>;
  readonly session: SerializableData<SessionCatalogEntry>;
  readonly sidebarSessions: SerializableData<SessionCatalogEntry[]>;
};

export const SessionDetailClient = clientEntry<SessionDetailClientProps>(
  import.meta.url,
  function SessionDetailClient(handle: Handle<SessionDetailClientProps>) {
    let mobileView: SessionMobileView = "agent";
    const agentTabId = `${handle.id}-agent-tab`;
    const agentPanelId = `${handle.id}-agent-panel`;
    const changesTabId = `${handle.id}-changes-tab`;
    const changesPanelId = `${handle.id}-changes-panel`;

    async function selectMobileView(view: SessionMobileView, focus: boolean) {
      if (mobileView !== view) {
        mobileView = view;
        await handle.update();
      }
      if (!focus || handle.signal.aborted) return;
      document.getElementById(view === "agent" ? agentTabId : changesTabId)?.focus();
    }

    function mobileTabInteraction(view: SessionMobileView) {
      return [
        on<HTMLButtonElement, "click">("click", () => {
          void selectMobileView(view, false);
        }),
        on<HTMLButtonElement, "keydown">("keydown", (event) => {
          const next = event.key === "ArrowLeft" || event.key === "Home"
            ? "agent"
            : event.key === "ArrowRight" || event.key === "End"
            ? "changes"
            : undefined;
          if (next === undefined) return;
          event.preventDefault();
          void selectMobileView(next, true);
        }),
      ];
    }

    return () => {
      const sessionName = handle.props.session.initialPromptPreview || "Untitled session";
      return (
        <SessionPageScope
          key={handle.props.session.id}
          csrfToken={handle.props.csrfToken}
          initialState={handle.props.initialState}
          initialIssues={handle.props.initialIssues}
          sessionId={handle.props.session.id}
        >
          <AppShellLayout
            activeSessionId={handle.props.session.id}
            composer={handle.props.composer}
            csrfToken={handle.props.csrfToken}
            sessions={handle.props.sidebarSessions}
            title={`${sessionName} · OpenOrb`}
            topBarAccessory={
              <div mix={topBarActionsStyle}>
                <SessionVmControl
                  csrfToken={handle.props.csrfToken}
                  sessionId={handle.props.session.id}
                />
                <SessionDeletionControl
                  csrfToken={handle.props.csrfToken}
                  sessionId={handle.props.session.id}
                />
              </div>
            }
            topBarTitle={sessionName}
            rightSidebar={
              <SessionChangesPanel
                csrfToken={handle.props.csrfToken}
                sessionId={handle.props.session.id}
              />
            }
          >
            <div data-session-mobile-layout mix={mobileLayoutStyle}>
              <nav aria-label="Session views" mix={mobileTabsStyle}>
                <div role="tablist" aria-label="Session views" mix={mobileTabListStyle}>
                  <button
                    id={agentTabId}
                    type="button"
                    role="tab"
                    aria-selected={mobileView === "agent" ? "true" : "false"}
                    aria-controls={agentPanelId}
                    tabIndex={mobileView === "agent" ? 0 : -1}
                    mix={[
                      mobileTabStyle,
                      mobileView === "agent" && mobileTabSelectedStyle,
                      ...mobileTabInteraction("agent"),
                    ]}
                  >
                    <Icon name="message" size={18} />
                    Agent
                  </button>
                  <button
                    id={changesTabId}
                    type="button"
                    role="tab"
                    aria-selected={mobileView === "changes" ? "true" : "false"}
                    aria-controls={changesPanelId}
                    tabIndex={mobileView === "changes" ? 0 : -1}
                    mix={[
                      mobileTabStyle,
                      mobileView === "changes" && mobileTabSelectedStyle,
                      ...mobileTabInteraction("changes"),
                    ]}
                  >
                    <Icon name="file-diff" size={18} />
                    Changes
                  </button>
                </div>
              </nav>
              <section
                id={agentPanelId}
                role="tabpanel"
                aria-labelledby={agentTabId}
                data-active={mobileView === "agent" ? "true" : "false"}
                mix={mobileAgentPanelStyle}
              >
                {handle.props.error
                  ? <p role="alert" mix={errorStyle}>{handle.props.error}</p>
                  : null}
                <SessionTranscript
                  contextWindow={handle.props.contextWindow}
                  csrfToken={handle.props.csrfToken}
                  sessionId={handle.props.session.id}
                />
              </section>
              <section
                id={changesPanelId}
                role="tabpanel"
                aria-labelledby={changesTabId}
                data-active={mobileView === "changes" ? "true" : "false"}
                mix={mobileChangesPanelStyle}
              >
                {mobileView === "changes"
                  ? (
                    <SessionChangesPanel
                      csrfToken={handle.props.csrfToken}
                      sessionId={handle.props.session.id}
                      variant="content"
                    />
                  )
                  : null}
              </section>
            </div>
          </AppShellLayout>
        </SessionPageScope>
      );
    };
  },
);

function SessionDeletionControl(
  handle: Handle<{ readonly csrfToken: string; readonly sessionId: string }>,
) {
  const dialogId = `${handle.id}-delete-session`;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Delete session"
        title="Delete session"
        commandFor={dialogId}
        command="show-modal"
        mix={deleteButtonStyle}
      >
        <Icon name="trash-2" />
      </Button>
      <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
        <AlertDialogHeader>
          <AlertDialogTitle id={titleId}>Delete session?</AlertDialogTitle>
          <AlertDialogDescription id={descriptionId}>
            This permanently deletes the Pi conversation, workspace, checkpoints, snapshots, and
            logs for this session. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          method="post"
          action={routes.app.sessions.delete.href({ sessionId: handle.props.sessionId })}
        >
          <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
          <AlertDialogFooter>
            <Button type="button" variant="outline" commandFor={dialogId} command="close">
              Cancel
            </Button>
            <Button type="submit" variant="destructive">Delete session</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialog>
    </>
  );
}

const errorStyle = css({
  maxWidth: "900px",
  margin: 0,
  padding: "12px 14px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 10%, transparent)",
  border: "1px solid color-mix(in oklab, var(--destructive) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  fontSize: "14px",
});

const topBarActionsStyle = css({ display: "flex", alignItems: "center", gap: "4px" });
const mobileLayoutStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  margin: "0 -16px -16px",
  [media.xl]: { display: "contents", margin: 0 },
});
const mobileTabsStyle = css({
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  minWidth: 0,
  height: "56px",
  padding: "6px 12px",
  overflowX: "auto",
  borderBottom: "1px solid var(--border)",
  scrollbarWidth: "none",
  "&::-webkit-scrollbar": { display: "none" },
  [media.xl]: { display: "none" },
});
const mobileTabListStyle = css({ display: "flex", alignItems: "center", gap: "4px" });
const mobileTabStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  flexShrink: 0,
  minHeight: "44px",
  padding: "10px 14px",
  color: "var(--muted-foreground)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-lg)",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
  "&:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
});
const mobileTabSelectedStyle = css({
  color: "var(--foreground)",
  background: "var(--muted)",
});
const mobileAgentPanelStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "24px",
  minWidth: 0,
  minHeight: 0,
  padding: "0 16px 16px",
  "&[data-active='false']": { display: "none" },
  [media.xl]: {
    display: "contents",
    padding: 0,
    "&[data-active='false']": { display: "contents" },
  },
});
const mobileChangesPanelStyle = css({
  display: "flex",
  flex: 1,
  width: "100%",
  height: "calc(100svh - 120px)",
  minWidth: 0,
  minHeight: 0,
  "&[data-active='false']": { display: "none" },
  [media.xl]: { display: "none" },
});
const deleteButtonStyle = css({
  color: "var(--muted-foreground)",
  "&:hover, &:focus-visible": {
    color: "var(--destructive)",
    background: "color-mix(in oklab, var(--destructive) 10%, transparent)",
  },
});
