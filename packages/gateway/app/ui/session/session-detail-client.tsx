import { clientEntry, css, type Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionChangesPanel } from "@/app/ui/session/session-changes-panel.tsx";
import { SessionPageScope } from "@/app/ui/session/session-page-controller.tsx";
import { SessionTranscript } from "@/app/ui/session/session-transcript.tsx";
import type { SessionState } from "@/app/ui/session/session-transcript-state.ts";
import { SessionVmControl } from "@/app/ui/session/session-vm-control.tsx";
import { AppShellLayout } from "@/app/ui/shell.tsx";

type SerializableData<Value> = Value extends readonly (infer Item)[] ? SerializableData<Item>[]
  : Value extends object ? { [Key in keyof Value]: SerializableData<Value[Key]> }
  : Value;

export type SessionDetailClientProps = {
  readonly abortHref: string;
  readonly canRetry: boolean;
  readonly changesHref: string;
  readonly composer: SerializableData<SessionComposerData>;
  readonly contextWindow: number;
  readonly csrfToken: string;
  readonly error: string | undefined;
  readonly eventsHref: string;
  readonly gitSnapshotHref: string;
  readonly initialState: SessionState;
  readonly messageHref: string;
  readonly retryHref: string;
  readonly session: SerializableData<SessionCatalogEntry>;
  readonly sidebarSessions: SerializableData<SessionCatalogEntry[]>;
  readonly stopHref: string;
  readonly wakeHref: string;
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
          eventsHref={handle.props.eventsHref}
          initialState={handle.props.initialState}
          wakeHref={handle.props.wakeHref}
        >
          <AppShellLayout
            activeSessionId={handle.props.session.id}
            composer={handle.props.composer}
            csrfToken={handle.props.csrfToken}
            sessions={handle.props.sidebarSessions}
            title={`${sessionName} · OpenOrb`}
            topBarAccessory={
              <SessionVmControl
                csrfToken={handle.props.csrfToken}
                stopHref={handle.props.stopHref}
                wakeHref={handle.props.wakeHref}
              />
            }
            topBarTitle={sessionName}
            rightSidebar={
              <SessionChangesPanel
                changesHref={handle.props.changesHref}
                csrfToken={handle.props.csrfToken}
                gitSnapshotHref={handle.props.gitSnapshotHref}
                sessionId={handle.props.session.id}
              />
            }
          >
            {handle.props.error ? <p role="alert" mix={errorStyle}>{handle.props.error}</p> : null}
            <SessionTranscript
              abortHref={handle.props.abortHref}
              canRetry={handle.props.canRetry}
              contextWindow={handle.props.contextWindow}
              csrfToken={handle.props.csrfToken}
              messageHref={handle.props.messageHref}
              retryHref={handle.props.retryHref}
              sessionId={handle.props.session.id}
            />
          </AppShellLayout>
        </SessionPageScope>
      );
    };
  },
);

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
