import type { RunnerSessionSnapshot } from "@openorb/protocol/runner-api";
import type { Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { modelContextWindow } from "@/app/model-provider-catalog.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { SessionDetailClient } from "@/app/ui/session/session-detail-client.tsx";
import { Document } from "@/app/ui/document.tsx";

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
  stopHref: string;
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
    stopHref,
    wakeHref,
  } = handle.props;
  const state = snapshot?.state ?? (runnerId ? "created" : "offline");
  const canRetry = snapshot?.state === "error" && runnerId !== null;
  const sessionName = session.initialPromptPreview || "Untitled session";

  return () => (
    <Document title={`${sessionName} · OpenOrb`}>
      <SessionDetailClient
        abortHref={abortHref}
        canRetry={canRetry}
        changesHref={changesHref}
        composer={composer}
        contextWindow={snapshot === null ? 0 : modelContextWindow(snapshot.model) ?? 0}
        csrfToken={csrfToken}
        error={error}
        eventsHref={eventsHref}
        gitSnapshotHref={gitSnapshotHref}
        initialState={state}
        messageHref={messageHref}
        retryHref={retryHref}
        session={session}
        sidebarSessions={sidebarSessions}
        stopHref={stopHref}
        wakeHref={wakeHref}
      />
    </Document>
  );
}
