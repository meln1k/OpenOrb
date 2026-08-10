import { css, type Handle, type RemixNode } from "remix/ui";

import { Document } from "./document.tsx";

const FONT_STACK =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export interface AppShellProps {
  title: string;
  eyebrow: string;
  heading: string;
  copy?: string;
  /** Right-aligned header content, such as navigation and forms. */
  actions?: RemixNode;
  children?: RemixNode;
}

export function AppShell(handle: Handle<AppShellProps>) {
  return () => (
    <Document title={handle.props.title}>
      <main mix={mainStyle}>
        <div mix={css({ margin: "0 auto", maxWidth: "960px" })}>
          <header mix={headerStyle}>
            <div>
              <p mix={eyebrowStyle}>{handle.props.eyebrow}</p>
              <h1 mix={headingStyle}>{handle.props.heading}</h1>
              {handle.props.copy ? <p mix={copyStyle}>{handle.props.copy}</p> : null}
            </div>
            {handle.props.actions ? <div mix={actionsStyle}>{handle.props.actions}</div> : null}
          </header>
          {handle.props.children}
        </div>
      </main>
    </Document>
  );
}

export const navLinkStyle = css({
  display: "inline-flex",
  alignItems: "center",
  padding: "11px 16px",
  color: "var(--text)",
  textDecoration: "none",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  font: "inherit",
  fontWeight: 650,
});

const mainStyle = css({
  "--background": "#0b1020",
  "--border": "#27304a",
  "--muted": "#9da8c4",
  "--panel": "#141b30",
  "--success": "#72e0a7",
  "--text": "#f3f6ff",
  minHeight: "100vh",
  padding: "clamp(32px, 8vw, 96px) 24px",
  background: "radial-gradient(circle at top right, #1c3154 0, transparent 38%), var(--background)",
  color: "var(--text)",
  fontFamily: FONT_STACK,
  lineHeight: 1.5,
  "& *, & *::before, & *::after": { boxSizing: "border-box" },
});

const headerStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "24px",
  flexWrap: "wrap",
  marginBottom: "48px",
});

const eyebrowStyle = css({
  margin: "0 0 16px",
  color: "var(--success)",
  fontSize: "13px",
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
});

const headingStyle = css({
  margin: 0,
  fontSize: "clamp(42px, 9vw, 76px)",
  letterSpacing: "-0.055em",
  lineHeight: 0.98,
});

const copyStyle = css({ margin: "24px 0 0", color: "var(--muted)", fontSize: "18px" });

const actionsStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "12px",
  flexWrap: "wrap",
});
