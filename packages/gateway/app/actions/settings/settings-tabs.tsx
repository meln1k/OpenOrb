import { clientEntry, css, type Handle } from "remix/ui";
import {
  Tab as TabsTrigger,
  TabList as TabsList,
  TabPanel as TabsContent,
  Tabs,
} from "remix/ui/tabs";
import { Icon } from "@/app/ui/components/icons.tsx";
import { GitAuthorSection } from "./git-author.tsx";
import { GitHubCredentialSection } from "./github-credential.tsx";
import { ProviderSecrets } from "./provider-secrets.tsx";
import { RunnersSection } from "./runners.tsx";

const SETTINGS_TABS = ["secrets", "github", "git-author", "runners"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
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
  maxConcurrentSessions?: number;
  activeSessions: number;
  vmCpuCount: number;
  vmMemoryMiB: number;
  diskFreeMiB: number;
};
export type SettingsTabHrefs = Record<SettingsTab, string>;
export type SettingsTabsProps = {
  activeTab: SettingsTab;
  csrfToken: string;
  enrollmentCommand: SettingsEnrollmentCommand;
  error?: string;
  gitAuthor: SettingsGitAuthor | null;
  githubCredential: SettingsGitHubCredential | null;
  hrefs: SettingsTabHrefs;
  runners: SettingsRunner[];
  secrets: SettingsSecret[];
};

export const SettingsTabs = clientEntry<SettingsTabsProps>(
  import.meta.url,
  function SettingsTabs(handle: Handle<SettingsTabsProps>) {
    let activeTab = handle.props.activeTab;
    let authorEmail = handle.props.gitAuthor?.authorEmail ?? "";
    let authorName = handle.props.gitAuthor?.authorName ?? "";
    const addSecretDialogId = `${handle.id}-add-secret`;
    const githubDialogId = `${handle.id}-github-token`;
    const deleteGithubDialogId = `${handle.id}-delete-github-token`;
    const gitAuthorFormId = `${handle.id}-git-author-form`;
    const captureGitAuthorDraft = () => {
      const form = globalThis.document.getElementById(gitAuthorFormId);
      if (!(form instanceof HTMLFormElement)) return;
      const formData = new FormData(form);
      authorName = formData.get("authorName")?.toString() ?? "";
      authorEmail = formData.get("authorEmail")?.toString() ?? "";
    };
    handle.queueTask(() => {
      const onPopState = () => {
        const nextTab = tabForCurrentUrl();
        if (nextTab === activeTab) return;
        captureGitAuthorDraft();
        activeTab = nextTab;
        void handle.update();
      };
      globalThis.addEventListener("popstate", onPopState);
      handle.signal.addEventListener(
        "abort",
        () => globalThis.removeEventListener("popstate", onPopState),
        { once: true },
      );
    });
    return () => {
      const {
        csrfToken,
        enrollmentCommand,
        error,
        gitAuthor,
        githubCredential,
        hrefs,
        runners,
        secrets,
      } = handle.props;
      return (
        <Tabs
          activeTab={activeTab}
          data-slot="tabs"
          mix={tabsRootStyle}
          onActiveTabChange={(nextTab) => {
            const selectedTab = SETTINGS_TABS.find((tab) => tab === nextTab);
            if (!selectedTab) return;
            captureGitAuthorDraft();
            activeTab = selectedTab;
            const href = hrefs[activeTab];
            if (href) {
              globalThis.history.pushState(null, "", href);
            }
            void handle.update();
          }}
        >
          <TabsList
            aria-label="Settings sections"
            data-slot="tabs-list"
            data-variant="default"
            mix={tabsListStyle}
          >
            <TabsTrigger
              name="secrets"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="secrets" size={14} />Secrets
            </TabsTrigger>
            <TabsTrigger
              name="github"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="github" size={14} />GitHub
            </TabsTrigger>
            <TabsTrigger
              name="git-author"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="user" size={14} />Git author
            </TabsTrigger>
            <TabsTrigger
              name="runners"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="server" size={14} />Runners
            </TabsTrigger>
          </TabsList>
          {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
          <TabsContent name="secrets" data-slot="tabs-content" mix={tabsPanelStyle}>
            <ProviderSecrets
              actionHref={hrefs.secrets}
              csrfToken={csrfToken}
              dialogId={addSecretDialogId}
              secrets={secrets}
            />
          </TabsContent>
          <TabsContent name="github" data-slot="tabs-content" mix={tabsPanelStyle}>
            <GitHubCredentialSection
              actionHref={hrefs.github}
              csrfToken={csrfToken}
              credential={githubCredential}
              dialogId={githubDialogId}
              deleteDialogId={deleteGithubDialogId}
            />
          </TabsContent>
          <TabsContent name="git-author" data-slot="tabs-content" mix={tabsPanelStyle}>
            <GitAuthorSection
              actionHref={hrefs["git-author"]}
              authorEmail={authorEmail}
              authorName={authorName}
              csrfToken={csrfToken}
              formId={gitAuthorFormId}
              gitAuthor={gitAuthor}
            />
          </TabsContent>
          <TabsContent name="runners" data-slot="tabs-content" mix={tabsPanelStyle}>
            <RunnersSection
              actionHref={hrefs.runners}
              csrfToken={csrfToken}
              enrollmentCommand={enrollmentCommand}
              runners={runners}
            />
          </TabsContent>
        </Tabs>
      );
    };
  },
);
function tabForCurrentUrl(): SettingsTab {
  const currentUrl = new URL(globalThis.location.href);
  const requestedTab = currentUrl.searchParams.get("tab");
  return SETTINGS_TABS.find((tab) => tab === requestedTab) ?? "secrets";
}
const tabsRootStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  minWidth: 0,
  width: "100%",
  padding: "24px",
});
const tabsListStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "flex-start",
  flexShrink: 0,
  width: "100%",
  maxWidth: "100%",
  minHeight: "32px",
  padding: "3px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  border: 0,
  borderRadius: "var(--radius-lg)",
  boxShadow: "none",
  overflowX: "auto",
  overflowY: "hidden",
  overscrollBehaviorX: "contain",
  overscrollBehaviorY: "none",
  touchAction: "pan-x",
  userSelect: "none",
  WebkitOverflowScrolling: "touch",
  scrollbarWidth: "none",
  "&::-webkit-scrollbar": { display: "none" },
});
const tabsTriggerStyle = css({
  flex: "0 0 auto",
  gap: "6px",
  minHeight: "25px",
  padding: "2px 6px",
  color: "color-mix(in oklab, var(--foreground) 60%, transparent)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: "var(--radius-md)",
  boxShadow: "none",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1,
  textShadow: "none",
  WebkitUserDrag: "none",
  "& svg": { width: "16px", height: "16px", flexShrink: 0, pointerEvents: "none" },
  "&[data-state='inactive']:hover:not(:disabled):not([aria-disabled='true'])": {
    color: "var(--foreground)",
    background: "transparent",
  },
  "&[data-state='inactive']:active:not(:disabled):not([aria-disabled='true'])": {
    background: "transparent",
  },
  "&[data-state='active']": {
    "--rmx-tabs-tab-shadow": "none",
    color: "var(--foreground)",
    background: "var(--background)",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.08)",
    textShadow: "none",
  },
  "&[data-state='active']:hover:not(:disabled):not([aria-disabled='true'])": {
    background: "var(--background)",
  },
  "&[data-state='active']:active:not(:disabled):not([aria-disabled='true'])": {
    background: "var(--background)",
  },
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
});
const tabsPanelStyle = css({
  flex: "1",
  minWidth: 0,
  color: "inherit",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  lineHeight: "inherit",
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
