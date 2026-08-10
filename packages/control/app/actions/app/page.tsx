import { css, type Handle } from "remix/ui";

import { routes } from "../../routes.ts";
import { AppShell, navLinkStyle } from "../../ui/shell.tsx";

export interface DashboardPageProps {
  csrfToken: string;
  credentialCount: number;
}

export function DashboardPage(handle: Handle<DashboardPageProps>) {
  return () => (
    <AppShell
      title="OpenOrb control"
      eyebrow="Authenticated control panel"
      heading="OpenOrb control"
      copy="Your admin shell is ready for projects, runners, and sessions."
      actions={
        <>
          <a href={routes.app.credentials.index.href()} mix={navLinkStyle}>
            Credentials
          </a>
          <form method="post" action={routes.auth.logout.href()}>
            <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
            <button type="submit" mix={logoutStyle}>
              Log out
            </button>
          </form>
        </>
      }
    >
      <section aria-label="Control panel status" mix={cardGridStyle}>
        <StatusCard label="Authentication" value="Protected" detail="Password session active" />
        <StatusCard
          label="Provider credentials"
          value={handle.props.credentialCount > 0
            ? `${handle.props.credentialCount} configured`
            : "Not configured"}
          detail={handle.props.credentialCount > 0
            ? "API keys encrypted at rest"
            : "Provider API keys required before sessions"}
        />
        <StatusCard
          label="Next step"
          value="Projects"
          detail="Configuration arrives in OO-004"
        />
        <StatusCard label="Current scope" value="OO-003" detail="Encrypted provider credentials" />
      </section>
    </AppShell>
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
