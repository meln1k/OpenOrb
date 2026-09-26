import { css } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";

export const sessionControlBaseStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  flexShrink: 0,
  height: "40px",
  padding: "0 12px",
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  boxShadow: "none",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  transition: "color 150ms ease, background-color 150ms ease, border-color 150ms ease",
  "@media (prefers-color-scheme: dark)": {
    background: "color-mix(in oklab, var(--input) 30%, transparent)",
    borderColor: "var(--input)",
  },
});

export const sessionSelectControlStyle = [
  sessionControlBaseStyle,
  css({
    cursor: "pointer",
    "&:hover": { color: "var(--accent-foreground)", background: "var(--accent)" },
    "&:focus-within": {
      borderColor: "color-mix(in oklab, var(--border) 60%, var(--foreground))",
      boxShadow: "none",
    },
    "&:has(select:disabled), &:disabled": { cursor: "not-allowed", opacity: 0.55 },
    "@media (prefers-color-scheme: dark)": {
      "&:hover": { background: "color-mix(in oklab, var(--input) 50%, transparent)" },
    },
  }),
];

export const sessionSelectorPopoverStyle = css({
  position: "fixed",
  zIndex: 70,
  display: "none",
  flexDirection: "column",
  width: "auto",
  height: "auto",
  minWidth: 0,
  maxWidth: "none !important",
  maxHeight: "none !important",
  margin: 0,
  padding: 0,
  color: "var(--popover-foreground)",
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "32px",
  boxShadow: "0 10px 28px rgb(0 0 0 / 0.18)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
  "&:popover-open": { display: "flex" },
  "&::backdrop": { background: "var(--background)" },
  [media.sm]: {
    width: "auto",
    height: "auto",
    minWidth: "260px",
    maxWidth: "calc(100vw - 32px) !important",
    maxHeight: "min(320px, calc(100dvh - 32px)) !important",
    borderRadius: "20px",
    "&::backdrop": { background: "transparent" },
  },
});

export const sessionSelectorPopoverHeaderStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "28px",
  padding: "24px 24px 28px",
  borderBottom: "1px solid var(--border)",
  [media.sm]: { display: "none" },
});

export const sessionSelectorPopoverBackStyle = css({
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  gap: "10px",
  padding: 0,
  color: "var(--muted-foreground)",
  background: "transparent",
  border: 0,
  outline: 0,
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
});

export const sessionSelectorPopoverBackIconStyle = css({
  fontSize: "28px",
  fontWeight: 300,
  lineHeight: 0.75,
});

export const sessionSelectorPopoverTitleStyle = css({
  margin: 0,
  color: "var(--foreground)",
  fontSize: "24px",
  fontWeight: 500,
  lineHeight: 1.2,
});

export const sessionSelectorListStyle = css({
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  padding: "12px",
  outline: 0,
  overflow: "auto",
  overscrollBehavior: "contain",
  userSelect: "none",
  [media.sm]: { flex: "0 1 auto", padding: "4px" },
});

export const sessionSelectorOptionStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minHeight: "60px",
  padding: "12px 16px",
  color: "var(--popover-foreground)",
  background: "transparent",
  borderRadius: "16px",
  outline: 0,
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
  "&[hidden]": { display: "none" },
  "&[data-highlighted='true']": {
    color: "var(--accent-foreground)",
    background: "var(--accent)",
  },
  "&[aria-disabled='true']": { pointerEvents: "none", opacity: 0.5 },
  "&[aria-selected='false'] [data-slot='selector-option-indicator']": {
    visibility: "hidden",
  },
  [media.sm]: {
    minHeight: "32px",
    padding: "6px 8px",
    borderRadius: "var(--radius-sm)",
    fontSize: "14px",
  },
});

export const sessionSelectorOptionIndicatorStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "16px",
  height: "16px",
  flexShrink: 0,
  marginLeft: "auto",
});
