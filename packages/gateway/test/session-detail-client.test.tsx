import { test } from "vite-plus/test";
import { assertMatch, assertNotMatch, assertStringIncludes } from "@jsr/std__assert";
import { renderToString } from "remix/component/server";

import { SessionDetailClient } from "../app/actions/sessions/public/session-detail-client.tsx";

test("session detail defaults mobile navigation to the agent view", async () => {
  const html = await renderToString(
    <SessionDetailClient
      changes
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="ready"
      initialAgentState="idle"
      initialEnvironmentState="running"
      initialEnvironmentReachable
      initialIssues={[]}
      initialThinkingLevel="max"
      sessionId="session-id"
      sessionName="Mobile session tabs"
      thinkingLevels={["off", "low", "high"]}
    />,
  );

  assertStringIncludes(html, 'role="tablist" aria-label="Session views"');
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
  assertStringIncludes(html, 'data-thinking-level="max"');
});

test("session composer replaces send with stop during an active turn", async () => {
  const html = await renderToString(
    <SessionDetailClient
      changes
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="running"
      initialAgentState="running"
      initialEnvironmentState="stopped"
      initialEnvironmentReachable
      initialIssues={[]}
      initialThinkingLevel="high"
      sessionId="session-id"
      sessionName="Active session"
      thinkingLevels={["off", "low", "high"]}
    />,
  );

  assertMatch(html, /aria-label="Stop active turn"/);
  assertStringIncludes(html, "Agent: running · Environment: stopped");
  assertStringIncludes(html, 'aria-label="Stop Session"');
  assertMatch(html, /data-slot="stop-icon"/);
  assertNotMatch(html, /aria-label="Send prompt"/);
});

test("a disconnected runner does not show its environment as running", async () => {
  const html = await renderToString(
    <SessionDetailClient
      changes
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="ready"
      initialAgentState="idle"
      initialEnvironmentState="running"
      initialEnvironmentReachable={false}
      initialIssues={[]}
      initialThinkingLevel="high"
      sessionId="session-id"
      sessionName="Disconnected session"
      thinkingLevels={["off", "low", "high"]}
    />,
  );

  assertStringIncludes(html, "Agent: idle · Environment: unreachable");
  assertNotMatch(html, /Environment: running/);
  assertMatch(html, /data-session-vm-status data-phase="offline"/);
  assertStringIncludes(html, "data-runner-unreachable");
  assertMatch(html, /aria-label="Stop Session"[^>]*disabled/);
  assertMatch(html, /aria-label="Send prompt"/);
});

test("a session without Git integration shows no changes panel or view tabs", async () => {
  const html = await renderToString(
    <SessionDetailClient
      changes={false}
      contextWindow={1_000}
      csrfToken="csrf-token"
      error={undefined}
      initialState="ready"
      initialAgentState="idle"
      initialEnvironmentState="running"
      initialEnvironmentReachable
      initialIssues={[]}
      initialThinkingLevel="high"
      sessionId="session-id"
      sessionName="Sandbox session"
      thinkingLevels={["off", "low", "high"]}
    />,
  );

  assertNotMatch(html, /data-slot="changes-panel"/);
  assertNotMatch(html, /role="tablist"/);
  assertStringIncludes(html, 'aria-label="Agent"');
  assertStringIncludes(html, 'aria-label="Delete session"');
});
