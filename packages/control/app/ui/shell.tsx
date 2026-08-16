import { css, type Handle, type RemixNode } from "remix/ui";

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
} from "@/app/ui/components/index.ts";
import { Document } from "@/app/ui/document.tsx";
import { media } from "@/app/ui/responsive.ts";

export interface AppShellProps {
  activeSection: "overview" | "projects";
  children?: RemixNode;
  copy?: string;
  csrfToken: string;
  eyebrow: string;
  heading: string;
  title: string;
}

const MOBILE_SIDEBAR_ID = "openorb-mobile-sidebar";

export function AppShell(handle: Handle<AppShellProps>) {
  return () => (
    <Document title={handle.props.title}>
      <SidebarLayout mix={[designSystemStyle, appThemeAliasesStyle]}>
        <SidebarDesktop>
          <AppNavigation
            csrfToken={handle.props.csrfToken}
            activeSection={handle.props.activeSection}
          />
        </SidebarDesktop>
        <SidebarMobile id={MOBILE_SIDEBAR_ID}>
          <AppNavigation
            csrfToken={handle.props.csrfToken}
            activeSection={handle.props.activeSection}
          />
        </SidebarMobile>
        <SidebarInset aria-label="Authenticated control panel">
          <header mix={topBarStyle}>
            <div mix={topBarContentStyle}>
              <SidebarTrigger target={MOBILE_SIDEBAR_ID} />
              <Separator orientation="vertical" mix={topBarSeparatorStyle} />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem mix={desktopBreadcrumbItemStyle}>
                    <BreadcrumbLink href={routes.app.index.href()}>Control panel</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator mix={desktopBreadcrumbSeparatorStyle} />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{handle.props.eyebrow}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </header>
          <div mix={contentStyle}>
            <header mix={pageHeaderStyle}>
              <h1 mix={pageHeadingStyle}>{handle.props.heading}</h1>
              {handle.props.copy ? <p mix={pageCopyStyle}>{handle.props.copy}</p> : null}
            </header>
            {handle.props.children}
          </div>
        </SidebarInset>
      </SidebarLayout>
    </Document>
  );
}

function AppNavigation(
  handle: Handle<{
    csrfToken: string;
    activeSection: AppShellProps["activeSection"];
  }>,
) {
  return () => (
    <>
      <SidebarHeader>
        <a href={routes.app.index.href()} aria-label="OpenOrb overview" mix={sidebarBrandStyle}>
          <span mix={sidebarBrandMarkStyle}>
            <img src="/favicon.svg" alt="" width="20" height="20" />
          </span>
          <span mix={sidebarBrandTextStyle}>
            <strong>OpenOrb</strong>
            <span>Control panel</span>
          </span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup aria-label="Control panel pages">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                href={routes.app.index.href()}
                active={handle.props.activeSection === "overview"}
                icon={<Icon name="dashboard" />}
              >
                Overview
              </SidebarMenuButton>
            </SidebarMenuItem>
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
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger mix={sidebarAccountTriggerStyle}>
            <Avatar>
              <AvatarFallback>OA</AvatarFallback>
            </Avatar>
            <span mix={sidebarAccountTextStyle}>
              <strong>Administrator</strong>
              <span>Single-user workspace</span>
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
                  <span>Single-user workspace</span>
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLink href={routes.app.settings.index.href()}>
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

const appThemeAliasesStyle = css({
  "--panel": "var(--card)",
  "--success": "var(--primary)",
  "--text": "var(--foreground)",
  fontFamily: "var(--font-sans)",
  lineHeight: 1.5,
  "& *, & *::before, & *::after": { boxSizing: "border-box" },
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
  background: "var(--sidebar-primary)",
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
  "& strong, & span": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  "& strong": { fontWeight: 600 },
  "& span": { fontSize: "12px" },
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
  inset: "auto auto calc(100% + 4px) 0",
  [media.md]: { inset: "auto auto 0 calc(100% + 4px)" },
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
  minWidth: 0,
  padding: "0 16px",
  [media.md]: { paddingLeft: "56px" },
});
const topBarSeparatorStyle = css({ height: "16px", marginRight: "8px" });
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
