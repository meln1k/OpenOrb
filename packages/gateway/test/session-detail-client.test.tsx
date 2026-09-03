import { assertMatch, assertNotMatch, assertStringIncludes } from "@std/assert";
import { renderToString } from "remix/ui/server";

import { SessionDetailClient } from "@/app/ui/session/session-detail-client.tsx";

Deno.test("session detail defaults mobile navigation to the agent view", async () => {
  const html = await renderToString(
    <SessionDetailClient
      composer={{
        projects: [],
        models: [],
        hasConfiguredRunner: true,
        hasConnectedRunner: true,
      }}
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="ready"
      initialIssues={[]}
      session={{
        id: "session-id",
        projectId: "project-id",
        createdAt: "2026-01-01T00:00:00Z",
        initialPromptPreview: "Mobile session tabs",
      }}
      sidebarSessions={[]}
    />,
  );

  assertStringIncludes(html, 'role="tablist" aria-label="Session views"');
  assertStringIncludes(html, '"exportName":"SidebarMobileSwipeBehavior"');
  assertMatch(
    html,
    /id="([^"]+)-agent-tab"[^>]+role="tab" aria-selected="true" aria-controls="\1-agent-panel" tabindex="0"/,
  );
  assertMatch(
    html,
    /id="([^"]+)-changes-tab"[^>]+role="tab" aria-selected="false" aria-controls="\1-changes-panel" tabindex="-1"/,
  );
  assertMatch(
    html,
    /id="([^"]+)-agent-panel" role="tabpanel" aria-labelledby="\1-agent-tab" data-active="true"/,
  );
  assertMatch(
    html,
    /id="([^"]+)-changes-panel" role="tabpanel" aria-labelledby="\1-changes-tab" data-active="false"/,
  );
  assertStringIncludes(html, 'data-slot="changes-panel" data-variant="sidebar"');
  assertNotMatch(html, /data-slot="changes-panel" data-variant="content"/);
});

Deno.test("session composer replaces send with stop during an active turn", async () => {
  const html = await renderToString(
    <SessionDetailClient
      composer={{
        projects: [],
        models: [],
        hasConfiguredRunner: true,
        hasConnectedRunner: true,
      }}
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="running"
      initialIssues={[]}
      session={{
        id: "session-id",
        projectId: "project-id",
        createdAt: "2026-01-01T00:00:00Z",
        initialPromptPreview: "Active session",
      }}
      sidebarSessions={[]}
    />,
  );

  assertMatch(html, /aria-label="Stop active turn"/);
  assertMatch(html, /data-slot="stop-icon"/);
  assertNotMatch(html, /aria-label="Send prompt"/);
});
