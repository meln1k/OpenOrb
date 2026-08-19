import { css } from "remix/ui";

export function formatSettingsDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export const settingsSectionStyle = css({ display: "grid", gap: "24px", minWidth: 0 });
export const sectionHeaderStyle = css({
  display: "grid",
  gap: "6px",
  paddingBottom: "16px",
  borderBottom: "1px solid var(--border)",
});
export const sectionHeadingStyle = css({
  margin: 0,
  fontSize: "22px",
  fontWeight: 600,
  letterSpacing: "-0.02em",
});
export const sectionCopyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});
export const configurationStatusStyle = css({
  color: "var(--muted-foreground)",
  fontSize: "13px",
});
export const dialogFormStyle = css({ display: "grid", gap: "20px" });

export const listStyle = css({ display: "grid" });
