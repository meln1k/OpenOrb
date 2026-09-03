import { css, type Handle } from "remix/ui";

import type { SessionCatalogEntry } from "@/app/data/session-catalog-repository.ts";
import { routes } from "@/app/routes.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Icon,
  type IconName,
} from "@/app/ui/components/index.ts";
import { media } from "@/app/ui/responsive.ts";
import { AppShell, type AppShellProps } from "@/app/ui/shell.tsx";

interface AppPageProps {
  composer: AppShellProps["composer"];
  csrfToken: string;
  setup?: {
    runner: boolean;
    runnerConfigured: boolean;
    provider: boolean;
    github: boolean;
    gitAuthor: boolean;
    project: boolean;
  };
  sidebarSessions: SessionCatalogEntry[];
  title?: string;
}

export function AppPage(handle: Handle<AppPageProps>) {
  const { composer, csrfToken, setup, sidebarSessions, title = "OpenOrb" } = handle.props;
  const showSetup = setup &&
    !(setup.runner && setup.provider && setup.github && setup.gitAuthor && setup.project);

  return () => (
    <AppShell
      composer={composer}
      csrfToken={csrfToken}
      sessions={sidebarSessions}
      title={title}
    >
      {showSetup
        ? (
          <div mix={mainStyle}>
            <section aria-labelledby="getting-started-heading" mix={setupStyle}>
              <header mix={setupHeadingStyle}>
                <h1 id="getting-started-heading" mix={headingStyle}>Get started</h1>
                <p mix={descriptionStyle}>
                  Complete these steps before starting your first session.
                </p>
              </header>
              <ol mix={stepsStyle}>
                <SetupStep
                  name="runner"
                  complete={setup.runner}
                  icon="server"
                  title="Connect a runner"
                  description="Connect a runner so OpenOrb can start and manage session VMs."
                  href={routes.app.settings.runners.index.href()}
                  action={setup.runnerConfigured ? undefined : "Connect runner"}
                />
                <SetupStep
                  name="provider"
                  complete={setup.provider}
                  icon="sparkles"
                  title="Add a LLM provider key"
                  description="Configure a model provider to choose the agent and model for a session."
                  href={routes.app.settings.providers.index.href()}
                  action="Configure provider"
                />
                <SetupStep
                  name="github"
                  complete={setup.github}
                  icon="github"
                  title="Configure GitHub credentials"
                  description="Add a GitHub token so OpenOrb can access your repositories."
                  href={routes.app.settings.github.index.href()}
                  action="Configure GitHub"
                />
                <SetupStep
                  name="git-author"
                  complete={setup.gitAuthor}
                  icon="user"
                  title="Set up Git username and email"
                  description="Set the author name and email used for commits."
                  href={routes.app.settings.gitAuthor.index.href()}
                  action="Set up Git author"
                />
                <SetupStep
                  name="project"
                  complete={setup.project}
                  icon="folder"
                  title="Configure projects"
                  description="Add a repository that sessions can work in."
                  href={routes.app.projects.index.href()}
                  action="Configure projects"
                />
              </ol>
            </section>
          </div>
        )
        : null}
    </AppShell>
  );
}

interface SetupStepProps {
  name: "runner" | "provider" | "github" | "git-author" | "project";
  complete: boolean;
  icon: IconName;
  title: string;
  description: string;
  href: string;
  action: string | undefined;
}

function SetupStep(handle: Handle<SetupStepProps>) {
  return () => {
    const props = handle.props;

    return (
      <li data-setup-step={props.name} data-status={props.complete ? "complete" : "pending"}>
        <Empty mix={stepStyle}>
          <EmptyHeader mix={stepHeaderStyle}>
            <EmptyMedia variant="icon" mix={props.complete && completeMediaStyle}>
              <Icon name={props.complete ? "account" : props.icon} size={20} />
            </EmptyMedia>
            <div mix={stepCopyStyle}>
              <EmptyTitle>{props.title}</EmptyTitle>
              <EmptyDescription>{props.description}</EmptyDescription>
            </div>
          </EmptyHeader>
          {props.complete || props.action
            ? (
              <EmptyContent mix={stepContentStyle}>
                {props.complete
                  ? <span mix={doneStyle}>Done</span>
                  : <a href={props.href} mix={actionStyle}>{props.action}</a>}
              </EmptyContent>
            )
            : null}
        </Empty>
      </li>
    );
  };
}

const mainStyle = css({
  display: "grid",
  flex: 1,
  placeItems: "center",
  padding: "32px 4px",
});

const setupStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "24px",
  width: "min(100%, 680px)",
});

const setupHeadingStyle = css({ textAlign: "center" });

const headingStyle = css({
  margin: 0,
  fontSize: "24px",
  fontWeight: 600,
  letterSpacing: "-0.02em",
});

const descriptionStyle = css({
  margin: "6px 0 0",
  color: "var(--muted-foreground)",
  fontSize: "14px",
});

const stepsStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  width: "100%",
  margin: 0,
  padding: 0,
  listStyle: "none",
});

const stepStyle = css({
  display: "grid",
  gridTemplateColumns: "1fr",
  alignItems: "center",
  justifyContent: "stretch",
  gap: "16px",
  minHeight: 0,
  padding: "20px",
  background: "color-mix(in oklab, var(--muted) 45%, transparent)",
  borderStyle: "none",
  textAlign: "left",
  [media.sm]: { gridTemplateColumns: "minmax(0, 1fr) auto" },
});

const stepHeaderStyle = css({
  display: "grid",
  gridTemplateColumns: "40px minmax(0, 1fr)",
  alignItems: "center",
  gap: "14px",
  width: "100%",
  maxWidth: "none",
  textAlign: "left",
});

const stepCopyStyle = css({ display: "grid", gap: "5px", minWidth: 0 });

const completeMediaStyle = css({
  color: "var(--primary-foreground)",
  background: "var(--primary)",
});

const stepContentStyle = css({
  alignItems: "flex-start",
  width: "auto",
  [media.sm]: { alignItems: "flex-end" },
});

const doneStyle = css({
  color: "var(--muted-foreground)",
  fontSize: "14px",
  fontWeight: 500,
});

const actionStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "36px",
  padding: "8px 16px",
  color: "var(--primary-foreground)",
  background: "var(--primary)",
  border: "1px solid transparent",
  borderRadius: "999px",
  outline: "none",
  fontSize: "14px",
  fontWeight: 500,
  textDecoration: "none",
  whiteSpace: "nowrap",
  transition: "background 150ms ease, border-color 150ms ease",
  "&:hover": { background: "color-mix(in oklab, var(--primary) 90%, transparent)" },
  "&:focus-visible": {
    borderColor: "color-mix(in oklab, var(--primary) 60%, var(--foreground))",
  },
});
