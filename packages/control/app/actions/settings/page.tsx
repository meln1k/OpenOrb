import { css, type Handle } from "remix/ui";

import type {
  GitAuthorConfiguration,
  GitCredential,
} from "@/app/data/git-configuration-repository.ts";
import type { RunnerEnrollmentToken } from "@/app/data/runner-repository.ts";
import type { SecretEntry } from "@/app/data/secret-repository.ts";
import { routes } from "@/app/routes.ts";
import { Icon } from "@/app/ui/components/icons.tsx";
import {
  type SettingsRunner,
  type SettingsTab,
  SettingsTabs,
} from "@/app/ui/components/settings-tabs.tsx";
import { designSystemStyle } from "@/app/ui/components/theme.ts";
import { Document } from "@/app/ui/document.tsx";
import { media } from "@/app/ui/responsive.ts";

export type { SettingsRunner, SettingsTab };

export function settingsTabHref(tab: SettingsTab): string {
  return `${routes.app.settings.index.href()}?tab=${tab}#${tab}`;
}

export interface SettingsPageProps {
  activeTab: SettingsTab;
  controlPanelUrl: string;
  csrfToken: string;
  enrollmentToken: RunnerEnrollmentToken;
  error?: string;
  gitAuthor: GitAuthorConfiguration | null;
  githubCredential: GitCredential | null;
  runners: SettingsRunner[];
  secrets: SecretEntry[];
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  const {
    activeTab,
    controlPanelUrl,
    csrfToken,
    enrollmentToken,
    error,
    gitAuthor,
    githubCredential,
    runners,
    secrets,
  } = handle.props;

  return () => (
    <Document title="Settings">
      <div mix={[designSystemStyle, settingsPageStyle]}>
        <main aria-label="Settings" mix={settingsDialogStyle}>
          <header mix={dialogHeaderStyle}>
            <div mix={dialogTitleStyle}>
              <h1 mix={pageHeadingStyle}>Settings</h1>
              <p mix={pageCopyStyle}>Manage control-panel configuration and secrets.</p>
            </div>
            <a href={routes.app.index.href()} aria-label="Close settings" mix={closeButtonStyle}>
              <Icon name="x" size={18} />
            </a>
          </header>
          <SettingsTabs
            activeTab={activeTab}
            csrfToken={csrfToken}
            enrollmentCommand={{
              command: runnerEnrollmentCommand(controlPanelUrl, enrollmentToken.token),
            }}
            error={error}
            gitAuthor={gitAuthor
              ? {
                authorEmail: gitAuthor.authorEmail,
                authorName: gitAuthor.authorName,
                updatedAt: gitAuthor.updatedAt,
              }
              : null}
            githubCredential={githubCredential ? { updatedAt: githubCredential.updatedAt } : null}
            runners={runners}
            hrefs={{
              secrets: settingsTabHref("secrets"),
              github: settingsTabHref("github"),
              "git-author": settingsTabHref("git-author"),
              runners: settingsTabHref("runners"),
            }}
            secrets={secrets.map((secret) => ({
              key: secret.key,
              updatedAt: secret.updatedAt,
            }))}
          />
        </main>
      </div>
    </Document>
  );
}

function runnerEnrollmentCommand(controlPanelUrl: string, enrollmentToken: string): string {
  return [
    "deno task dev:runner \\",
    `  --control-panel ${controlPanelUrl} \\`,
    `  --enrollment-token ${enrollmentToken}`,
  ].join("\n");
}

const settingsPageStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  minHeight: "100svh",
  padding: "16px",
  color: "var(--foreground)",
  background: "var(--muted)",
  fontFamily: "var(--font-sans)",
  [media.md]: { padding: "32px" },
});
const settingsDialogStyle = css({
  display: "flex",
  flexDirection: "column",
  width: "min(1120px, 100%)",
  minWidth: 0,
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 24px 80px rgb(0 0 0 / 0.18)",
});
const dialogHeaderStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "24px",
  minWidth: 0,
  padding: "24px",
  borderBottom: "1px solid var(--border)",
});
const dialogTitleStyle = css({ display: "grid", gap: "6px", minWidth: 0 });
const pageHeadingStyle = css({
  margin: 0,
  fontSize: "24px",
  fontWeight: 650,
  letterSpacing: "-0.03em",
  lineHeight: 1.15,
});
const pageCopyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});
const closeButtonStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: "36px",
  height: "36px",
  color: "var(--muted-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  textDecoration: "none",
  "&:hover": { color: "var(--foreground)", background: "var(--accent)" },
  "&:focus-visible": {
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
});
