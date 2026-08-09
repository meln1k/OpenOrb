import { css, type Handle } from "remix/ui";

import { routes } from "../../routes.ts";
import { Document } from "../../ui/document.tsx";

export interface DashboardPageProps {
  csrfToken: string;
}

export function DashboardPage(handle: Handle<DashboardPageProps>) {
  return () => (
    <Document title="OpenOrb control">
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
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          lineHeight: 1.5,
          "& *, & *::before, & *::after": { boxSizing: "border-box" },
        })}
      >
        <div mix={css({ margin: "0 auto", maxWidth: "960px" })}>
          <header
            mix={css({
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "24px",
              flexWrap: "wrap",
              marginBottom: "48px",
            })}
          >
            <div>
              <p mix={eyebrowStyle}>Authenticated control panel</p>
              <h1 mix={headingStyle}>OpenOrb control</h1>
              <p mix={copyStyle}>Your admin shell is ready for projects, runners, and sessions.</p>
            </div>
            <form method="post" action={routes.auth.logout.href()}>
              <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
              <button type="submit" mix={logoutStyle}>
                Log out
              </button>
            </form>
          </header>

          <section aria-label="Control panel status" mix={cardGridStyle}>
            <StatusCard label="Authentication" value="Protected" detail="Password session active" />
            <StatusCard
              label="Next step"
              value="Projects"
              detail="Configuration arrives in OO-004"
            />
            <StatusCard label="Current scope" value="OO-002" detail="Setup, login, and logout" />
          </section>
        </div>
      </main>
    </Document>
  );
}

function StatusCard(handle: Handle<{ label: string; value: string; detail: string }>) {
  return () => (
    <article mix={cardStyle}>
      <p mix={labelStyle}>{handle.props.label}</p>
      <p mix={valueStyle}>{handle.props.value}</p>
      <p mix={detailStyle}>{handle.props.detail}</p>
    </article>
  );
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
  fontSize: "clamp(42px, 9vw, 76px)",
  letterSpacing: "-0.055em",
  lineHeight: 0.98,
});

const copyStyle = css({ margin: "24px 0 0", color: "var(--muted)", fontSize: "18px" });
const cardGridStyle = css({
  display: "grid",
  gap: "16px",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
});
const cardStyle = css({
  padding: "24px",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "18px",
});
const labelStyle = css({
  margin: "0 0 16px",
  color: "var(--muted)",
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
});
const valueStyle = css({ margin: 0, fontSize: "20px", fontWeight: 700 });
const detailStyle = css({ margin: "8px 0 0", color: "var(--muted)", fontSize: "14px" });
const logoutStyle = css({
  padding: "11px 16px",
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  font: "inherit",
  fontWeight: 650,
  cursor: "pointer",
});
