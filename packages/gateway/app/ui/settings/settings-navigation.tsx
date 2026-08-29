import { css, type Handle } from "remix/ui";

import { routes } from "@/app/routes.ts";
import { Icon, type IconName } from "@/app/ui/components/icons.tsx";
import { media } from "@/app/ui/responsive.ts";

export type SettingsSection = "providers" | "secrets" | "github" | "git-author" | "runners";
export type SettingsModelProvider = { providerId: string; name: string; updatedAt: string };
export type SettingsModelProviderOption = { id: string; name: string };
export type SettingsSecret = { key: string; updatedAt: string };
export type SettingsGitHubCredential = { updatedAt: string };
export type SettingsGitAuthor = { authorEmail: string; authorName: string; updatedAt: string };
export type SettingsEnrollmentCommand = { command: string };
export type SettingsRunner = {
  id: string;
  name: string;
  architecture: "x64" | "arm64";
  status: "online" | "offline" | "revoked";
  capacity: SettingsRunnerCapacity | null;
};
export type SettingsRunnerCapacity = {
  maxConcurrentSessions?: number | undefined;
  activeSessions: number;
  vmCpuCount: number;
  vmMemoryMiB: number;
  diskFreeMiB: number;
};

const settingsLinks: readonly {
  href: string;
  icon: IconName;
  label: string;
  section: SettingsSection;
}[] = [
  {
    href: routes.app.settings.providers.index.href(),
    icon: "secrets",
    label: "Providers",
    section: "providers",
  },
  {
    href: routes.app.settings.secrets.index.href(),
    icon: "secrets",
    label: "Secrets",
    section: "secrets",
  },
  {
    href: routes.app.settings.github.index.href(),
    icon: "github",
    label: "GitHub",
    section: "github",
  },
  {
    href: routes.app.settings.gitAuthor.index.href(),
    icon: "user",
    label: "Git author",
    section: "git-author",
  },
  {
    href: routes.app.settings.runners.index.href(),
    icon: "server",
    label: "Runners",
    section: "runners",
  },
];

export function SettingsNavigation(handle: Handle<{ activeSection: SettingsSection }>) {
  return () => (
    <nav aria-label="Settings sections" mix={navigationStyle}>
      {settingsLinks.map((link) => {
        const active = link.section === handle.props.activeSection;
        return (
          <a
            key={link.section}
            href={link.href}
            aria-current={active ? "page" : undefined}
            data-state={active ? "active" : "inactive"}
            mix={navigationLinkStyle}
          >
            <Icon name={link.icon} size={14} />
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}

const navigationStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  flexShrink: 0,
  width: "100%",
  maxWidth: "100%",
  minHeight: "32px",
  padding: 0,
  overflowX: "auto",
  overflowY: "hidden",
  color: "var(--muted-foreground)",
  overscrollBehaviorX: "contain",
  overscrollBehaviorY: "none",
  scrollbarWidth: "none",
  touchAction: "pan-x",
  WebkitOverflowScrolling: "touch",
  "&::-webkit-scrollbar": { display: "none" },
  [media.md]: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: "4px",
    width: "192px",
    maxWidth: "192px",
    minHeight: 0,
    overflow: "visible",
    touchAction: "auto",
  },
});

const navigationLinkStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  gap: "6px",
  minHeight: "32px",
  padding: "6px 8px",
  color: "color-mix(in oklab, var(--foreground) 60%, transparent)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: "var(--radius-md)",
  outline: "none",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1,
  textDecoration: "none",
  "& svg": { width: "16px", height: "16px", flexShrink: 0, pointerEvents: "none" },
  "&[data-state='inactive']:hover": {
    color: "var(--foreground)",
    background: "var(--accent)",
  },
  "&[data-state='active']": {
    color: "var(--foreground)",
    background: "var(--muted)",
  },
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
  [media.md]: {
    justifyContent: "flex-start",
    width: "100%",
    minHeight: "40px",
    padding: "10px 12px",
  },
});
