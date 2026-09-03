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
import type {
  SettingsModelProvider,
  SettingsModelProviderOption,
} from "@/app/ui/settings/settings-navigation.tsx";

export function ModelProviders(
  handle: Handle<
    {
      actionHref: string;
      csrfToken: string;
      dialogId: string;
      providers: SettingsModelProvider[];
      providerOptions: SettingsModelProviderOption[];
    }
  >,
) {
  const { actionHref, csrfToken, dialogId, providers, providerOptions } = handle.props;
  return () => (
    <section aria-labelledby="providers-heading" mix={settingsSectionStyle}>
      <header mix={sectionHeaderStyle}>
        <h2 id="providers-heading" mix={sectionHeadingStyle}>Model providers</h2>
        <p mix={sectionCopyStyle}>
          API keys are encrypted with the gateway master key and associated with a Pi model
          provider. They are never shown again after they are saved.
        </p>
      </header>
      <section aria-label="Configured model providers" mix={listStyle}>
        <div mix={tableFrameStyle}>
          <header mix={tableToolbarStyle}>
            <h3 mix={tableTitleStyle}>Configured providers</h3>
            <Button size="sm" commandFor={dialogId} command="show-modal">
              <Icon name="plus" />Add
            </Button>
          </header>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead mix={actionsHeadStyle}>
                  <span mix={screenReaderOnlyStyle}>Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.length === 0
                ? (
                  <TableRow>
                    <TableCell colSpan={3} mix={emptyCellStyle}>
                      No model providers configured.
                    </TableCell>
                  </TableRow>
                )
                : providers.map((provider) => (
                  <ProviderRow
                    key={provider.providerId}
                    actionHref={actionHref}
                    provider={provider}
                    csrfToken={csrfToken}
                  />
                ))}
            </TableBody>
          </Table>
        </div>
        <AddProviderDialog
          actionHref={actionHref}
          csrfToken={csrfToken}
          dialogId={dialogId}
          providerOptions={providerOptions}
        />
      </section>
    </section>
  );
}

function AddProviderDialog(
  handle: Handle<{
    actionHref: string;
    csrfToken: string;
    dialogId: string;
    providerOptions: SettingsModelProviderOption[];
  }>,
) {
  const { actionHref, csrfToken, dialogId, providerOptions } = handle.props;
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
        <AlertDialogTitle id={titleId}>Configure model provider</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Choose a provider supported by Pi and save its API key.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-provider" />
        <Field>
          <FieldLabel for="model-provider">Provider</FieldLabel>
          <select id="model-provider" name="providerId" required mix={providerSelectStyle}>
            {providerOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel for="provider-api-key">API key</FieldLabel>
          <Input
            id="provider-api-key"
            type="password"
            name="apiKey"
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
          <Button type="submit">Save provider</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function ProviderRow(
  handle: Handle<{
    actionHref: string;
    provider: SettingsModelProvider;
    csrfToken: string;
  }>,
) {
  const { actionHref, provider, csrfToken } = handle.props;
  const editDialogId = `${handle.id}-edit`;
  const deleteDialogId = `${handle.id}-delete`;

  return () => (
    <TableRow>
      <TableCell>
        <strong mix={secretIdentityStyle}>{provider.name}</strong>
        <code mix={providerIdStyle}>{provider.providerId}</code>
      </TableCell>
      <TableCell>
        <time dateTime={provider.updatedAt} mix={dateStyle}>
          {formatSettingsDate(provider.updatedAt)}
        </time>
      </TableCell>
      <TableCell mix={actionsCellStyle}>
        <DropdownMenu mix={rowMenuStyle}>
          <DropdownMenuTrigger
            aria-label={`Open actions for ${provider.name}`}
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
        <EditProviderDialog
          actionHref={actionHref}
          provider={provider}
          csrfToken={csrfToken}
          dialogId={editDialogId}
        />
        <DeleteProviderDialog
          actionHref={actionHref}
          provider={provider}
          csrfToken={csrfToken}
          dialogId={deleteDialogId}
        />
      </TableCell>
    </TableRow>
  );
}

function EditProviderDialog(
  handle: Handle<{
    actionHref: string;
    provider: SettingsModelProvider;
    csrfToken: string;
    dialogId: string;
  }>,
) {
  const { actionHref, provider, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Update provider key</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Replace the stored API key for{" "}
          <strong>{provider.name}</strong>. The new value will be encrypted and cannot be shown
          again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-provider" />
        <input type="hidden" name="providerId" value={provider.providerId} />
        <Field>
          <FieldLabel for={`${dialogId}-value`}>New API key</FieldLabel>
          <Input
            id={`${dialogId}-value`}
            type="password"
            name="apiKey"
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

function DeleteProviderDialog(
  handle: Handle<{
    actionHref: string;
    provider: SettingsModelProvider;
    csrfToken: string;
    dialogId: string;
  }>,
) {
  const { actionHref, provider, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete provider credential?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This will permanently delete the API key for{" "}
          <strong>{provider.name}</strong>. This action cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete-provider" />
        <input type="hidden" name="providerId" value={provider.providerId} />
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            commandFor={dialogId}
            command="close"
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete provider</Button>
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
const providerIdStyle = css({
  display: "block",
  marginTop: "2px",
  color: "var(--muted-foreground)",
  fontSize: "12px",
});
const providerSelectStyle = css({
  width: "100%",
  minHeight: "40px",
  padding: "0 12px",
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--input)",
  borderRadius: "var(--radius-md)",
  font: "inherit",
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
