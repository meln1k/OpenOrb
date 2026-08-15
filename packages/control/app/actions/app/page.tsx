import type { Handle } from "remix/ui";

import { AppShell } from "@/app/ui/shell.tsx";

export interface DashboardPageProps {
  csrfToken: string;
}

export function DashboardPage(handle: Handle<DashboardPageProps>) {
  return () => (
    <AppShell
      csrfToken={handle.props.csrfToken}
      title="OpenOrb control"
      eyebrow="Overview"
      heading="Control panel"
      activeSection="overview"
    />
  );
}
