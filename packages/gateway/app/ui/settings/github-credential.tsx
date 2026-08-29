import { css, type Handle } from "remix/ui";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/ui/components/alert-dialog.tsx";
import { Button } from "@/app/ui/components/button.tsx";
import { Field, FieldDescription, FieldLabel } from "@/app/ui/components/field.tsx";
import { Input } from "@/app/ui/components/input.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  configurationStatusStyle,
  dialogFormStyle,
  formatSettingsDate,
  sectionCopyStyle,
  sectionHeaderStyle,
  sectionHeadingStyle,
  settingsSectionStyle,
} from "@/app/ui/settings/settings-shared.ts";
import type { SettingsGitHubCredential } from "@/app/ui/settings/settings-navigation.tsx";

export function GitHubCredentialSection(
  handle: Handle<
    {
      actionHref: string;
      csrfToken: string;
      credential: SettingsGitHubCredential | null;
      dialogId: string;
      deleteDialogId: string;
    }
  >,
) {
  const { actionHref, csrfToken, credential, dialogId, deleteDialogId } = handle.props;
  return () => (
    <section aria-labelledby="github-heading" mix={settingsSectionStyle}>
      <header mix={sectionHeaderStyle}>
        <h2 id="github-heading" mix={sectionHeadingStyle}>GitHub credential</h2>
        <p mix={sectionCopyStyle}>
          The token is encrypted and is never shown again after it is saved. Public projects do not
          require one.
        </p>
      </header>
      <div mix={configurationCardStyle}>
        <div mix={configurationIdentityStyle}>
          <strong>github.com</strong>
          <span mix={configurationStatusStyle}>
            {credential
              ? `Configured · updated ${formatSettingsDate(credential.updatedAt)}`
              : "Not configured"}
          </span>
        </div>
        <div mix={configurationActionsStyle}>
          <Button
            size="sm"
            variant={credential ? "outline" : "default"}
            commandFor={dialogId}
            command="show-modal"
          >
            {credential ? "Replace token" : "Add token"}
          </Button>
          {credential
            ? (
              <Button
                size="sm"
                variant="destructive"
                commandFor={deleteDialogId}
                command="show-modal"
              >
                Delete
              </Button>
            )
            : null}
        </div>
      </div>
      <GitHubCredentialDialog
        actionHref={actionHref}
        csrfToken={csrfToken}
        dialogId={dialogId}
        replacing={Boolean(credential)}
      />
      {credential
        ? (
          <DeleteGitHubCredentialDialog
            actionHref={actionHref}
            csrfToken={csrfToken}
            dialogId={deleteDialogId}
          />
        )
        : null}
    </section>
  );
}

function GitHubCredentialDialog(
  handle: Handle<{
    actionHref: string;
    csrfToken: string;
    dialogId: string;
    replacing: boolean;
  }>,
) {
  const { actionHref, csrfToken, dialogId, replacing } = handle.props;
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
        <AlertDialogTitle id={titleId}>
          {replacing ? "Replace GitHub token" : "Add GitHub token"}
        </AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          The token is encrypted immediately and cannot be viewed again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-github-credential" />
        <Field>
          <FieldLabel for={`${dialogId}-token`}>GitHub token</FieldLabel>
          <Input
            id={`${dialogId}-token`}
            type="password"
            name="token"
            autoComplete="off"
            required
          />
          <FieldDescription>
            Use a token with access to the private repositories OpenOrb should clone and push.
          </FieldDescription>
        </Field>
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit">{replacing ? "Replace token" : "Save token"}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function DeleteGitHubCredentialDialog(
  handle: Handle<{ actionHref: string; csrfToken: string; dialogId: string }>,
) {
  const { actionHref, csrfToken, dialogId } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete GitHub token?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Private repository operations will stop working until another token is configured.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete-github-credential" />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete token</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

const configurationCardStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "16px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  [media.sm]: { flexDirection: "row", alignItems: "center" },
});
const configurationIdentityStyle = css({ display: "grid", gap: "4px", fontSize: "14px" });
const configurationActionsStyle = css({ display: "flex", flexWrap: "wrap", gap: "8px" });
