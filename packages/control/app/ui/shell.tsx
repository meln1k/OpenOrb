import { css, type Handle, type RemixNode } from "remix/ui";

import { routes } from "../routes.ts";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Separator,
  sidebarAccountTextStyle,
  sidebarAccountTriggerStyle,
  sidebarBrandMarkStyle,
  sidebarBrandStyle,
  sidebarBrandTextStyle,
  SidebarContent,
  SidebarDesktop,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuDisclosure,
  SidebarMenuItem,
  SidebarMobile,
  SidebarSubMenuItem,
  SidebarSubMenuLink,
  SidebarTrigger,
} from "./components/index.ts";
import { Document } from "./document.tsx";
import { media } from "./responsive.ts";

export interface AppShellProps {
  activePage: "overview" | "credentials";
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
          <AppNavigation activePage={handle.props.activePage} csrfToken={handle.props.csrfToken} />
        </SidebarDesktop>
        <SidebarMobile id={MOBILE_SIDEBAR_ID}>
          <AppNavigation activePage={handle.props.activePage} csrfToken={handle.props.csrfToken} />
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
  handle: Handle<{ activePage: AppShellProps["activePage"]; csrfToken: string }>,
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
        <SidebarGroup>
          <SidebarGroupLabel>Recent</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuDisclosure
                label="Control panel"
                icon={<Icon name="dashboard" />}
                defaultOpen
              >
                <SidebarSubMenuItem>
                  <SidebarSubMenuLink
                    href={routes.app.index.href()}
                    active={handle.props.activePage === "overview"}
                  >
                    Overview
                  </SidebarSubMenuLink>
                </SidebarSubMenuItem>
                <SidebarSubMenuItem>
                  <SidebarSubMenuLink
                    href={routes.app.credentials.index.href()}
                    active={handle.props.activePage === "credentials"}
                  >
                    Credentials
                  </SidebarSubMenuLink>
                </SidebarSubMenuItem>
              </SidebarMenuDisclosure>
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
          <DropdownMenuContent>
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
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <Icon name="sparkles" />
                Upgrade to Pro
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <Icon name="account" />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon name="credit-card" />
                Billing
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon name="bell" />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup>
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
