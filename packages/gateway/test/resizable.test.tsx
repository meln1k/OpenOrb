import { assertStringIncludes } from "@std/assert";
import { renderToString } from "remix/ui/server";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/app/ui/components/index.ts";
import { AppShellLayout } from "@/app/ui/shell.tsx";

Deno.test("resizable components render the shadcn composition and sizing attributes", async () => {
  const html = await renderToString(
    <ResizablePanelGroup id="layout" orientation="vertical">
      <ResizablePanel
        id="sidebar"
        defaultSize="25%"
        minSize="10%"
        maxSize="40%"
      >
        Sidebar
      </ResizablePanel>
      <ResizableHandle id="divider" withHandle />
      <ResizablePanel id="content" defaultSize="75%">Content</ResizablePanel>
    </ResizablePanelGroup>,
  );

  assertStringIncludes(
    html,
    'id="layout" aria-orientation="vertical" data-orientation="vertical" data-slot="resizable-panel-group"',
  );
  assertStringIncludes(
    html,
    'id="sidebar" data-default-size="25%" data-max-size="40%" data-min-size="10%" data-slot="resizable-panel"',
  );
  assertStringIncludes(html, "flex-basis: 25%; flex-grow: 0;");
  assertStringIncludes(
    html,
    'id="divider" role="separator" data-slot="resizable-handle" tabindex="0"',
  );
  assertStringIncludes(html, 'aria-hidden="true" data-slot="resizable-handle-icon"');
});

Deno.test("disabled resizable handles are not keyboard focusable", async () => {
  const html = await renderToString(<ResizableHandle id="divider" disabled />);

  assertStringIncludes(
    html,
    'id="divider" role="separator" aria-disabled data-disabled data-slot="resizable-handle" tabindex="-1"',
  );
});

Deno.test("app shell composes both desktop sidebars as resizable panels", async () => {
  const html = await renderToString(
    <AppShellLayout
      composer={{
        projects: [],
        models: [],
        hasConfiguredRunner: false,
        hasConnectedRunner: false,
      }}
      csrfToken="csrf-token"
      sessions={[]}
      title="Resizable shell"
      rightSidebar={<section>Session changes</section>}
    >
      <section>Session content</section>
    </AppShellLayout>,
  );

  assertStringIncludes(html, 'data-slot="resizable-panel-group"');
  assertStringIncludes(html, 'aria-label="Resize primary navigation"');
  assertStringIncludes(html, 'aria-label="Resize session changes"');
  assertStringIncludes(
    html,
    'data-default-size="256px" data-max-size="480px" data-min-size="192px"',
  );
  assertStringIncludes(
    html,
    'data-default-size="clamp(400px, 38vw, 560px)" data-max-size="720px" data-min-size="320px"',
  );
});
