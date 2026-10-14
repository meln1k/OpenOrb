import { DEFAULT_SESSION_THINKING_LEVEL, SESSION_THINKING_LEVELS } from "@openorb/protocol";
import type { RunnerSessionSnapshot, SessionIssue } from "@openorb/protocol/runner-api";
import { Frame, type Handle } from "remix/component";

import type { SessionCatalogEntry, SessionNavigationEntry } from "../../cells/workspace/api.ts";
import { modelContextWindow, modelThinkingLevels } from "../../model-provider-catalog.ts";
import { routes } from "../../routes.ts";
import type { SessionComposerData } from "../../session-composer-data.ts";
import { SessionDetailClient } from "./public/session-detail-client.tsx";
import { AppShellLayout, SESSION_WORKSPACE_FRAME } from "../../ui/public/shell.tsx";
import { Document } from "../../ui/document.tsx";

interface SessionDetailPageProps {
  composer: SessionComposerData;
  csrfToken: string;
  frameSrc: string | undefined;
  session: SessionCatalogEntry;
  sidebarSessions: SessionNavigationEntry[];
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
  session: SessionCatalogEntry;
  snapshot: RunnerSessionSnapshot | null;
}

export function SessionDetailFrame(handle: Handle<SessionDetailFrameProps>) {
  const { csrfToken, error, session, snapshot } = handle.props;
  // Without a view the Session Durable Object is unreachable.
  const state = snapshot?.state ?? "offline";
  const issues: readonly SessionIssue[] = snapshot?.issues ?? [];
  const initialThinkingLevel =
    snapshot === null ? DEFAULT_SESSION_THINKING_LEVEL : snapshot.initialThinkingLevel;

  return () => (
    <SessionDetailClient
      // Only a Session with a project loads Git integration (ADR 0007).
      changes={session.projectId !== undefined}
      contextWindow={snapshot === null ? 0 : (modelContextWindow(snapshot.model) ?? 0)}
      csrfToken={csrfToken}
      error={error}
      initialState={state}
      initialAgentState={snapshot?.agentState ?? null}
      initialEnvironmentState={snapshot?.environmentState ?? null}
      initialIssues={[...issues]}
      initialThinkingLevel={initialThinkingLevel}
      sessionId={session.id}
      sessionName={nameSession(session)}
      thinkingLevels={[
        ...(snapshot === null
          ? SESSION_THINKING_LEVELS
          : (modelThinkingLevels(snapshot.model) ?? SESSION_THINKING_LEVELS)),
      ]}
    />
  );
}

function nameSession(session: SessionCatalogEntry): string {
  return session.initialPromptPreview || "Untitled session";
}
