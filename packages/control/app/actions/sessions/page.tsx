import type { RunnerSessionSnapshot } from "@openorb/protocol";
import { css, type Handle } from "remix/ui";

import type { Project } from "@/app/data/project-repository.ts";
import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import type { SessionComposerData } from "@/app/session-composer-data.ts";
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/ui/components/index.ts";
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
      <section
        aria-label="Provisioning status"
        data-session-events={eventsHref}
        data-session-state={state}
        mix={detailGridStyle}
      >
        <Card>
          <CardHeader>
            <CardTitle>Provisioning</CardTitle>
            <CardDescription>
              Session <code>{session.id}</code>
            </CardDescription>
            <CardAction>
              <span data-session-status data-state={state} mix={statusStyle}>
                {statusLabel(state)}
              </span>
            </CardAction>
          </CardHeader>
          <CardContent mix={metadataStyle}>
            <div>
              <span>Project</span>
              <strong>{project.name}</strong>
            </div>
            <div>
              <span>Repository</span>
              <strong>{project.repositoryUrl}</strong>
            </div>
            <div>
              <span>Runner</span>
              <strong>{runnerId ?? "Offline"}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{formatInstant(session.createdAt)}</strong>
            </div>
            <p data-session-warning hidden mix={warningStyle}></p>
            <form
              method="post"
              action={retryHref}
              data-session-retry
              hidden={!canRetry}
              mix={retryStyle}
            >
              <input type="hidden" name="_csrf" value={csrfToken} />
              <Button type="submit">Retry provisioning</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Provisioning output</CardTitle>
            <CardDescription>Bounded stdout and stderr streamed from the runner.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              data-session-output
              aria-live="polite"
              aria-label="Provisioning output"
              mix={outputStyle}
            >Waiting for runner output…</pre>
          </CardContent>
        </Card>
      </section>
    </AppShell>
  );
}

function statusLabel(state: string): string {
  switch (state) {
    case "created":
      return "Queued";
    case "provisioning":
      return "Provisioning";
    case "ready":
      return "Ready";
    case "error":
      return "Failed";
    default:
      return "Runner offline";
  }
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
const detailGridStyle = css({ display: "grid", gap: "20px", maxWidth: "1000px" });
const statusStyle = css({
  display: "inline-flex",
  alignItems: "center",
  minHeight: "24px",
  padding: "2px 10px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  "&[data-state='ready']": {
    color: "var(--primary-foreground)",
    background: "var(--primary)",
  },
  "&[data-state='error']": {
    color: "#fff",
    background: "var(--destructive)",
  },
});
const metadataStyle = css({
  display: "grid",
  gap: "12px",
  "& > div": { display: "grid", gap: "2px" },
  "& span": { color: "var(--muted-foreground)", fontSize: "12px" },
  "& strong": { overflowWrap: "anywhere", fontSize: "14px", fontWeight: 500 },
});
const warningStyle = css({
  margin: "4px 0 0",
  padding: "10px 12px",
  color: "var(--foreground)",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  fontSize: "13px",
});
const retryStyle = css({ marginTop: "4px" });
const outputStyle = css({
  minHeight: "220px",
  maxHeight: "480px",
  margin: 0,
  padding: "16px",
  overflow: "auto",
  color: "var(--foreground)",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
});
