import type { RunnerSessionSnapshot } from "@openorb/protocol/runner-api";
import { css, type Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { modelContextWindow } from "@/app/model-provider-catalog.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionChangesPanel } from "@/app/ui/session/session-changes-panel.tsx";
import { SessionEventView } from "@/app/ui/session/session-event-view.tsx";
import { AppShell } from "@/app/ui/shell.tsx";

interface SessionDetailPageProps {
  abortHref: string;
  composer: SessionComposerData;
  csrfToken: string;
  changesHref: string;
  gitSnapshotHref: string;
  session: SessionCatalogEntry;
  runnerId: string | null;
  snapshot: RunnerSessionSnapshot | null;
  eventsHref: string;
  messageHref: string;
  retryHref: string;
  wakeHref: string;
  sidebarSessions: SessionCatalogEntry[];
  error: string | undefined;
}

export function SessionDetailPage(handle: Handle<SessionDetailPageProps>) {
  const {
    abortHref,
    composer,
    csrfToken,
    changesHref,
    gitSnapshotHref,
    error,
    eventsHref,
    messageHref,
    retryHref,
    runnerId,
    session,
    sidebarSessions,
    snapshot,
    wakeHref,
  } = handle.props;
  const state = snapshot?.state ?? (runnerId ? "created" : "offline");
  const canRetry = snapshot?.state === "error" && runnerId !== null;
  const sessionName = session.initialPromptPreview || "Untitled session";

  return () => (
    <AppShell
      activeSessionId={session.id}
      composer={composer}
      csrfToken={csrfToken}
      sessions={sidebarSessions}
      title={`${sessionName} · OpenOrb`}
      topBarTitle={sessionName}
      rightSidebar={
        <SessionChangesPanel
          changesHref={changesHref}
          csrfToken={csrfToken}
          gitSnapshotHref={gitSnapshotHref}
          sessionId={session.id}
        />
      }
    >
      {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
      <SessionEventView
        abortHref={abortHref}
        canRetry={canRetry}
        contextWindow={snapshot === null ? 0 : modelContextWindow(snapshot.model) ?? 0}
        csrfToken={csrfToken}
        eventsHref={eventsHref}
        initialState={state}
        messageHref={messageHref}
        retryHref={retryHref}
        sessionId={session.id}
        wakeHref={wakeHref}
      />
    </AppShell>
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
