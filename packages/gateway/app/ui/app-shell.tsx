import type { Handle } from "remix/component";

import { AppShellLayout, type AppShellLayoutProps } from "@/app/ui/public/shell.tsx";
import { Document } from "@/app/ui/document.tsx";

export type AppShellProps = AppShellLayoutProps;

export function AppShell(handle: Handle<AppShellProps>) {
  return () => (
    <Document title={handle.props.title}>
      <AppShellLayout {...handle.props} />
    </Document>
  );
}
