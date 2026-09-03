import { css, type Handle } from "remix/ui";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/ui/components/alert-dialog.tsx";
import { Button } from "@/app/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/ui/components/dropdown-menu.tsx";
import { Field, FieldLabel } from "@/app/ui/components/field.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Input } from "@/app/ui/components/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/ui/components/table.tsx";
import {
  dialogFormStyle,
  formatSettingsDate,
  listStyle,
  sectionCopyStyle,
  sectionHeaderStyle,
  sectionHeadingStyle,
  settingsSectionStyle,
} from "@/app/ui/settings/settings-shared.ts";
import type { SettingsSecret } from "@/app/ui/settings/settings-navigation.tsx";

export function GenericSecrets(
  handle: Handle<
    { actionHref: string; csrfToken: string; dialogId: string; secrets: SettingsSecret[] }
  >,
) {
  const { actionHref, csrfToken, dialogId, secrets } = handle.props;
  return () => (
    <section aria-labelledby="secrets-heading" mix={settingsSectionStyle}>
      <header mix={sectionHeaderStyle}>
        <h2 id="secrets-heading" mix={sectionHeadingStyle}>Generic secrets</h2>
        <p mix={sectionCopyStyle}>
          Key-value secrets are encrypted with the gateway master key and stored independently from
          model provider credentials. Values are never shown again after they are saved.
        </p>
      </header>
      <section aria-label="Stored generic secrets" mix={listStyle}>
        <div mix={tableFrameStyle}>
          <header mix={tableToolbarStyle}>
            <h3 mix={tableTitleStyle}>Stored secrets</h3>
            <Button size="sm" commandFor={dialogId} command="show-modal">
              <Icon name="plus" />Add
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
                      No generic secrets configured.
                    </TableCell>
                  </TableRow>
                )
                : secrets.map((secret) => (
                  <SecretRow
                    key={secret.key}
                    actionHref={actionHref}
                    secret={secret}
                    csrfToken={csrfToken}
                  />
                ))}
            </TableBody>
          </Table>
        </div>
        <AddSecretDialog actionHref={actionHref} csrfToken={csrfToken} dialogId={dialogId} />
      </section>
    </section>
  );
}

function AddSecretDialog(
  handle: Handle<{ actionHref: string; csrfToken: string; dialogId: string }>,
) {
  const { actionHref, csrfToken, dialogId } = handle.props;
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
        <AlertDialogTitle id={titleId}>Add generic secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Store a named secret independently from model and Git credentials.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-secret" />
        <Field>
          <FieldLabel for="secret-key">Key</FieldLabel>
          <Input
            id="secret-key"
            type="text"
            name="key"
            placeholder="SERVICE_TOKEN"
            required
          />
        </Field>
        <Field>
          <FieldLabel for="secret-value">Secret value</FieldLabel>
          <Input
            id="secret-value"
            type="password"
            name="value"
            autoComplete="off"
            required
          />
        </Field>
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit">Save secret</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function SecretRow(
  handle: Handle<{ actionHref: string; secret: SettingsSecret; csrfToken: string }>,
) {
  const { actionHref, secret, csrfToken } = handle.props;
  const editDialogId = `${handle.id}-edit`;
  const deleteDialogId = `${handle.id}-delete`;

  return () => (
    <TableRow>
      <TableCell>
        <strong mix={secretIdentityStyle}>{secret.key}</strong>
      </TableCell>
      <TableCell>
        <time dateTime={secret.updatedAt} mix={dateStyle}>
          {formatSettingsDate(secret.updatedAt)}
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
          actionHref={actionHref}
          secret={secret}
          csrfToken={csrfToken}
          dialogId={editDialogId}
        />
        <DeleteSecretDialog
          actionHref={actionHref}
          secret={secret}
          csrfToken={csrfToken}
          dialogId={deleteDialogId}
        />
      </TableCell>
    </TableRow>
  );
}

function EditSecretDialog(
  handle: Handle<{
    actionHref: string;
    secret: SettingsSecret;
    csrfToken: string;
    dialogId: string;
  }>,
) {
  const { actionHref, secret, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Edit generic secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Replace the stored value for{" "}
          <strong>{secret.key}</strong>. The new value will be encrypted and cannot be shown again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-secret" />
        <input type="hidden" name="key" value={secret.key} />
        <Field>
          <FieldLabel for={`${dialogId}-value`}>New secret value</FieldLabel>
          <Input
            id={`${dialogId}-value`}
            type="password"
            name="value"
            autoComplete="off"
            required
          />
        </Field>
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit">Save changes</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function DeleteSecretDialog(
  handle: Handle<{
    actionHref: string;
    secret: SettingsSecret;
    csrfToken: string;
    dialogId: string;
  }>,
) {
  const { actionHref, secret, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete generic secret?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This will permanently delete <strong>{secret.key}</strong>. This action cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete-secret" />
        <input type="hidden" name="key" value={secret.key} />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete secret</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

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
  width: "144px",
  minWidth: "144px",
  textAlign: "left",
});
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
