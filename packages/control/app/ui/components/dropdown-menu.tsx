import { css, type Handle, type Props } from "remix/ui";

export function DropdownMenu(handle: Handle<Props<"details">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <details {...props} data-slot="dropdown-menu" mix={[menuStyle, mix]} />;
  };
}

export function DropdownMenuTrigger(handle: Handle<Props<"summary">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <summary
        {...props}
        data-slot="dropdown-menu-trigger"
        mix={[triggerStyle, mix]}
      />
    );
  };
}

export function DropdownMenuContent(handle: Handle<Props<"div">>) {
  return () => {
    const { children, mix, ...props } = handle.props;
    return (
      <div data-slot="dropdown-menu-content" mix={[contentStyle, mix]}>
        <div {...props} role="menu" mix={listStyle}>
          {children}
        </div>
      </div>
    );
  };
}

export function DropdownMenuGroup(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} role="group" data-slot="dropdown-menu-group" mix={mix} />;
  };
}

export function DropdownMenuLabel(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="dropdown-menu-label" mix={[labelStyle, mix]} />;
  };
}

export function DropdownMenuSeparator(handle: Handle<Props<"hr">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <hr {...props} data-slot="dropdown-menu-separator" mix={[separatorStyle, mix]} />;
  };
}

export function DropdownMenuItem(handle: Handle<Props<"button">>) {
  return () => {
    const { disabled, mix, type = "button", ...props } = handle.props;
    return (
      <button
        {...props}
        type={type}
        disabled={disabled}
        role="menuitem"
        data-slot="dropdown-menu-item"
        mix={[itemStyle, mix]}
      />
    );
  };
}

const menuStyle = css({ position: "relative", width: "100%" });

const triggerStyle = css({
  listStyle: "none",
  cursor: "pointer",
  "&::-webkit-details-marker": { display: "none" },
});

const contentStyle = css({
  position: "absolute",
  left: "calc(100% + 4px)",
  bottom: 0,
  zIndex: 50,
  display: "flex",
  flexDirection: "column",
  width: "224px",
  minWidth: "224px",
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "min(420px, calc(100dvh - 32px))",
  margin: 0,
  padding: 0,
  color: "var(--popover-foreground)",
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "0 10px 28px rgb(0 0 0 / 0.18)",
  overflow: "hidden",
  "@media (max-width: 767px)": {
    left: 0,
    bottom: "calc(100% + 4px)",
  },
});

const listStyle = css({
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  padding: "4px",
  outline: "none",
  overflow: "auto",
  overscrollBehavior: "contain",
  userSelect: "none",
});

const labelStyle = css({
  padding: "4px",
  fontSize: "14px",
  fontWeight: 400,
});

const separatorStyle = css({
  height: "1px",
  margin: "4px -4px",
  background: "var(--border)",
  border: 0,
});

const itemStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minHeight: "32px",
  padding: "6px 8px",
  color: "var(--popover-foreground)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-sm)",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  textAlign: "left",
  cursor: "pointer",
  userSelect: "none",
  "& > svg": { flexShrink: 0 },
  "&:hover, &:focus-visible": {
    color: "var(--accent-foreground)",
    background: "var(--accent)",
  },
  "&:disabled, &[aria-disabled='true']": { pointerEvents: "none", opacity: 0.5 },
});
