import type { RunnerSessionSnapshot } from "@openorb/protocol";
import { css, type Handle } from "remix/ui";

import type { Project } from "@/app/data/project-repository.ts";
import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { modelContextWindow } from "@/app/model-provider-catalog.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionEventView } from "@/app/ui/session/session-event-view.tsx";
import { AppShell } from "@/app/ui/shell.tsx";

interface SessionDetailPageProps {
  composer: SessionComposerData;
  csrfToken: string;
  session: SessionCatalogEntry;
  project: Project;
  runnerId: string | null;
  snapshot: RunnerSessionSnapshot | null;
  eventsHref: string;
  messageHref: string;
  retryHref: string;
  sidebarSessions: SessionCatalogEntry[];
  error?: string;
}

export function SessionDetailPage(handle: Handle<SessionDetailPageProps>) {
  const {
    composer,
    csrfToken,
    error,
    eventsHref,
    messageHref,
    project,
    retryHref,
    runnerId,
    session,
    sidebarSessions,
    snapshot,
  } = handle.props;
  const state = snapshot?.state ?? (runnerId ? "created" : "offline");
  const canRetry = snapshot?.state === "error" && runnerId !== null;

  return () => (
    <AppShell
      activeSessionId={session.id}
      composer={composer}
      csrfToken={csrfToken}
      sessions={sidebarSessions}
      title={`${project.name} session · OpenOrb`}
      eyebrow="Sessions"
    >
      {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
      <SessionEventView
        canRetry={canRetry}
        contextWindow={snapshot === null ? 0 : modelContextWindow(snapshot.model) ?? 0}
        csrfToken={csrfToken}
        eventsHref={eventsHref}
        initialState={state}
        messageHref={messageHref}
        retryHref={retryHref}
        sessionId={session.id}
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
