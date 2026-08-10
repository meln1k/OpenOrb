import { css, type Handle } from "remix/ui";

import type { SecretEntry } from "../../data/secret-repository.ts";
import { routes } from "../../routes.ts";
import { AppShell, navLinkStyle } from "../../ui/shell.tsx";

export interface CredentialsPageProps {
  csrfToken: string;
  secrets: SecretEntry[];
  error?: string;
}

export function CredentialsPage(handle: Handle<CredentialsPageProps>) {
  const { csrfToken, secrets, error } = handle.props;

  return () => (
    <AppShell
      title="Provider credentials"
      eyebrow="Configuration"
      heading="Provider credentials"
      copy="Provider API keys are encrypted with the control-panel master key and are never shown again after they are saved."
      actions={
        <a href={routes.app.index.href()} mix={navLinkStyle}>
          Dashboard
        </a>
      }
    >
      {error
        ? (
          <p role="alert" mix={errorStyle}>
            {error}
          </p>
        )
        : null}

      <section aria-label="Stored provider credentials" mix={listStyle}>
        {secrets.length === 0
          ? (
            <article mix={cardStyle}>
              <p mix={cardLabelStyle}>Stored credentials</p>
              <p mix={cardCopyStyle}>
                No provider credentials are configured. Save API keys such as{" "}
                <code>OPENCODE_API_KEY</code> or <code>OPENAI_API_KEY</code>.
              </p>
            </article>
          )
          : secrets.map((secret) => (
            <CredentialCard key={secret.key} secret={secret} csrfToken={csrfToken} />
          ))}
      </section>

      <form method="post" action={routes.app.credentials.action.href()} mix={formStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save" />
        <div mix={fieldGridStyle}>
          <label mix={fieldLabelStyle}>
            Key
            <input
              type="text"
              name="key"
              placeholder="OPENCODE_API_KEY"
              required
              mix={inputStyle}
            />
          </label>
          <label mix={fieldLabelStyle}>
            API key
            <input type="password" name="value" autoComplete="off" required mix={inputStyle} />
          </label>
        </div>
        <button type="submit" mix={buttonStyle}>
          Save credential
        </button>
      </form>
    </AppShell>
  );
}

function CredentialCard(
  handle: Handle<{ secret: SecretEntry; csrfToken: string }>,
) {
  const { secret, csrfToken } = handle.props;

  return () => (
    <article mix={cardStyle}>
      <dl mix={detailsStyle}>
        <div>
          <dt>Key</dt>
          <dd>{secret.key}</dd>
        </div>
        <div>
          <dt>Key version</dt>
          <dd>{secret.keyVersion}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{secret.createdAt}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{secret.updatedAt}</dd>
        </div>
      </dl>
      <form method="post" action={routes.app.credentials.action.href()} mix={rowFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="key" value={secret.key} />
        <label mix={fieldLabelStyle}>
          Replace API key
          <input type="password" name="value" autoComplete="off" required mix={inputStyle} />
        </label>
        <button type="submit" mix={buttonStyle}>
          Replace
        </button>
      </form>
      <form method="post" action={routes.app.credentials.action.href()} mix={rowFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="key" value={secret.key} />
        <button type="submit" mix={dangerButtonStyle}>
          Delete
        </button>
      </form>
    </article>
  );
}

const listStyle = css({ display: "grid", gap: "16px" });
const cardStyle = css({
  padding: "24px",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "18px",
});
const cardLabelStyle = css({
  margin: "0 0 16px",
  color: "var(--muted)",
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
});
const cardCopyStyle = css({ margin: 0, color: "var(--muted)", fontSize: "14px" });
const detailsStyle = css({
  display: "grid",
  gap: "10px 24px",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  margin: "0 0 20px",
  "& div": { display: "grid", gap: "4px" },
  "& dt": {
    color: "var(--muted)",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  "& dd": { margin: 0, fontSize: "14px", overflowWrap: "anywhere" },
});
const formStyle = css({
  display: "grid",
  gap: "18px",
  maxWidth: "480px",
  marginTop: "32px",
  padding: "24px",
  background: "color-mix(in srgb, var(--panel) 94%, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "18px",
});
const rowFormStyle = css({ display: "flex", alignItems: "end", gap: "12px", flexWrap: "wrap" });
const fieldGridStyle = css({ display: "grid", gap: "18px", gridTemplateColumns: "1fr 2fr" });
const fieldLabelStyle = css({ display: "grid", gap: "8px", fontWeight: 650, fontSize: "14px" });
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
const dangerButtonStyle = css({
  padding: "13px 16px",
  color: "#ffd2d2",
  background: "#4c202d",
  border: "1px solid #8b3d4f",
  borderRadius: "10px",
  font: "inherit",
  fontWeight: 700,
  cursor: "pointer",
});
const errorStyle = css({
  margin: "0 0 32px",
  padding: "12px 14px",
  maxWidth: "480px",
  color: "#ffd2d2",
  background: "#4c202d",
  border: "1px solid #8b3d4f",
  borderRadius: "10px",
});
