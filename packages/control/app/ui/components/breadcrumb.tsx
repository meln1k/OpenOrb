import { css, type Handle, type Props } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";

export function Breadcrumb(handle: Handle<Props<"nav">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <nav {...props} aria-label="Breadcrumb" data-slot="breadcrumb" mix={mix} />;
  };
}

export function BreadcrumbList(handle: Handle<Props<"ol">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <ol {...props} data-slot="breadcrumb-list" mix={[listStyle, mix]} />;
  };
}

export function BreadcrumbItem(handle: Handle<Props<"li">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <li {...props} data-slot="breadcrumb-item" mix={[itemStyle, mix]} />;
  };
}

export function BreadcrumbLink(handle: Handle<Props<"a">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <a {...props} data-slot="breadcrumb-link" mix={[linkStyle, mix]} />;
  };
}

export function BreadcrumbPage(handle: Handle<Props<"span">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <span
        {...props}
        aria-current="page"
        data-slot="breadcrumb-page"
        mix={[pageStyle, mix]}
      />
    );
  };
}

export function BreadcrumbSeparator(handle: Handle<Props<"li">>) {
  return () => {
    const { children, mix, ...props } = handle.props;
    return (
      <li
        {...props}
        role="presentation"
        aria-hidden="true"
        data-slot="breadcrumb-separator"
        mix={[separatorStyle, mix]}
      >
        {children ?? <span>›</span>}
      </li>
    );
  };
}

const listStyle = css({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  minWidth: 0,
  margin: 0,
  padding: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  listStyle: "none",
  overflowWrap: "anywhere",
  [media.sm]: { gap: "10px" },
});
const itemStyle = css({ display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 });
const linkStyle = css({
  color: "inherit",
  textDecoration: "none",
  transition: "color 150ms ease",
  "&:hover": { color: "var(--foreground)" },
  "&:focus-visible": {
    color: "var(--foreground)",
    borderRadius: "var(--radius-sm)",
    outline: "2px solid var(--ring)",
    outlineOffset: "3px",
  },
});
const pageStyle = css({ color: "var(--foreground)", fontWeight: 400 });
const separatorStyle = css({ color: "var(--muted-foreground)", fontSize: "18px", lineHeight: 1 });
