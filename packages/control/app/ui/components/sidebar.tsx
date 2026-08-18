import { css, type Handle, type Props, type RemixNode } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/ui/components/collapsible.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";

export function SidebarLayout(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="sidebar-wrapper" mix={[layoutStyle, mix]} />;
  };
}

export function SidebarDesktop(handle: Handle<Props<"details">>) {
  return () => {
    const { children, mix, open = true, ...props } = handle.props;
    return (
      <details {...props} open={open} data-slot="sidebar-desktop" mix={[desktopStyle, mix]}>
        <summary
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          data-slot="sidebar-desktop-trigger"
          mix={desktopTriggerStyle}
        >
          <Icon name="panel-left" />
          <span mix={screenReaderOnlyStyle}>Toggle sidebar</span>
        </summary>
        <aside aria-label="Primary navigation" mix={desktopPanelStyle}>
          {children}
        </aside>
      </details>
    );
  };
}

export function SidebarMobile(handle: Handle<Props<"aside"> & { id: string }>) {
  return () => {
    const { children, id, mix, ...props } = handle.props;
    return (
      <aside
        {...props}
        id={id}
        popover="auto"
        aria-label="Primary navigation"
        data-slot="sidebar-mobile"
        mix={[mobilePanelStyle, mix]}
      >
        {children}
      </aside>
    );
  };
}

export function SidebarTrigger(handle: Handle<Props<"button"> & { target: string }>) {
  return () => {
    const { mix, target, type = "button", ...props } = handle.props;
    return (
      <button
        {...props}
        type={type}
        popovertarget={target}
        aria-label="Open sidebar"
        title="Open sidebar"
        data-slot="sidebar-trigger"
        mix={[triggerStyle, mobileTriggerStyle, mix]}
      >
        <Icon name="panel-left" />
        <span mix={screenReaderOnlyStyle}>Open sidebar</span>
      </button>
    );
  };
}

export function SidebarInset(handle: Handle<Props<"main">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <main {...props} data-slot="sidebar-inset" mix={[insetStyle, mix]} />;
  };
}

export function SidebarHeader(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="sidebar-header" mix={[sectionStyle, mix]} />;
  };
}

export function SidebarContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="sidebar-content" mix={[contentStyle, mix]} />;
  };
}

export function SidebarFooter(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="sidebar-footer" mix={[sectionStyle, footerStyle, mix]} />;
  };
}

export function SidebarGroup(handle: Handle<Props<"section">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <section {...props} data-slot="sidebar-group" mix={[groupStyle, mix]} />;
  };
}

export function SidebarGroupLabel(handle: Handle<Props<"h2">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <h2 {...props} data-slot="sidebar-group-label" mix={[groupLabelStyle, mix]} />;
  };
}

export function SidebarMenu(handle: Handle<Props<"ul">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <ul {...props} data-slot="sidebar-menu" mix={[menuStyle, mix]} />;
  };
}

export function SidebarMenuItem(handle: Handle<Props<"li">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <li {...props} data-slot="sidebar-menu-item" mix={[menuItemStyle, mix]} />;
  };
}

export interface SidebarMenuButtonProps {
  active?: boolean;
  badge?: string;
  children?: RemixNode;
  command?: string;
  commandFor?: string;
  disabled?: boolean;
  href?: string;
  icon?: RemixNode;
}

export function SidebarMenuButton(handle: Handle<SidebarMenuButtonProps>) {
  return () => {
    const { active, badge, children, command, commandFor, disabled, href, icon } = handle.props;
    const content = (
      <>
        {icon}
        <span mix={menuTextStyle}>{children}</span>
        {badge ? <span mix={menuBadgeStyle}>{badge}</span> : null}
      </>
    );

    return href && !disabled
      ? (
        <a
          href={href}
          aria-current={active ? "page" : undefined}
          data-active={active ? "true" : "false"}
          data-slot="sidebar-menu-button"
          mix={menuButtonStyle}
        >
          {content}
        </a>
      )
      : commandFor && !disabled
      ? (
        <button
          type="button"
          command={command}
          commandFor={commandFor}
          aria-pressed={active ? "true" : undefined}
          data-active={active ? "true" : "false"}
          data-slot="sidebar-menu-button"
          mix={menuButtonStyle}
        >
          {content}
        </button>
      )
      : (
        <span
          aria-disabled={disabled ? "true" : undefined}
          data-active={active ? "true" : "false"}
          data-slot="sidebar-menu-button"
          mix={menuButtonStyle}
        >
          {content}
        </span>
      );
  };
}

export interface SidebarMenuDisclosureProps {
  children?: RemixNode;
  defaultOpen?: boolean;
  icon?: RemixNode;
  label: string;
}

export function SidebarMenuDisclosure(handle: Handle<SidebarMenuDisclosureProps>) {
  return () => (
    <Collapsible defaultOpen={handle.props.defaultOpen}>
      <CollapsibleTrigger mix={[menuButtonStyle, disclosureTriggerStyle]}>
        {handle.props.icon}
        <span mix={menuTextStyle}>{handle.props.label}</span>
        <span data-slot="sidebar-disclosure-chevron" mix={chevronStyle}>
          <Icon name="chevron-down" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul mix={subMenuStyle}>{handle.props.children}</ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SidebarSubMenuItem(handle: Handle<Props<"li">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <li {...props} mix={[menuItemStyle, mix]} />;
  };
}

export function SidebarSubMenuLink(
  handle: Handle<Props<"a"> & { active?: boolean }>,
) {
  return () => {
    const { active, mix, ...props } = handle.props;
    return (
      <a
        {...props}
        aria-current={active ? "page" : undefined}
        data-active={active ? "true" : "false"}
        data-slot="sidebar-menu-sub-button"
        mix={[subMenuLinkStyle, mix]}
      />
    );
  };
}

const layoutStyle = css({
  display: "flex",
  minHeight: "100svh",
  width: "100%",
  color: "var(--foreground)",
  background: "var(--sidebar)",
});

const desktopStyle = css({
  display: "none",
  flex: "0 0 0",
  width: 0,
  color: "var(--sidebar-foreground)",
  "&[open]": { flexBasis: "256px", width: "256px" },
  [media.md]: { display: "block" },
});

const desktopPanelStyle = css({
  position: "fixed",
  inset: "8px auto 8px 8px",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  width: "240px",
  minHeight: 0,
  color: "var(--sidebar-foreground)",
  background: "var(--sidebar)",
});

const desktopTriggerStyle = css({
  position: "fixed",
  top: "26px",
  left: "20px",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  color: "var(--foreground)",
  background: "transparent",
  borderRadius: "var(--radius-md)",
  outline: "none",
  listStyle: "none",
  cursor: "pointer",
  "[data-slot='sidebar-desktop'][open] > &": { left: "272px" },
  "&::-webkit-details-marker": { display: "none" },
  "&:hover": { background: "var(--accent)" },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--ring)" },
});

const mobilePanelStyle = css({
  position: "fixed",
  top: "max(8px, env(safe-area-inset-top))",
  right: "auto",
  bottom: "max(8px, env(safe-area-inset-bottom))",
  left: "max(8px, env(safe-area-inset-left))",
  zIndex: 50,
  width: "min(288px, 85vw)",
  height: "auto",
  maxHeight: "none",
  margin: 0,
  padding: "8px",
  color: "var(--sidebar-foreground)",
  background: "var(--sidebar)",
  border: "1px solid var(--sidebar-border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "12px 0 32px rgb(0 0 0 / 0.2)",
  overflow: "hidden",
  "&:popover-open": {
    display: "flex",
    flexDirection: "column",
    animation: "openorb-sidebar-in 300ms cubic-bezier(0.22, 1, 0.36, 1)",
  },
  "&::backdrop": { background: "rgb(0 0 0 / 0.5)" },
  "&:popover-open::backdrop": {
    animation: "openorb-sidebar-backdrop-in 250ms ease-out",
  },
  "@keyframes openorb-sidebar-in": {
    from: { opacity: 0, transform: "translateX(calc(-100% - 8px))" },
    to: { opacity: 1, transform: "translateX(0)" },
  },
  "@keyframes openorb-sidebar-backdrop-in": {
    from: { background: "rgb(0 0 0 / 0)" },
    to: { background: "rgb(0 0 0 / 0.5)" },
  },
  "@media (prefers-reduced-motion: reduce)": {
    "&:popover-open, &:popover-open::backdrop": { animation: "none" },
  },
  [media.md]: {
    display: "none",
    "&:popover-open": { display: "none" },
  },
});

const insetStyle = css({
  position: "relative",
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minWidth: 0,
  width: "100%",
  minHeight: "100svh",
  margin: 0,
  background: "var(--background)",
  borderRadius: 0,
  boxShadow: "none",
  overflow: "hidden",
  [media.md]: {
    minHeight: "calc(100svh - 16px)",
    margin: "8px 8px 8px 0",
    borderRadius: "var(--radius-xl)",
    boxShadow: "0 1px 3px rgb(0 0 0 / 0.08)",
    "[data-slot='sidebar-wrapper']:has([data-slot='sidebar-desktop']:not([open])) > &": {
      marginLeft: "8px",
    },
  },
});

const triggerStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: "28px",
  height: "28px",
  padding: 0,
  color: "var(--foreground)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-md)",
  outline: "none",
  cursor: "pointer",
  "&:hover": { background: "var(--accent)" },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--ring)" },
});

const mobileTriggerStyle = css({
  [media.md]: { display: "none" },
});

const sectionStyle = css({ display: "flex", flexDirection: "column", gap: "8px", padding: "8px" });
const contentStyle = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "8px",
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
});
const footerStyle = css({ marginTop: "auto" });
const groupStyle = css({
  position: "relative",
  display: "flex",
  flexDirection: "column",
  padding: "8px",
});
const groupLabelStyle = css({
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  height: "32px",
  margin: 0,
  padding: "0 8px",
  color: "color-mix(in srgb, var(--sidebar-foreground) 70%, transparent)",
  fontSize: "12px",
  fontWeight: 500,
});
const menuStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  width: "100%",
  minWidth: 0,
  margin: 0,
  padding: 0,
  listStyle: "none",
});
const menuItemStyle = css({ position: "relative", minWidth: 0 });
const menuButtonStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minWidth: 0,
  height: "32px",
  padding: "8px",
  color: "var(--sidebar-foreground)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-md)",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  lineHeight: 1,
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
  transition: "background-color 150ms ease, color 150ms ease",
  "&:hover, &[data-active='true']": {
    color: "var(--sidebar-accent-foreground)",
    background: "var(--sidebar-accent)",
  },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--sidebar-ring)" },
  "&[data-active='true']": { fontWeight: 500 },
  "&[aria-disabled='true']": { opacity: 0.55 },
  "& > svg": { flexShrink: 0 },
});
const disclosureTriggerStyle = css({
  "& > [data-slot='sidebar-disclosure-chevron']": { marginLeft: "auto" },
});
const menuTextStyle = css({
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const menuBadgeStyle = css({
  marginLeft: "auto",
  padding: "2px 6px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderRadius: "999px",
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
});
const chevronStyle = css({
  display: "flex",
  transition: "transform 180ms ease",
  "details[open] > summary &": { transform: "rotate(180deg)" },
});
const subMenuStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  minWidth: 0,
  margin: "2px 14px 0",
  padding: "2px 0 2px 10px",
  borderLeft: "1px solid var(--sidebar-border)",
  listStyle: "none",
});
const subMenuLinkStyle = css({
  display: "flex",
  alignItems: "center",
  minWidth: 0,
  height: "28px",
  padding: "0 8px",
  color: "var(--sidebar-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  fontSize: "14px",
  textDecoration: "none",
  "&:hover, &[data-active='true']": {
    color: "var(--sidebar-accent-foreground)",
    background: "var(--sidebar-accent)",
  },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--sidebar-ring)" },
});
const screenReaderOnlyStyle = css({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
});
