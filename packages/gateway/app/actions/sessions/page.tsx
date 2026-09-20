import type { RunnerSessionSnapshot, SessionIssue } from "@openorb/protocol/runner-api";
import { Frame, type Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { modelContextWindow } from "@/app/model-provider-catalog.ts";
import { routes } from "@/app/routes.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionDetailClient } from "@/app/ui/session/session-detail-client.tsx";
import { AppShellLayout, SESSION_WORKSPACE_FRAME } from "@/app/ui/shell.tsx";
import { Document } from "@/app/ui/document.tsx";

interface SessionDetailPageProps {
  composer: SessionComposerData;
  csrfToken: string;
  frameSrc: string | undefined;
  session: SessionCatalogEntry;
  sidebarSessions: SessionCatalogEntry[];
}

export function SessionDetailPage(handle: Handle<SessionDetailPageProps>) {
  const { composer, csrfToken, frameSrc, session, sidebarSessions } = handle.props;
  const sessionName = nameSession(session);

  return () => (
    <Document title={`${sessionName} · OpenOrb`}>
      <AppShellLayout
        activeSessionId={session.id}
        composer={composer}
        csrfToken={csrfToken}
        sessions={sidebarSessions}
        title={`${sessionName} · OpenOrb`}
        workspace={
          <Frame
            name={SESSION_WORKSPACE_FRAME}
            src={frameSrc ?? routes.app.sessions.frame.href({ sessionId: session.id })}
          />
        }
      />
    </Document>
  );
}

interface SessionDetailFrameProps {
  csrfToken: string;
  error: string | undefined;
  runnerId: string | null;
  session: SessionCatalogEntry;
  snapshot: RunnerSessionSnapshot | null;
}

export function SessionDetailFrame(handle: Handle<SessionDetailFrameProps>) {
  const { csrfToken, error, runnerId, session, snapshot } = handle.props;
  const state = snapshot?.state ?? (runnerId ? "created" : "offline");
  const issues: readonly SessionIssue[] = snapshot?.issues ?? [];

  return () => (
    <SessionDetailClient
      contextWindow={snapshot === null ? 0 : modelContextWindow(snapshot.model) ?? 0}
      csrfToken={csrfToken}
      error={error}
      initialState={state}
      initialIssues={[...issues]}
      sessionId={session.id}
      sessionName={nameSession(session)}
    />
  );
}

function nameSession(session: SessionCatalogEntry): string {
  return session.initialPromptPreview || "Untitled session";
}
