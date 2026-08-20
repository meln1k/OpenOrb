import type { RunnerSessionSnapshot } from "@openorb/protocol";
import { css, type Handle } from "remix/ui";

import type { Project } from "@/app/data/project-repository.ts";
import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
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
      heading={project.name}
      copy={session.initialPromptPreview}
    >
      {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
      <SessionEventView
        canRetry={canRetry}
        createdAt={formatInstant(session.createdAt)}
        csrfToken={csrfToken}
        eventsHref={eventsHref}
        initialState={state}
        projectName={project.name}
        repositoryUrl={project.repositoryUrl}
        retryHref={retryHref}
        runnerLabel={runnerId ?? "Offline"}
        sessionId={session.id}
      />
    </AppShell>
  );
}

function formatInstant(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", "Z");
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
