import type { RunnerSessionSnapshot } from "@openorb/protocol/runner-api";
import type { Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { modelContextWindow } from "@/app/model-provider-catalog.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionDetailClient } from "@/app/ui/session/session-detail-client.tsx";
import { Document } from "@/app/ui/document.tsx";

interface SessionDetailPageProps {
  composer: SessionComposerData;
  csrfToken: string;
  session: SessionCatalogEntry;
  runnerId: string | null;
  snapshot: RunnerSessionSnapshot | null;
  sidebarSessions: SessionCatalogEntry[];
  error: string | undefined;
}

export function SessionDetailPage(handle: Handle<SessionDetailPageProps>) {
  const {
    composer,
    csrfToken,
    error,
    runnerId,
    session,
    sidebarSessions,
    snapshot,
  } = handle.props;
  const state = snapshot?.state ?? (runnerId ? "created" : "offline");
  const canRetry = snapshot?.state === "error" && runnerId !== null;
  const sessionName = session.initialPromptPreview || "Untitled session";

  return () => (
    <Document title={`${sessionName} · OpenOrb`}>
      <SessionDetailClient
        canRetry={canRetry}
        composer={composer}
        contextWindow={snapshot === null ? 0 : modelContextWindow(snapshot.model) ?? 0}
        csrfToken={csrfToken}
        error={error}
        initialState={state}
        session={session}
        sidebarSessions={sidebarSessions}
      />
    </Document>
  );
}
