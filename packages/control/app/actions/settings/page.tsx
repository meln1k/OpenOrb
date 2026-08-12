import { css, type Handle } from "remix/ui";

import type { SecretEntry } from "../../data/secret-repository.ts";
import { routes } from "../../routes.ts";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  designSystemStyle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Icon,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/components/index.ts";
import { Document } from "../../ui/document.tsx";
import { media } from "../../ui/responsive.ts";

export interface SettingsPageProps {
  csrfToken: string;
  secrets: SecretEntry[];
  error?: string;
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  const { csrfToken, secrets, error } = handle.props;
  const addSecretDialogId = `${handle.id}-add-secret`;

  return () => (
    <Document title="Settings">
      <div mix={[designSystemStyle, settingsPageStyle]}>
        <main aria-label="Settings" mix={settingsDialogStyle}>
          <header mix={dialogHeaderStyle}>
            <div mix={dialogTitleStyle}>
              <h1 mix={pageHeadingStyle}>Settings</h1>
              <p mix={pageCopyStyle}>Manage control-panel configuration and secrets.</p>
            </div>
            <a href={routes.app.index.href()} aria-label="Close settings" mix={closeButtonStyle}>
              <Icon name="x" size={18} />
            </a>
          </header>
          <div mix={settingsLayoutStyle}>
            <aside aria-label="Settings navigation" mix={settingsSidebarStyle}>
              <nav>
                <a
                  href={`${routes.app.settings.index.href()}#secrets`}
                  aria-current="page"
                  mix={settingsNavLinkStyle}
                >
                  <Icon name="secrets" />
                  Secrets
                </a>
              </nav>
            </aside>

            <section
              id="secrets"
              aria-labelledby="secrets-heading"
              mix={settingsContentStyle}
            >
              <header mix={sectionHeaderStyle}>
                <h2 id="secrets-heading" mix={sectionHeadingStyle}>Secrets</h2>
                <p mix={sectionCopyStyle}>
                  Provider API keys are encrypted with the control-panel master key and are never
                  shown again after they are saved.
                </p>
              </header>

              {error
                ? (
                  <p role="alert" mix={errorStyle}>
                    {error}
                  </p>
                )
                : null}

              <section aria-label="Stored provider secrets" mix={listStyle}>
                <div mix={tableFrameStyle}>
                  <header mix={tableToolbarStyle}>
                    <h3 mix={tableTitleStyle}>Stored secrets</h3>
                    <Button size="sm" commandFor={addSecretDialogId} command="show-modal">
                      <Icon name="plus" />
                      Add
                    </Button>
                  </header>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Secret</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead mix={actionsHeadStyle}>
                          <span mix={screenReaderOnlyStyle}>Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {secrets.length === 0
                        ? (
                          <TableRow>
                            <TableCell colSpan={3} mix={emptyCellStyle}>
                              No secrets configured.
                            </TableCell>
                          </TableRow>
                        )
                        : secrets.map((secret) => (
                          <SecretRow
                            key={secret.key}
                            secret={secret}
                            csrfToken={csrfToken}
                          />
                        ))}
                    </TableBody>
                  </Table>
                </div>
                <AddSecretDialog
                  csrfToken={csrfToken}
                  dialogId={addSecretDialogId}
                />
              </section>
            </section>
          </div>
        </main>
      </div>
    </Document>
  );
}

function AddSecretDialog(
  handle: Handle<{ csrfToken: string; dialogId: string }>,
) {
  const { csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog
      id={dialogId}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Add provider secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Use the environment variable expected by the provider, such as OPENCODE_API_KEY.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={routes.app.settings.action.href()} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save" />
        <Field>
          <FieldLabel for="secret-key">Key</FieldLabel>
          <Input
            id="secret-key"
            type="text"
            name="key"
            placeholder="OPENCODE_API_KEY"
            required
          />
        </Field>
        <Field>
          <FieldLabel for="secret-value">API key</FieldLabel>
          <Input
            id="secret-value"
            type="password"
            name="value"
            autoComplete="off"
            required
          />
        </Field>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            commandFor={dialogId}
            command="close"
          >
            Cancel
          </Button>
          <Button type="submit">Save secret</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function SecretRow(
  handle: Handle<{ secret: SecretEntry; csrfToken: string }>,
) {
  const { secret, csrfToken } = handle.props;
  const editDialogId = `${handle.id}-edit`;
  const deleteDialogId = `${handle.id}-delete`;

  return () => (
    <TableRow>
      <TableCell>
        <strong mix={secretIdentityStyle}>{secret.key}</strong>
      </TableCell>
      <TableCell>
        <time dateTime={secret.updatedAt} mix={dateStyle}>
          {formatSecretDate(secret.updatedAt)}
        </time>
      </TableCell>
      <TableCell mix={actionsCellStyle}>
        <DropdownMenu mix={rowMenuStyle}>
          <DropdownMenuTrigger
            aria-label={`Open actions for ${secret.key}`}
            mix={rowMenuTriggerStyle}
          >
            <Icon name="more-horizontal" />
          </DropdownMenuTrigger>
          <DropdownMenuContent mix={rowMenuContentStyle}>
            <DropdownMenuItem commandFor={editDialogId} command="show-modal">
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              commandFor={deleteDialogId}
              command="show-modal"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <EditSecretDialog
          secret={secret}
          csrfToken={csrfToken}
          dialogId={editDialogId}
        />
        <DeleteSecretDialog
          secret={secret}
          csrfToken={csrfToken}
          dialogId={deleteDialogId}
        />
      </TableCell>
    </TableRow>
  );
}

function EditSecretDialog(
  handle: Handle<{ secret: SecretEntry; csrfToken: string; dialogId: string }>,
) {
  const { secret, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Edit secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Replace the stored value for{" "}
          <strong>{secret.key}</strong>. The new value will be encrypted and cannot be shown again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={routes.app.settings.action.href()} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="key" value={secret.key} />
        <Field>
          <FieldLabel for={`${dialogId}-value`}>New API key</FieldLabel>
          <Input
            id={`${dialogId}-value`}
            type="password"
            name="value"
            autoComplete="off"
            required
          />
        </Field>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            commandFor={dialogId}
            command="close"
          >
            Cancel
          </Button>
          <Button type="submit">Save changes</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function DeleteSecretDialog(
  handle: Handle<{ secret: SecretEntry; csrfToken: string; dialogId: string }>,
) {
  const { secret, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete secret?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This will permanently delete <strong>{secret.key}</strong>. This action cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={routes.app.settings.action.href()}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="key" value={secret.key} />
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            commandFor={dialogId}
            command="close"
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete secret</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function formatSecretDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

const settingsPageStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  minHeight: "100svh",
  padding: "16px",
  color: "var(--foreground)",
  background: "var(--muted)",
  fontFamily: "var(--font-sans)",
  [media.md]: { padding: "32px" },
});
const settingsDialogStyle = css({
  display: "flex",
  flexDirection: "column",
  width: "min(1120px, 100%)",
  minHeight: "min(760px, calc(100svh - 32px))",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 24px 80px rgb(0 0 0 / 0.18)",
  [media.md]: {
    minHeight: "min(760px, calc(100svh - 64px))",
  },
});
const dialogHeaderStyle = css({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "24px",
  padding: "24px",
  borderBottom: "1px solid var(--border)",
});
const dialogTitleStyle = css({ display: "grid", gap: "6px" });
const pageHeadingStyle = css({
  margin: 0,
  fontSize: "24px",
  fontWeight: 650,
  letterSpacing: "-0.03em",
  lineHeight: 1.15,
});
const pageCopyStyle = css({ margin: 0, color: "var(--muted-foreground)", fontSize: "14px" });
const closeButtonStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: "36px",
  height: "36px",
  color: "var(--muted-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  textDecoration: "none",
  "&:hover": { color: "var(--foreground)", background: "var(--accent)" },
  "&:focus-visible": {
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
});
const settingsLayoutStyle = css({
  display: "grid",
  gap: "32px",
  width: "100%",
  padding: "24px",
  [media.md]: { gridTemplateColumns: "200px minmax(0, 1fr)", gap: "48px" },
});
const settingsSidebarStyle = css({
  minWidth: 0,
  [media.md]: { alignSelf: "start", position: "sticky", top: 0 },
});
const settingsNavLinkStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minHeight: "36px",
  padding: "8px 12px",
  color: "var(--accent-foreground)",
  background: "var(--accent)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  fontSize: "14px",
  fontWeight: 500,
  textDecoration: "none",
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--ring)" },
  "& svg": { flexShrink: 0 },
});
const settingsContentStyle = css({ display: "grid", gap: "24px", minWidth: 0 });
const sectionHeaderStyle = css({
  display: "grid",
  gap: "6px",
  paddingBottom: "16px",
  borderBottom: "1px solid var(--border)",
});
const sectionHeadingStyle = css({
  margin: 0,
  fontSize: "22px",
  fontWeight: 600,
  letterSpacing: "-0.02em",
});
const sectionCopyStyle = css({ margin: 0, color: "var(--muted-foreground)", fontSize: "14px" });
const listStyle = css({ display: "grid" });
const tableFrameStyle = css({
  position: "relative",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
});
const tableToolbarStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "16px",
  minHeight: "56px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
});
const tableTitleStyle = css({ margin: 0, fontSize: "14px", fontWeight: 600 });
const emptyCellStyle = css({
  height: "96px",
  color: "var(--muted-foreground)",
  textAlign: "center",
});
const secretIdentityStyle = css({
  display: "block",
  minWidth: 0,
  overflow: "hidden",
  fontWeight: 500,
  textOverflow: "ellipsis",
});
const dateStyle = css({ color: "var(--muted-foreground)", fontSize: "13px" });
const actionsHeadStyle = css({ width: "52px", textAlign: "right" });
const actionsCellStyle = css({ position: "relative", width: "52px", textAlign: "right" });
const rowMenuStyle = css({ display: "inline-block", width: "fit-content", textAlign: "left" });
const rowMenuTriggerStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "32px",
  height: "32px",
  color: "var(--muted-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  "&:hover": { color: "var(--foreground)", background: "var(--accent)" },
  "&:focus-visible": { boxShadow: "0 0 0 2px var(--ring)" },
});
const rowMenuContentStyle = css({
  inset: "calc(100% + 4px) 0 auto auto",
  width: "144px",
  minWidth: "144px",
  textAlign: "left",
  [media.md]: { inset: "calc(100% + 4px) 0 auto auto" },
});
const dialogFormStyle = css({ display: "grid", gap: "20px" });
const screenReaderOnlyStyle = css({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
});
const errorStyle = css({
  margin: 0,
  padding: "12px 14px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 8%, var(--background))",
  border: "1px solid color-mix(in oklab, var(--destructive) 30%, var(--border))",
  borderRadius: "var(--radius-md)",
  fontSize: "14px",
});
