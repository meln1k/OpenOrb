import { css, type Handle, type RemixNode } from "remix/ui";

import { Document } from "./document.tsx";

const FONT_STACK =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export interface AuthPageProps {
  csrfToken: string;
  error?: string;
}

export function AuthDocument(
  handle: Handle<{ title: string; eyebrow: string; heading: string; children?: RemixNode }>,
) {
  return () => (
    <Document title={handle.props.title}>
      <main
        mix={css({
          "--background": "#0b1020",
          "--border": "#27304a",
          "--muted": "#9da8c4",
          "--panel": "#141b30",
          "--success": "#72e0a7",
          "--text": "#f3f6ff",
          minHeight: "100vh",
          padding: "clamp(32px, 8vw, 96px) 24px",
          background:
            "radial-gradient(circle at top right, #1c3154 0, transparent 38%), var(--background)",
          color: "var(--text)",
          fontFamily: FONT_STACK,
          lineHeight: 1.5,
          "& *, & *::before, & *::after": { boxSizing: "border-box" },
        })}
      >
        <section
          aria-labelledby="auth-heading"
          mix={css({
            width: "min(100%, 480px)",
            margin: "0 auto",
            padding: "clamp(28px, 6vw, 48px)",
            background: "color-mix(in srgb, var(--panel) 94%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: "22px",
          })}
        >
          <p mix={eyebrowStyle}>{handle.props.eyebrow}</p>
          <h1 id="auth-heading" mix={headingStyle}>
            {handle.props.heading}
          </h1>
          {handle.props.children}
        </section>
      </main>
    </Document>
  );
}

export function AuthCopy(handle: Handle<{ children?: RemixNode }>) {
  return () => <p mix={copyStyle}>{handle.props.children}</p>;
}

export function AuthForm(
  handle: Handle<{
    action: string;
    csrfToken: string;
    error?: string;
    submitLabel: string;
    children?: RemixNode;
  }>,
) {
  return () => (
    <form method="post" action={handle.props.action} mix={formStyle}>
      <AuthError message={handle.props.error} />
      {handle.props.children}
      <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
      <button type="submit" mix={buttonStyle}>
        {handle.props.submitLabel}
      </button>
    </form>
  );
}

export function AuthPasswordField(
  handle: Handle<{ label: string; name: string; autoComplete: string }>,
) {
  return () => (
    <label mix={labelStyle}>
      {handle.props.label}
      <input
        type="password"
        name={handle.props.name}
        autoComplete={handle.props.autoComplete}
        required
        mix={inputStyle}
      />
    </label>
  );
}

export function AuthFootnote(handle: Handle<{ children?: RemixNode }>) {
  return () => <p mix={footnoteStyle}>{handle.props.children}</p>;
}

function AuthError(handle: Handle<{ message?: string }>) {
  return () =>
    handle.props.message
      ? (
        <p role="alert" mix={errorStyle}>
          {handle.props.message}
        </p>
      )
      : null;
}

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
  fontSize: "clamp(32px, 8vw, 48px)",
  letterSpacing: "-0.045em",
  lineHeight: 1,
});

const copyStyle = css({ margin: "20px 0 0", color: "var(--muted)" });
const formStyle = css({ display: "grid", gap: "18px", marginTop: "32px" });
const labelStyle = css({ display: "grid", gap: "8px", fontWeight: 650, fontSize: "14px" });

const inputStyle = css({
  width: "100%",
  padding: "13px 14px",
  color: "var(--text)",
  background: "#0d1428",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  font: "inherit",
});

const buttonStyle = css({
  padding: "13px 16px",
  color: "#08121a",
  background: "var(--success)",
  border: 0,
  borderRadius: "10px",
  font: "inherit",
  fontWeight: 750,
  cursor: "pointer",
});

const errorStyle = css({
  margin: 0,
  padding: "12px 14px",
  color: "#ffd2d2",
  background: "#4c202d",
  border: "1px solid #8b3d4f",
  borderRadius: "10px",
});

const footnoteStyle = css({ margin: "24px 0 0", color: "var(--muted)", fontSize: "13px" });
