import type { Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { AppShell, type AppShellProps } from "@/app/ui/shell.tsx";

interface AppPageProps {
  composer: AppShellProps["composer"];
  csrfToken: string;
  sidebarSessions: SessionCatalogEntry[];
  title?: string;
}

export function AppPage(handle: Handle<AppPageProps>) {
  const { composer, csrfToken, sidebarSessions, title = "OpenOrb" } = handle.props;

  return () => (
    <AppShell
      composer={composer}
      csrfToken={csrfToken}
      sessions={sidebarSessions}
      title={title}
    />
  );
}
