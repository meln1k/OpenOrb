import { clientEntry, css, type Handle, navigate, type RemixNode } from "remix/ui";

import type { SessionNavigationEntry } from "@/app/data/session-catalog-repository.ts";
import { routes } from "@/app/routes.ts";
import {
  Avatar,
  AvatarFallback,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  designSystemStyle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLink,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Separator,
  SidebarContent,
  SidebarDesktop,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMobile,
  SidebarTrigger,
  Spinner,
} from "@/app/ui/components/index.ts";
import { media } from "@/app/ui/responsive.ts";
import { SessionComposer, type SessionComposerProps } from "@/app/ui/session-composer.tsx";

export type AppShellLayoutProps = {
  activeSection?: "projects";
  activeSessionId?: string;
  children?: RemixNode;
  composer: Omit<SessionComposerProps, "csrfToken" | "dialogId">;
  copy?: string;
  csrfToken: string;
  eyebrow?: string;
  heading?: string;
  rightSidebar?: RemixNode;
  sessions: SessionNavigationEntry[];
  title: string;
  topBarAccessory?: RemixNode;
  topBarTitle?: string;
  workspace?: RemixNode;
};

const MOBILE_SIDEBAR_ID = "openorb-mobile-sidebar";
const NEW_SESSION_DIALOG_ID = "openorb-new-session";
export const SESSION_WORKSPACE_FRAME = "session-workspace";

export function AppShellLayout(handle: Handle<AppShellLayoutProps>) {
  return () => (
    <AppShellNavigation
      activeSection={handle.props.activeSection}
      activeSessionId={handle.props.activeSessionId}
      composer={
        <SessionComposer
          {...handle.props.composer}
          csrfToken={handle.props.csrfToken}
          dialogId={NEW_SESSION_DIALOG_ID}
        />
      }
      csrfToken={handle.props.csrfToken}
      sessions={handle.props.sessions}
      workspace={handle.props.workspace ?? <AppWorkspaceLayout {...handle.props} />}
    />
  );
}

type SessionProjectGroup = {
  projectId: string;
  projectName: string;
  sessions: SessionNavigationEntry[];
};

type AppShellNavigationProps = {
  activeSection: "projects" | undefined;
  activeSessionId: string | undefined;
  composer: RemixNode;
  csrfToken: string;
  sessions: SessionNavigationEntry[];
  workspace: RemixNode;
};

export function AppShellNavigation(handle: Handle<AppShellNavigationProps>) {
  return () => (
    <SidebarLayout mix={[designSystemStyle, appThemeAliasesStyle]}>
      <AppShellNavigationBehavior
        activeSessionId={handle.props.activeSessionId}
        sessions={handle.props.sessions}
      />
      <SidebarMobile id={MOBILE_SIDEBAR_ID}>
        <AppNavigation
          csrfToken={handle.props.csrfToken}
          activeSection={handle.props.activeSection}
          selectedSessionId={handle.props.activeSessionId}
          pendingSessionId={undefined}
          sessions={handle.props.sessions}
        />
      </SidebarMobile>
      <ResizablePanelGroup orientation="horizontal" mix={shellPanelGroupStyle}>
        <ResizablePanel
          data-side="left"
          defaultSize="256px"
          minSize="192px"
          maxSize="480px"
          mix={desktopSidebarPanelStyle}
        >
          <SidebarDesktop>
            <AppNavigation
              csrfToken={handle.props.csrfToken}
              activeSection={handle.props.activeSection}
              selectedSessionId={handle.props.activeSessionId}
              pendingSessionId={undefined}
              sessions={handle.props.sessions}
            />
          </SidebarDesktop>
        </ResizablePanel>
        {handle.props.workspace}
      </ResizablePanelGroup>
      {handle.props.composer}
    </SidebarLayout>
  );
}

export const AppShellNavigationBehavior = clientEntry<
  Pick<AppShellNavigationProps, "activeSessionId" | "sessions">
>(
  import.meta.url,
  function AppShellNavigationBehavior(handle) {
    let selectedSessionId = handle.props.activeSessionId;
    let navigationGeneration = 0;
    let activeSessionNavigation: { generation: number; sessionId: string } | undefined;
    let restoring = false;

    function sessionForUrl(url: string) {
      const destination = new URL(url);
      return handle.props.sessions.find((session) => {
        const href = new URL(
          routes.app.sessions.detail.href({ sessionId: session.id }),
          destination,
        );
        return href.pathname === destination.pathname && href.search === destination.search;
      });
    }

    function updateSessionButtons(pendingSessionId?: string) {
      for (
        const button of document.querySelectorAll<HTMLAnchorElement>(
          `[data-rmx-target="${SESSION_WORKSPACE_FRAME}"]`,
        )
      ) {
        const session = sessionForUrl(button.href);
        if (!session) continue;
        const active = session.id === (pendingSessionId ?? selectedSessionId);
        const pending = session.id === pendingSessionId;
        button.setAttribute("data-active", String(active));
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
        if (pending) {
          button.setAttribute("data-pending", "true");
          button.setAttribute("aria-busy", "true");
        } else {
          button.removeAttribute("data-pending");
          button.removeAttribute("aria-busy");
        }
        button.querySelector<HTMLElement>(`[data-slot="spinner"]`)?.toggleAttribute(
          "hidden",
          !pending,
        );
      }
    }

    function replaceWorkspace(content: RemixNode) {
      const frame = handle.frames.get(SESSION_WORKSPACE_FRAME);
      if (frame) void frame.replace(content);
    }

    function updateCurrentEntry(session: SessionNavigationEntry) {
      globalThis.navigation.updateCurrentEntry({
        state: {
          target: SESSION_WORKSPACE_FRAME,
          src: routes.app.sessions.frame.href({ sessionId: session.id }),
          resetScroll: true,
          $rmx: true,
        },
      });
    }

    handle.queueTask(() => {
      if (!("navigation" in globalThis)) return;
      const navigation = globalThis.navigation;

      navigation.addEventListener("navigate", (event) => {
        const generation = ++navigationGeneration;
        const session = sessionForUrl(event.destination.url);
        if (!session || !handle.frames.get(SESSION_WORKSPACE_FRAME)) {
          activeSessionNavigation = undefined;
          restoring = false;
          updateSessionButtons();
          return;
        }

        if (restoring && session.id !== selectedSessionId) restoring = false;
        activeSessionNavigation = { generation, sessionId: session.id };
        const mobileSidebar = document.getElementById(MOBILE_SIDEBAR_ID);
        if (mobileSidebar?.matches(":popover-open")) mobileSidebar.hidePopover();
        updateSessionButtons(session.id);
        replaceWorkspace(<SessionWorkspaceLoading title={sessionName(session)} />);
      }, { signal: handle.signal });
      navigation.addEventListener("navigatesuccess", () => {
        const completed = activeSessionNavigation;
        if (!completed || completed.generation !== navigationGeneration) return;
        activeSessionNavigation = undefined;
        selectedSessionId = completed.sessionId;
        restoring = false;
        updateSessionButtons();
      }, { signal: handle.signal });
      navigation.addEventListener("navigateerror", () => {
        const failed = activeSessionNavigation;
        if (!failed) return;

        // The failed transition remains exposed during navigateerror dispatch. Defer recovery and
        // use the generation to ignore failures superseded by any later navigation.
        setTimeout(() => {
          if (
            handle.signal.aborted ||
            navigationGeneration !== failed.generation ||
            activeSessionNavigation?.generation !== failed.generation
          ) return;

          activeSessionNavigation = undefined;
          const committed = handle.props.sessions.find((session) =>
            session.id === selectedSessionId
          );
          if (!committed || restoring) {
            restoring = false;
            updateSessionButtons();
            replaceWorkspace(<SessionWorkspaceLoadError />);
            return;
          }

          restoring = true;
          updateSessionButtons(committed.id);
          void navigate(routes.app.sessions.detail.href({ sessionId: committed.id }), {
            history: "replace",
            target: SESSION_WORKSPACE_FRAME,
            src: routes.app.sessions.frame.href({ sessionId: committed.id }),
          }).catch(() => {
            // The navigateerror listener owns the bounded recovery UI. Consume the matching promise
            // rejection so the same handled navigation failure is not reported as unhandled.
          });
        }, 0);
      }, { signal: handle.signal });
    });

    return () => {
      const activeSessionId = handle.props.activeSessionId;
      handle.queueTask((signal) => {
        if (signal.aborted || activeSessionNavigation) return;
        const activeSession = handle.props.sessions.find((session) =>
          session.id === activeSessionId
        );
        if (!activeSession || sessionForUrl(globalThis.location.href)?.id !== activeSession.id) {
          return;
        }

        selectedSessionId = activeSession.id;
        restoring = false;
        updateSessionButtons();
        updateCurrentEntry(activeSession);
      });
      return null;
    };
  },
);

export interface AppWorkspaceLayoutProps {
  children?: RemixNode;
  copy?: string;
  eyebrow?: string;
  heading?: string;
  rightSidebar?: RemixNode;
  topBarAccessory?: RemixNode;
  topBarTitle?: string;
}

export function AppWorkspaceLayout(handle: Handle<AppWorkspaceLayoutProps>) {
  return () => (
    <>
      <ResizableHandle
        aria-label="Resize primary navigation"
        data-side="left"
        withHandle
        mix={desktopSidebarHandleStyle}
      />
      <ResizablePanel minSize="360px" mix={shellContentPanelStyle}>
        <SidebarInset
          aria-label="Authenticated gateway"
          data-has-right-sidebar={handle.props.rightSidebar ? "true" : undefined}
        >
          <header mix={topBarStyle}>
            <div mix={topBarContentStyle}>
              <SidebarTrigger target={MOBILE_SIDEBAR_ID} />
              {handle.props.topBarTitle
                ? (
                  <>
                    <Separator orientation="vertical" mix={topBarSeparatorStyle} />
                    <h1 data-top-bar-title mix={topBarTitleStyle}>
                      {handle.props.topBarTitle}
                    </h1>
                  </>
                )
                : handle.props.eyebrow
                ? (
                  <>
                    <Separator orientation="vertical" mix={topBarSeparatorStyle} />
                    <Breadcrumb>
                      <BreadcrumbList>
                        <BreadcrumbItem mix={desktopBreadcrumbItemStyle}>
                          <BreadcrumbLink href={routes.app.index.href()}>
                            Gateway
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator mix={desktopBreadcrumbSeparatorStyle} />
                        <BreadcrumbItem>
                          <BreadcrumbPage>{handle.props.eyebrow}</BreadcrumbPage>
                        </BreadcrumbItem>
                      </BreadcrumbList>
                    </Breadcrumb>
                  </>
                )
                : null}
              {handle.props.topBarAccessory}
            </div>
          </header>
          <div mix={contentStyle}>
            {handle.props.heading
              ? (
                <header mix={pageHeaderStyle}>
                  <h1 mix={pageHeadingStyle}>{handle.props.heading}</h1>
                  {handle.props.copy ? <p mix={pageCopyStyle}>{handle.props.copy}</p> : null}
                </header>
              )
              : null}
            {handle.props.children}
          </div>
        </SidebarInset>
      </ResizablePanel>
      {handle.props.rightSidebar
        ? (
          <>
            <ResizableHandle
              aria-label="Resize session changes"
              data-side="right"
              withHandle
              mix={desktopSidebarHandleStyle}
            />
            <ResizablePanel
              data-side="right"
              defaultSize="clamp(400px, 38vw, 560px)"
              minSize="320px"
              maxSize="720px"
              mix={desktopSidebarPanelStyle}
            >
              <SidebarDesktop side="right">{handle.props.rightSidebar}</SidebarDesktop>
            </ResizablePanel>
          </>
        )
        : null}
    </>
  );
}

type AppNavigationProps = {
  csrfToken: string;
  activeSection: AppShellLayoutProps["activeSection"];
  selectedSessionId: string | undefined;
  pendingSessionId: string | undefined;
  sessions: SessionNavigationEntry[];
};

function AppNavigation(handle: Handle<AppNavigationProps>) {
  return () => (
    <>
      <SidebarHeader>
        <a
          href={routes.app.index.href()}
          aria-label="OpenOrb gateway"
          mix={sidebarBrandStyle}
        >
          <span mix={sidebarBrandMarkStyle}>
            <img src="/favicon.svg" alt="" width="20" height="20" />
          </span>
          <span mix={sidebarBrandTextStyle}>
            <strong>OpenOrb</strong>
          </span>
        </a>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              commandFor={NEW_SESSION_DIALOG_ID}
              command="show-modal"
              icon={<Icon name="plus" />}
            >
              New session
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup aria-label="Session history">
          {renderSessionProjectGroups(handle.props)}
          {handle.props.sessions.length === 0
            ? <p mix={emptySessionsStyle}>No sessions yet.</p>
            : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              href={routes.app.projects.index.href()}
              active={handle.props.activeSection === "projects"}
              icon={<Icon name="folder" />}
            >
              Projects
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <DropdownMenu>
          <DropdownMenuTrigger mix={sidebarAccountTriggerStyle}>
            <Avatar>
              <AvatarFallback>OA</AvatarFallback>
            </Avatar>
            <span mix={sidebarAccountTextStyle}>
              <strong>Administrator</strong>
            </span>
            <Icon name="chevrons-up-down" />
          </DropdownMenuTrigger>
          <DropdownMenuContent mix={accountMenuContentStyle}>
            <DropdownMenuLabel>
              <div mix={accountMenuIdentityStyle}>
                <Avatar>
                  <AvatarFallback>OA</AvatarFallback>
                </Avatar>
                <span mix={accountMenuTextStyle}>
                  <strong>Administrator</strong>
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLink href={routes.app.settings.providers.index.href()}>
              <Icon name="settings" />
              Settings
            </DropdownMenuLink>
            <DropdownMenuSeparator />
            <form method="post" action={routes.auth.logout.href()}>
              <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
              <DropdownMenuItem type="submit">
                <Icon name="logout" />
                Log out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </>
  );
}

export function SessionWorkspaceLoading(handle: Handle<{ title: string }>) {
  return () => (
    <AppWorkspaceLayout topBarTitle={handle.props.title}>
      <div role="status" mix={sessionLoadingStyle}>
        <Spinner aria-hidden="true" />
        Loading session…
      </div>
    </AppWorkspaceLayout>
  );
}

export function SessionWorkspaceLoadError(
  handle: Handle<{ message?: string; title?: string }>,
) {
  return () => (
    <AppWorkspaceLayout topBarTitle={handle.props.title ?? "Session unavailable"}>
      <div role="alert" mix={sessionLoadingStyle}>
        {handle.props.message ??
          "The previous session could not be restored. Reload the page to try again."}
      </div>
    </AppWorkspaceLayout>
  );
}

function sessionName(session: SessionNavigationEntry): string {
  return session.initialPromptPreview || "Untitled session";
}

function renderSessionProjectGroups(props: AppNavigationProps): RemixNode {
  return groupSessionsByProject(props.sessions).map(({ projectId, projectName, sessions }) => (
    <section
      key={projectId}
      aria-label={`${projectName} sessions`}
      data-session-project={projectId}
      mix={sessionProjectStyle}
    >
      <h2 mix={sessionProjectHeadingStyle}>
        <Icon name="folder" />
        <span>{projectName}</span>
        <span aria-hidden="true" mix={sessionProjectRuleStyle} />
      </h2>
      <SidebarMenu>
        {sessions.map((session) => (
          <SidebarMenuItem key={session.id}>
            <SidebarMenuButton
              href={routes.app.sessions.detail.href({ sessionId: session.id })}
              navigation={{
                target: SESSION_WORKSPACE_FRAME,
                src: routes.app.sessions.frame.href({ sessionId: session.id }),
              }}
              active={props.selectedSessionId === session.id}
              pending={props.pendingSessionId === session.id}
              icon={<Icon name="message" />}
            >
              {sessionName(session)}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </section>
  ));
}

function groupSessionsByProject(sessions: SessionNavigationEntry[]): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>();

  for (const session of sessions) {
    const group = groups.get(session.projectId);
    if (group) group.sessions.push(session);
    else {
      groups.set(session.projectId, {
        projectId: session.projectId,
        projectName: session.projectName,
        sessions: [session],
      });
    }
  }

  return [...groups.values()];
}

const appThemeAliasesStyle = css({
  "--panel": "var(--card)",
  "--success": "var(--primary)",
  "--text": "var(--foreground)",
  fontFamily: "var(--font-sans)",
  lineHeight: 1.5,
  "& *, & *::before, & *::after": { boxSizing: "border-box" },
});
const shellPanelGroupStyle = css({ minWidth: 0, minHeight: "100svh" });
const shellContentPanelStyle = css({
  display: "flex",
  minWidth: 0,
  "@media (max-width: 1279.98px)": { flexGrow: "1 !important" },
  "[data-slot='resizable-panel-group']:has(> [data-slot='resizable-panel'] > [data-slot='sidebar-desktop']:not([open])) > &":
    {
      flexGrow: "1 !important",
    },
});
const desktopSidebarPanelStyle = css({
  position: "relative",
  display: "none",
  overflow: "visible",
  "&:has(> [data-slot='sidebar-desktop']:not([open]))": {
    flexBasis: "0 !important",
  },
  [media.md]: { "&[data-side='left']": { display: "block" } },
  [media.xl]: { "&[data-side='right']": { display: "block" } },
});
const desktopSidebarHandleStyle = css({
  display: "none",
  height: "auto",
  alignSelf: "stretch",
  "&[data-side='right']": { transform: "translateX(-8px)" },
  "[data-slot='resizable-panel-group']:has(> [data-slot='resizable-panel'][data-side='left'] > [data-slot='sidebar-desktop']:not([open])) > &[data-side='left'], [data-slot='resizable-panel-group']:has(> [data-slot='resizable-panel'][data-side='right'] > [data-slot='sidebar-desktop']:not([open])) > &[data-side='right']":
    {
      pointerEvents: "none",
      opacity: 0,
      visibility: "hidden",
    },
  [media.md]: { "&[data-side='left']": { display: "flex" } },
  [media.xl]: { "&[data-side='right']": { display: "flex" } },
});
const sidebarBrandStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  height: "48px",
  padding: "8px",
  color: "var(--sidebar-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  textDecoration: "none",
  "&:hover": { background: "var(--sidebar-accent)" },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--sidebar-ring)" },
});
const sidebarBrandMarkStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: "32px",
  height: "32px",
  padding: "6px",
  borderRadius: "var(--radius-lg)",
  "& img": { display: "block", width: "100%", height: "100%" },
});
const sidebarBrandTextStyle = css({
  display: "grid",
  flex: 1,
  minWidth: 0,
  color: "var(--sidebar-foreground)",
  fontSize: "14px",
  lineHeight: 1.25,
  textAlign: "left",
  "& strong": {
    overflow: "hidden",
    fontWeight: 600,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
const sessionProjectStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  "& + &": { marginTop: "12px" },
});
const sessionProjectHeadingStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  height: "28px",
  margin: 0,
  padding: "0 8px",
  color: "color-mix(in srgb, var(--sidebar-foreground) 70%, transparent)",
  fontSize: "13px",
  fontWeight: 500,
  lineHeight: 1,
  "& > svg": { flexShrink: 0 },
  "& > span:first-of-type": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
const sessionProjectRuleStyle = css({
  flex: 1,
  minWidth: "16px",
  height: "1px",
  background: "var(--sidebar-border)",
});
const emptySessionsStyle = css({
  margin: "4px 8px",
  color: "var(--sidebar-foreground)",
  fontSize: "12px",
  opacity: 0.7,
});
const sidebarAccountTriggerStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  height: "48px",
  padding: "8px",
  color: "var(--sidebar-foreground)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-md)",
  outline: "none",
  font: "inherit",
  textAlign: "left",
  "&:hover, &:focus-visible": { background: "var(--sidebar-accent)" },
  "details[open] &": { background: "var(--sidebar-accent)" },
  "& > svg:last-child": { marginLeft: "auto" },
});
const sidebarAccountTextStyle = sidebarBrandTextStyle;
const accountMenuContentStyle = css({
  "&[data-slot='dropdown-menu-content']": {
    inset: "anchor(top) auto auto anchor(left)",
    transform: "translateY(calc(-100% - 4px))",
  },
  [media.md]: {
    "&[data-slot='dropdown-menu-content']": {
      inset: "auto auto anchor(bottom) calc(anchor(right) + 4px)",
      transform: "none",
    },
  },
});
const accountMenuIdentityStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "2px 0",
});
const accountMenuTextStyle = css({
  display: "grid",
  flex: 1,
  minWidth: 0,
  color: "var(--popover-foreground)",
  fontSize: "14px",
  lineHeight: 1.25,
  textAlign: "left",
  "& strong, & span": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  "& strong": { fontWeight: 500 },
  "& span": { fontSize: "12px" },
});
const topBarStyle = css({ display: "flex", alignItems: "center", flexShrink: 0, height: "64px" });
const topBarContentStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minWidth: 0,
  padding: "0 16px",
  [media.md]: { paddingLeft: "56px" },
  [media.xl]: {
    "[data-has-right-sidebar='true'] &": { paddingRight: "56px" },
  },
});
const topBarSeparatorStyle = css({ height: "16px", marginRight: "8px" });
const topBarTitleStyle = css({
  minWidth: 0,
  maxWidth: "min(70vw, 720px)",
  margin: 0,
  overflow: "hidden",
  color: "var(--foreground)",
  fontSize: "18px",
  fontWeight: 650,
  letterSpacing: "-0.02em",
  lineHeight: 1.2,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const desktopBreadcrumbItemStyle = css({
  display: "none",
  [media.md]: { display: "inline-flex" },
});
const desktopBreadcrumbSeparatorStyle = css({
  display: "none",
  [media.md]: { display: "list-item" },
});
const contentStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "24px",
  minWidth: 0,
  padding: "0 16px 16px",
  [media.md]: { padding: "0 24px 24px" },
});
const sessionLoadingStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "10px",
  flex: 1,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});
const pageHeaderStyle = css({ display: "grid", gap: "6px", maxWidth: "720px" });
const pageHeadingStyle = css({
  margin: 0,
  color: "var(--foreground)",
  fontSize: "clamp(24px, 4vw, 32px)",
  fontWeight: 650,
  letterSpacing: "-0.03em",
  lineHeight: 1.15,
});
const pageCopyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});
