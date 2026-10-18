import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import { renderToString } from "remix/component/server";

import { AppShellNavigation } from "../app/ui/public/shell.tsx";

test("session navigation groups projects by recent activity", async () => {
  const html = await renderToString(
    <AppShellNavigation
      activeSection={undefined}
      activeSessionId="beta-only"
      composer={{
        projects: [],
        models: [],
        hasConfiguredRunner: false,
        hasConnectedRunner: false,
      }}
      csrfToken="csrf-token"
      sessions={[
        {
          id: "beta-only",
          projectId: "beta",
          projectName: "Beta project",
          initialPromptPreview: "Only Beta session",
        },
        {
          id: "alpha-new",
          projectId: "alpha",
          projectName: "Alpha project",
          initialPromptPreview: "Newest Alpha session",
        },
        {
          id: "alpha-old",
          projectId: "alpha",
          projectName: "Alpha project",
          initialPromptPreview: "Older Alpha session",
        },
      ]}
      workspace={<main>Workspace</main>}
    />,
  );

  const betaGroup = html.indexOf('data-session-project="beta"');
  const betaSession = html.indexOf("Only Beta session", betaGroup);
  const alphaGroup = html.indexOf('data-session-project="alpha"');
  const newestAlpha = html.indexOf("Newest Alpha session", alphaGroup);
  const olderAlpha = html.indexOf("Older Alpha session", newestAlpha);

  assert(
    betaGroup !== -1 &&
      betaGroup < betaSession &&
      betaSession < alphaGroup &&
      alphaGroup < newestAlpha &&
      newestAlpha < olderAlpha,
  );
  for (const sessionName of ["Only Beta session", "Newest Alpha session", "Older Alpha session"]) {
    assertEquals([...html.matchAll(new RegExp(`>${sessionName}<`, "g"))].length, 2);
  }
});

test("child sessions nest under their parent, behind a toggle with their count", async () => {
  const html = await renderToString(
    <AppShellNavigation
      activeSection={undefined}
      activeSessionId="child-new"
      composer={{
        projects: [],
        models: [],
        hasConfiguredRunner: false,
        hasConnectedRunner: false,
      }}
      csrfToken="csrf-token"
      sessions={[
        { id: "child-new", initialPromptPreview: "Newest child", parentSessionId: "parent" },
        { id: "orphan", initialPromptPreview: "Orphaned child", parentSessionId: "deleted" },
        { id: "child-old", initialPromptPreview: "Older child", parentSessionId: "parent" },
        { id: "parent", initialPromptPreview: "Parent session" },
        { id: "single", initialPromptPreview: "Childless session" },
      ]}
      workspace={<main>Workspace</main>}
    />,
  );

  // Each sidebar (desktop and mobile) renders the tree once.
  const sidebar = html.slice(0, html.lastIndexOf(">Parent session<"));
  const orphan = sidebar.indexOf(">Orphaned child<");
  const parent = sidebar.indexOf(">Parent session<");
  const toggle = sidebar.indexOf('aria-label="2 child sessions"', parent);
  const newest = sidebar.indexOf(">Newest child<", toggle);
  const older = sidebar.indexOf(">Older child<", newest);
  const closed = sidebar.indexOf("</details>", older);
  const single = sidebar.indexOf(">Childless session<");
  assert(
    orphan !== -1 &&
      orphan < parent &&
      parent < toggle &&
      toggle < newest &&
      newest < older &&
      older < closed &&
      closed < single,
  );
  // Only the parent has a toggle; the orphan, whose parent is gone, shows at the top level.
  assertEquals([...sidebar.matchAll(/aria-label="\d+ child sessions?"/g)].length, 1);
  assertEquals([...html.matchAll(/>Newest child</g)].length, 2);
});
