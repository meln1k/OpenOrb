import { assert, assertEquals } from "@std/assert";
import { renderToString } from "remix/ui/server";

import { AppShellNavigation } from "@/app/ui/shell.tsx";

Deno.test("session navigation groups projects by recent activity", async () => {
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
    betaGroup !== -1 && betaGroup < betaSession && betaSession < alphaGroup &&
      alphaGroup < newestAlpha && newestAlpha < olderAlpha,
  );
  for (const sessionName of ["Only Beta session", "Newest Alpha session", "Older Alpha session"]) {
    assertEquals([...html.matchAll(new RegExp(`>${sessionName}<`, "g"))].length, 2);
  }
});
