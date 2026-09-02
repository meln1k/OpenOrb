import { clientEntry, css, type Handle } from "remix/ui";
import type { SessionIssue } from "@openorb/protocol/browser-session-events";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { routes } from "@/app/routes.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
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
} from "@/app/ui/components/index.ts";

type SerializableData<Value> = Value extends readonly (infer Item)[] ? SerializableData<Item>[]
  : Value extends object ? { [Key in keyof Value]: SerializableData<Value[Key]> }
  : Value;

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
            {handle.props.error ? <p role="alert" mix={errorStyle}>{handle.props.error}</p> : null}
            <SessionTranscript
              contextWindow={handle.props.contextWindow}
              csrfToken={handle.props.csrfToken}
              sessionId={handle.props.session.id}
            />
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
      <Button size="sm" variant="ghost" commandFor={dialogId} command="show-modal">
        Delete
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
