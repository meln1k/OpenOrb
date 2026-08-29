import { css, type Handle, type RemixNode } from "remix/ui";

import type {
  GitAuthorConfiguration,
  GitCredential,
} from "@/app/data/git-configuration-repository.ts";
import type { ModelProviderCredential } from "@/app/data/model-provider-repository.ts";
import type { RunnerEnrollmentToken } from "@/app/data/runner-repository.ts";
import type { SecretEntry } from "@/app/data/secret-repository.ts";
import type { ModelProviderOption } from "@/app/model-provider-catalog.ts";
import { routes } from "@/app/routes.ts";
import { Icon } from "@/app/ui/components/icons.tsx";
import { designSystemStyle } from "@/app/ui/components/theme.ts";
import { Document } from "@/app/ui/document.tsx";
import { media } from "@/app/ui/responsive.ts";
import { GenericSecrets } from "@/app/ui/settings/generic-secrets.tsx";
import { GitAuthorSection } from "@/app/ui/settings/git-author.tsx";
import { GitHubCredentialSection } from "@/app/ui/settings/github-credential.tsx";
import { ModelProviders } from "@/app/ui/settings/model-providers.tsx";
import { RunnersSection } from "@/app/ui/settings/runners.tsx";
import {
  SettingsNavigation,
  type SettingsRunner,
  type SettingsSection,
} from "@/app/ui/settings/settings-navigation.tsx";

export type { SettingsRunner };

interface SettingsLayoutProps {
  activeSection: SettingsSection;
  children?: RemixNode;
  error: string | undefined;
}

export function ProvidersSettingsPage(
  handle: Handle<{
    csrfToken: string;
    error: string | undefined;
    providerOptions: readonly ModelProviderOption[];
    providers: Pick<ModelProviderCredential, "providerId" | "updatedAt">[];
  }>,
) {
  const dialogId = `${handle.id}-add-provider`;
  return () => (
    <SettingsLayout activeSection="providers" error={handle.props.error}>
      <ModelProviders
        actionHref={routes.app.settings.providers.action.href()}
        csrfToken={handle.props.csrfToken}
        dialogId={dialogId}
        providerOptions={[...handle.props.providerOptions]}
        providers={handle.props.providers.map((provider) => ({
          providerId: provider.providerId,
          name: handle.props.providerOptions.find((option) => option.id === provider.providerId)
            ?.name ?? provider.providerId,
          updatedAt: provider.updatedAt,
        }))}
      />
    </SettingsLayout>
  );
}

export function SecretsSettingsPage(
  handle: Handle<{
    csrfToken: string;
    error: string | undefined;
    secrets: SecretEntry[];
  }>,
) {
  const dialogId = `${handle.id}-add-secret`;
  return () => (
    <SettingsLayout activeSection="secrets" error={handle.props.error}>
      <GenericSecrets
        actionHref={routes.app.settings.secrets.action.href()}
        csrfToken={handle.props.csrfToken}
        dialogId={dialogId}
        secrets={handle.props.secrets.map((secret) => ({
          key: secret.key,
          updatedAt: secret.updatedAt,
        }))}
      />
    </SettingsLayout>
  );
}

export function GitHubSettingsPage(
  handle: Handle<{
    csrfToken: string;
    credential: GitCredential | null;
    error: string | undefined;
  }>,
) {
  const dialogId = `${handle.id}-github-token`;
  const deleteDialogId = `${handle.id}-delete-github-token`;
  return () => (
    <SettingsLayout activeSection="github" error={handle.props.error}>
      <GitHubCredentialSection
        actionHref={routes.app.settings.github.action.href()}
        csrfToken={handle.props.csrfToken}
        credential={handle.props.credential
          ? { updatedAt: handle.props.credential.updatedAt }
          : null}
        dialogId={dialogId}
        deleteDialogId={deleteDialogId}
      />
    </SettingsLayout>
  );
}

export function GitAuthorSettingsPage(
  handle: Handle<{
    csrfToken: string;
    error: string | undefined;
    gitAuthor: GitAuthorConfiguration | null;
  }>,
) {
  const formId = `${handle.id}-git-author-form`;
  return () => (
    <SettingsLayout activeSection="git-author" error={handle.props.error}>
      <GitAuthorSection
        actionHref={routes.app.settings.gitAuthor.action.href()}
        authorEmail={handle.props.gitAuthor?.authorEmail ?? ""}
        authorName={handle.props.gitAuthor?.authorName ?? ""}
        csrfToken={handle.props.csrfToken}
        formId={formId}
        gitAuthor={handle.props.gitAuthor
          ? {
            authorEmail: handle.props.gitAuthor.authorEmail,
            authorName: handle.props.gitAuthor.authorName,
            updatedAt: handle.props.gitAuthor.updatedAt,
          }
          : null}
      />
    </SettingsLayout>
  );
}

export function RunnersSettingsPage(
  handle: Handle<{
    csrfToken: string;
    enrollmentToken: RunnerEnrollmentToken;
    error: string | undefined;
    gatewayUrl: string;
    runners: SettingsRunner[];
  }>,
) {
  return () => (
    <SettingsLayout activeSection="runners" error={handle.props.error}>
      <RunnersSection
        actionHref={routes.app.settings.runners.action.href()}
        csrfToken={handle.props.csrfToken}
        enrollmentCommand={{
          command: runnerEnrollmentCommand(
            handle.props.gatewayUrl,
            handle.props.enrollmentToken.token,
          ),
        }}
        runners={handle.props.runners}
      />
    </SettingsLayout>
  );
}

function SettingsLayout(handle: Handle<SettingsLayoutProps>) {
  return () => (
    <Document title="Settings">
      <div mix={[designSystemStyle, settingsPageStyle]}>
        <main aria-label="Settings" mix={settingsDialogStyle}>
          <header mix={dialogHeaderStyle}>
            <div mix={dialogTitleStyle}>
              <h1 mix={pageHeadingStyle}>Settings</h1>
              <p mix={pageCopyStyle}>Manage gateway configuration and secrets.</p>
            </div>
            <a
              href={routes.app.index.href()}
              aria-label="Close settings"
              mix={closeButtonStyle}
            >
              <Icon name="x" size={18} />
            </a>
          </header>
          <div mix={settingsContentStyle}>
            <SettingsNavigation activeSection={handle.props.activeSection} />
            <div mix={settingsMainStyle}>
              {handle.props.error
                ? <p role="alert" mix={errorStyle}>{handle.props.error}</p>
                : null}
              <div mix={settingsSectionStyle}>{handle.props.children}</div>
            </div>
          </div>
        </main>
      </div>
    </Document>
  );
}

function runnerEnrollmentCommand(gatewayUrl: string, enrollmentToken: string): string {
  return [
    "deno task dev:runner \\",
    `  --gateway ${gatewayUrl} \\`,
    `  --enrollment-token ${enrollmentToken}`,
  ].join("\n");
}

const settingsPageStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  height: "100svh",
  padding: "16px",
  overflow: "hidden",
  color: "var(--foreground)",
  background: "var(--muted)",
  fontFamily: "var(--font-sans)",
  [media.md]: { padding: "32px" },
});
const settingsDialogStyle = css({
  display: "flex",
  flexDirection: "column",
  width: "min(1120px, 100%)",
  height: "calc(100svh - 32px)",
  minWidth: 0,
  minHeight: 0,
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 24px 80px rgb(0 0 0 / 0.18)",
  [media.md]: { height: "calc(100svh - 64px)" },
});
const dialogHeaderStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  flexShrink: 0,
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
const settingsContentStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  flex: "1",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  padding: "24px",
  overflow: "hidden",
  [media.md]: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "24px",
  },
});
const settingsMainStyle = css({
  display: "flex",
  flex: "1",
  flexDirection: "column",
  gap: "8px",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
});
const settingsSectionStyle = css({
  flex: "1",
  minWidth: 0,
  color: "inherit",
  fontSize: "14px",
});
const errorStyle = css({
  margin: 0,
  padding: "12px 14px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 8%, var(--background))",
  border: "1px solid color-mix(in oklab, var(--destructive) 30%, var(--border))",
  borderRadius: "var(--radius-md)",
  fontSize: "14px",
});
