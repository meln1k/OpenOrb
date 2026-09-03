import { clientEntry, css, type Handle, type Props, type RemixNode } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/ui/components/collapsible.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";

const mobileSidebarSlideDuration = 300;

export function SidebarLayout(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="sidebar-wrapper" mix={[layoutStyle, mix]} />;
  };
}

type SidebarDesktopProps = Props<"details"> & {
  side?: "left" | "right";
};

export function SidebarDesktop(handle: Handle<SidebarDesktopProps>) {
  return () => {
    const { children, mix, open = true, side = "left", ...props } = handle.props;
    const label = side === "right" ? "changes sidebar" : "sidebar";
    return (
      <details
        {...props}
        open={open}
        data-side={side}
        data-slot="sidebar-desktop"
        mix={[desktopStyle, mix]}
      >
        <summary
          aria-label={`Toggle ${label}`}
          title={`Toggle ${label}`}
          data-slot="sidebar-desktop-trigger"
          mix={desktopTriggerStyle}
        >
          <Icon name={side === "right" ? "panel-right" : "panel-left"} />
          <span mix={screenReaderOnlyStyle}>Toggle {label}</span>
        </summary>
        <aside
          aria-label={side === "right" ? "Session changes" : "Primary navigation"}
          mix={desktopPanelStyle}
        >
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
        popover="manual"
        aria-label="Primary navigation"
        data-slot="sidebar-mobile"
        mix={[mobilePanelStyle, mix]}
      >
        {children}
        <SidebarMobileSwipeBehavior sidebarId={id} />
      </aside>
    );
  };
}

export const SidebarMobileSwipeBehavior = clientEntry<{ sidebarId: string }>(
  import.meta.url,
  function SidebarMobileSwipeBehavior(handle: Handle<{ sidebarId: string }>) {
    handle.queueTask(() => {
      const sidebar = document.getElementById(handle.props.sidebarId);
      const layout = sidebar?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
      if (!(sidebar instanceof HTMLElement) || !layout) return;
      const mobileSidebar = sidebar;
      const sidebarLayout = layout;

      type SidebarPosition = {
        width: number;
        hiddenDistance: number;
        revealed: number;
      };
      type Swipe = SidebarPosition & {
        pointerId: number;
        x: number;
        y: number;
        active: boolean;
        scale: number;
        lastX: number;
        lastTime: number;
        velocity: number;
      };

      let swipe: Swipe | undefined;
      let settlementCleanup: (() => void) | undefined;

      function setSwipePosition(offset: number, progress: number) {
        mobileSidebar.style.setProperty("--openorb-sidebar-swipe-offset", `${offset}px`);
        mobileSidebar.style.setProperty(
          "--openorb-sidebar-backdrop-alpha",
          `${progress * 0.5}`,
        );
      }

      function clearSwipeStyles() {
        delete mobileSidebar.dataset.swipe;
        mobileSidebar.style.removeProperty("--openorb-sidebar-swipe-offset");
        mobileSidebar.style.removeProperty("--openorb-sidebar-backdrop-alpha");
        mobileSidebar.style.removeProperty("--openorb-sidebar-motion");
      }

      function clearSettlement() {
        const cleanup = settlementCleanup;
        settlementCleanup = undefined;
        cleanup?.();
      }

      function beginSwipe(current: Swipe) {
        current.active = true;
        clearSettlement();
        mobileSidebar.dataset.swipe = "dragging";
        setSwipePosition(-globalThis.innerWidth, 0);
        mobileSidebar.showPopover();

        current.width = mobileSidebar.offsetWidth;
        const left = Number.parseFloat(globalThis.getComputedStyle(mobileSidebar).left) || 0;
        current.hiddenDistance = current.width + Math.max(0, left);
        current.scale = current.hiddenDistance / (globalThis.innerWidth * 0.5);
        sidebarLayout.setPointerCapture(current.pointerId);
      }

      function setRevealed(current: SidebarPosition, revealed: number) {
        current.revealed = Math.min(Math.max(revealed, 0), current.hiddenDistance);
      }

      function renderSwipe(current: SidebarPosition) {
        setSwipePosition(
          -current.hiddenDistance + current.revealed,
          Math.min(current.revealed / current.width, 1),
        );
      }

      function revealSwipe(current: SidebarPosition, revealed: number) {
        setRevealed(current, revealed);
        renderSwipe(current);
      }

      function updateSwipe(event: PointerEvent) {
        const current = swipe;
        if (!current || event.pointerId !== current.pointerId) return;

        const rightDistance = event.clientX - current.x;
        const horizontalDistance = Math.abs(rightDistance);
        const verticalDistance = Math.abs(event.clientY - current.y);
        if (!current.active) {
          if (Math.max(horizontalDistance, verticalDistance) < 8) return current;
          if (rightDistance <= 0 || horizontalDistance < verticalDistance * 1.25) {
            swipe = undefined;
            return;
          }
          beginSwipe(current);
        }

        if (event.cancelable) event.preventDefault();
        revealSwipe(current, rightDistance * current.scale);
        const now = globalThis.performance.now();
        const elapsed = (now - current.lastTime) / 1_000;
        const delta = event.clientX - current.lastX;
        if (elapsed > 0 && delta !== 0) {
          const velocity = delta * current.scale / elapsed;
          current.velocity = current.velocity * 0.5 + velocity * 0.5;
          current.lastX = event.clientX;
          current.lastTime = now;
        }
        return current;
      }

      function readSidebarPosition(): SidebarPosition {
        const width = mobileSidebar.offsetWidth;
        const left = Number.parseFloat(globalThis.getComputedStyle(mobileSidebar).left) || 0;
        const hiddenDistance = width + Math.max(0, left);
        return {
          width,
          hiddenDistance,
          revealed: Math.min(
            Math.max(width + mobileSidebar.getBoundingClientRect().left, 0),
            hiddenDistance,
          ),
        };
      }

      function settleSwipe(
        current: SidebarPosition,
        open: boolean,
      ) {
        clearSettlement();
        mobileSidebar.dataset.swipe = "dragging";
        revealSwipe(current, current.revealed);
        const target = open ? current.hiddenDistance : 0;

        const finish = () => {
          clearSettlement();
          revealSwipe(current, target);
          mobileSidebar.style.removeProperty("--openorb-sidebar-motion");
          if (open && mobileSidebar.matches(":popover-open")) {
            mobileSidebar.dataset.swipe = "open";
            return;
          }
          if (mobileSidebar.matches(":popover-open")) mobileSidebar.hidePopover();
          clearSwipeStyles();
        };
        if (globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          finish();
          return;
        }

        const distance = target - current.revealed;
        if (Math.abs(distance) < 1) {
          finish();
          return;
        }
        const duration = mobileSidebarSlideDuration * Math.abs(distance) / current.hiddenDistance;
        mobileSidebar.style.setProperty("--openorb-sidebar-motion", `${duration}ms linear`);
        void globalThis.getComputedStyle(mobileSidebar).transform;
        mobileSidebar.dataset.swipe = "settling";

        const onTransitionEnd = (event: TransitionEvent) => {
          if (event.target === mobileSidebar && event.propertyName === "transform") finish();
        };
        mobileSidebar.addEventListener("transitionend", onTransitionEnd);
        const timeout = globalThis.setTimeout(finish, duration + 100);
        settlementCleanup = () => {
          globalThis.clearTimeout(timeout);
          mobileSidebar.removeEventListener("transitionend", onTransitionEnd);
        };
        revealSwipe(current, target);
      }

      function closeSidebar() {
        if (!mobileSidebar.matches(":popover-open")) return;
        swipe = undefined;
        settleSwipe(readSidebarPosition(), false);
      }

      function releasePointer(current: Swipe) {
        if (sidebarLayout.hasPointerCapture(current.pointerId)) {
          sidebarLayout.releasePointerCapture(current.pointerId);
        }
      }

      function cancelSwipe(event?: PointerEvent) {
        const current = swipe;
        if (!current || (event && event.pointerId !== current.pointerId)) return;
        swipe = undefined;
        releasePointer(current);
        if (current.active) settleSwipe(current, false);
      }

      function isInsideHorizontalScroller(target: EventTarget | null) {
        if (!(target instanceof Element)) return false;
        for (
          let element: Element | null = target;
          element !== null && element !== sidebarLayout;
          element = element.parentElement
        ) {
          if (!(element instanceof HTMLElement)) continue;
          const overflowX = globalThis.getComputedStyle(element).overflowX;
          if (
            (overflowX === "auto" || overflowX === "scroll") &&
            element.scrollWidth > element.clientWidth + 1
          ) return true;
        }
        return false;
      }

      sidebarLayout.addEventListener("pointerdown", (event) => {
        if (
          swipe ||
          !event.isPrimary ||
          event.pointerType !== "touch" ||
          !globalThis.matchMedia("(max-width: 767.98px)").matches ||
          mobileSidebar.matches(":popover-open") ||
          isInsideHorizontalScroller(event.target)
        ) {
          return;
        }
        swipe = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          active: false,
          width: 0,
          hiddenDistance: 0,
          revealed: 0,
          scale: 1,
          lastX: event.clientX,
          lastTime: globalThis.performance.now(),
          velocity: 0,
        };
      }, { signal: handle.signal });
      sidebarLayout.addEventListener("pointermove", (event) => {
        updateSwipe(event);
      }, { signal: handle.signal });
      sidebarLayout.addEventListener("pointerup", (event) => {
        const current = swipe;
        if (!current || event.pointerId !== current.pointerId) return;
        swipe = undefined;
        if (current.active) {
          releasePointer(current);
          const idleTime = globalThis.performance.now() - current.lastTime;
          const velocity = idleTime <= 100 ? current.velocity : 0;
          settleSwipe(
            current,
            velocity === 0 ? current.revealed > current.width / 2 : velocity > 0,
          );
        }
      }, { signal: handle.signal });
      sidebarLayout.addEventListener("pointercancel", cancelSwipe, { signal: handle.signal });
      document.addEventListener("pointerdown", (event) => {
        if (!mobileSidebar.matches(":popover-open")) return;
        const target = event.target;
        if (!(target instanceof Element) || mobileSidebar.contains(target)) return;
        const trigger = target.closest("[popovertarget]");
        if (trigger?.getAttribute("popovertarget") === mobileSidebar.id) return;
        closeSidebar();
      }, { signal: handle.signal });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !mobileSidebar.matches(":popover-open")) return;
        event.preventDefault();
        closeSidebar();
      }, { signal: handle.signal });
      mobileSidebar.addEventListener("toggle", () => {
        if (mobileSidebar.matches(":popover-open")) return;
        swipe = undefined;
        clearSettlement();
        clearSwipeStyles();
      }, { signal: handle.signal });
      handle.signal.addEventListener("abort", () => {
        clearSettlement();
      }, { once: true });
    });

    return () => null;
  },
);

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
  touchAction: "pan-y pinch-zoom",
  [media.md]: { touchAction: "auto" },
});

const desktopStyle = css({
  position: "relative",
  display: "none",
  width: "100%",
  height: "100%",
  color: "var(--sidebar-foreground)",
  [media.md]: { "&[data-side='left']": { display: "block" } },
  [media.xl]: { "&[data-side='right']": { display: "block" } },
});

const desktopPanelStyle = css({
  position: "absolute",
  inset: "8px",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  color: "var(--sidebar-foreground)",
  background: "var(--sidebar)",
});

const desktopTriggerStyle = css({
  position: "absolute",
  top: "26px",
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
  "[data-slot='sidebar-desktop'][data-side='left'] > &": { right: "auto", left: "20px" },
  "[data-slot='sidebar-desktop'][data-side='left'][open] > &": { left: "calc(100% + 16px)" },
  "[data-slot='sidebar-desktop'][data-side='right'] > &": { right: "20px", left: "auto" },
  "[data-slot='sidebar-desktop'][data-side='right'][open] > &": {
    right: "calc(100% + 16px)",
  },
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
    animation: `openorb-sidebar-in ${mobileSidebarSlideDuration}ms linear`,
  },
  "&[data-swipe]:popover-open": {
    animation: "none",
  },
  "&[data-swipe='dragging']:popover-open, &[data-swipe='settling']:popover-open": {
    transform: "translate3d(var(--openorb-sidebar-swipe-offset), 0, 0)",
    willChange: "transform",
  },
  "&[data-swipe='dragging']:popover-open, &[data-swipe='open']:popover-open": {
    transition: "none",
  },
  "&[data-swipe='settling']:popover-open": {
    transition: "transform var(--openorb-sidebar-motion)",
  },
  "&::backdrop": {
    backgroundColor: "rgb(0 0 0 / 0.5)",
  },
  "&:popover-open::backdrop": {
    animation: `openorb-sidebar-backdrop-in ${mobileSidebarSlideDuration}ms linear`,
  },
  "&[data-swipe]:popover-open::backdrop": {
    backgroundColor: "rgb(0 0 0 / var(--openorb-sidebar-backdrop-alpha))",
    animation: "none",
  },
  "&[data-swipe='dragging']:popover-open::backdrop, &[data-swipe='open']:popover-open::backdrop": {
    transition: "none",
  },
  "&[data-swipe='settling']:popover-open::backdrop": {
    transition: "background-color var(--openorb-sidebar-motion)",
  },
  "@keyframes openorb-sidebar-in": {
    from: { transform: "translateX(calc(-100% - 8px))" },
    to: { transform: "translateX(0)" },
  },
  "@keyframes openorb-sidebar-backdrop-in": {
    from: { backgroundColor: "rgb(0 0 0 / 0)" },
    to: { backgroundColor: "rgb(0 0 0 / 0.5)" },
  },
  "@media (prefers-reduced-motion: reduce)": {
    "&:popover-open, &:popover-open::backdrop": {
      animation: "none",
      transition: "none",
    },
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
    "[data-slot='sidebar-wrapper']:has([data-slot='sidebar-desktop'][data-side='left']:not([open])) > &":
      {
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
