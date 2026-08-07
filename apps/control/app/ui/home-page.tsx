import { css, type Handle } from "remix/ui";

import { Document } from "./document.tsx";

const FONT_STACK =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export function HomePage() {
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
          fontFamily: FONT_STACK,
          lineHeight: 1.5,
          "& *, & *::before, & *::after": { boxSizing: "border-box" },
        })}
      >
        <div mix={css({ margin: "0 auto", maxWidth: "960px" })}>
          <header mix={css({ marginBottom: "56px", maxWidth: "720px" })}>
            <p
              mix={css({
                margin: "0 0 16px",
                color: "var(--success)",
                fontSize: "13px",
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              })}
            >
              Runnable development baseline
            </p>
            <h1
              mix={css({
                margin: 0,
                fontSize: "clamp(42px, 9vw, 76px)",
                letterSpacing: "-0.055em",
                lineHeight: 0.98,
              })}
            >
              OpenOrb control
            </h1>
            <p
              mix={css({
                margin: "24px 0 0",
                color: "var(--muted)",
                fontSize: "clamp(17px, 3vw, 21px)",
                maxWidth: "640px",
              })}
            >
              Self-hosted control for Pi coding-agent sessions on spare, user-owned compute.
            </p>
          </header>

          <section
            aria-label="Development process status"
            mix={css({
              display: "grid",
              gap: "16px",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            })}
          >
            <StatusCard
              label="Control process"
              value="Healthy"
              detail="Remix 3 request path ready"
            />
            <StatusCard
              label="Runner"
              value="Development harness"
              detail="Prerequisite checks only"
            />
            <StatusCard label="Current scope" value="OO-001" detail="No simulated sessions" />
          </section>

          <footer
            mix={css({
              marginTop: "48px",
              paddingTop: "24px",
              borderTop: "1px solid var(--border)",
              color: "var(--muted)",
              fontSize: "14px",
            })}
          >
            Process health: <code mix={codeStyle}>GET /healthz</code>
          </footer>
        </div>
      </main>
    </Document>
  );
}

function StatusCard(handle: Handle<{ label: string; value: string; detail: string }>) {
  return () => (
    <article
      mix={css({
        minHeight: "154px",
        padding: "24px",
        background: "color-mix(in srgb, var(--panel) 92%, transparent)",
        border: "1px solid var(--border)",
        borderRadius: "18px",
      })}
    >
      <p
        mix={css({
          margin: "0 0 16px",
          color: "var(--muted)",
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        })}
      >
        {handle.props.label}
      </p>
      <p mix={css({ margin: 0, fontSize: "20px", fontWeight: 700 })}>{handle.props.value}</p>
      <p mix={css({ margin: "8px 0 0", color: "var(--muted)", fontSize: "14px" })}>
        {handle.props.detail}
      </p>
    </article>
  );
}

const codeStyle = css({
  padding: "3px 7px",
  color: "var(--text)",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
});
