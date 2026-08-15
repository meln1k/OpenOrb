import { css, type Handle, type Props } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";

export type InputProps = Props<"input">;

export function Input(handle: Handle<InputProps>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <input {...props} data-slot="input" mix={[inputStyle, mix]} />;
  };
}

const inputStyle = css({
  width: "100%",
  height: "36px",
  minWidth: 0,
  padding: "4px 12px",
  color: "var(--foreground)",
  background: "transparent",
  border: "1px solid var(--input)",
  borderRadius: "var(--radius-md)",
  boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
  outline: "none",
  font: "inherit",
  fontSize: "16px",
  transition: "color 150ms ease, box-shadow 150ms ease, border-color 150ms ease",
  "&::selection": {
    color: "var(--primary-foreground)",
    background: "var(--primary)",
  },
  "&::placeholder": { color: "var(--muted-foreground)" },
  "&::file-selector-button": {
    display: "inline-flex",
    height: "28px",
    padding: 0,
    color: "var(--foreground)",
    background: "transparent",
    border: 0,
    font: "inherit",
    fontSize: "14px",
    fontWeight: 500,
  },
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
  "&:disabled": {
    pointerEvents: "none",
    cursor: "not-allowed",
    opacity: 0.5,
  },
  "&[aria-invalid='true']": {
    borderColor: "var(--destructive)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)",
  },
  "@media (prefers-color-scheme: dark)": {
    background: "color-mix(in oklab, var(--input) 30%, transparent)",
    "&[aria-invalid='true']": {
      boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent)",
    },
  },
  [media.md]: { fontSize: "14px" },
});
