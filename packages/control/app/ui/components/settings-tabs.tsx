import { clientEntry, css, type Handle, on } from "remix/ui";
import {
  Tab as TabsTrigger,
  TabList as TabsList,
  TabPanel as TabsContent,
  Tabs,
} from "remix/ui/tabs";

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
import { Field, FieldDescription, FieldLabel } from "@/app/ui/components/field.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Input } from "@/app/ui/components/input.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemFooter,
  ItemTitle,
} from "@/app/ui/components/item.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/ui/components/table.tsx";
import { media } from "@/app/ui/responsive.ts";

export type SettingsTab = "secrets" | "github" | "git-author" | "runners";

export type SettingsSecret = {
  key: string;
  updatedAt: string;
};

export type SettingsGitHubCredential = {
  updatedAt: string;
};

export type SettingsGitAuthor = {
  authorEmail: string;
  authorName: string;
  updatedAt: string;
};

export type SettingsEnrollmentCommand = {
  command: string;
};

export type SettingsTabHrefs = Record<SettingsTab, string>;

export type SettingsTabsProps = {
  activeTab: SettingsTab;
  csrfToken: string;
  enrollmentCommand: SettingsEnrollmentCommand;
  error?: string;
  gitAuthor: SettingsGitAuthor | null;
  githubCredential: SettingsGitHubCredential | null;
  hrefs: SettingsTabHrefs;
  secrets: SettingsSecret[];
};

export const SettingsTabs = clientEntry<SettingsTabsProps>(
  import.meta.url,
  function SettingsTabs(handle: Handle<SettingsTabsProps>) {
    let activeTab = handle.props.activeTab;
    let authorEmail = handle.props.gitAuthor?.authorEmail ?? "";
    let authorName = handle.props.gitAuthor?.authorName ?? "";
    const addSecretDialogId = `${handle.id}-add-secret`;
    const githubDialogId = `${handle.id}-github-token`;
    const deleteGithubDialogId = `${handle.id}-delete-github-token`;
    const gitAuthorFormId = `${handle.id}-git-author-form`;

    const captureGitAuthorDraft = () => {
      const form = globalThis.document.getElementById(gitAuthorFormId);
      if (!(form instanceof HTMLFormElement)) return;

      const formData = new FormData(form);
      authorName = formData.get("authorName")?.toString() ?? "";
      authorEmail = formData.get("authorEmail")?.toString() ?? "";
    };

    handle.queueTask(() => {
      const onPopState = () => {
        const nextTab = tabForCurrentUrl(handle.props.hrefs);
        if (!nextTab || nextTab === activeTab) return;
        captureGitAuthorDraft();
        activeTab = nextTab;
        void handle.update();
      };

      globalThis.addEventListener("popstate", onPopState);
      handle.signal.addEventListener(
        "abort",
        () => globalThis.removeEventListener("popstate", onPopState),
        { once: true },
      );
    });

    return () => {
      const {
        csrfToken,
        enrollmentCommand,
        error,
        gitAuthor,
        githubCredential,
        hrefs,
        secrets,
      } = handle.props;

      return (
        <Tabs
          activeTab={activeTab}
          data-slot="tabs"
          mix={tabsRootStyle}
          onActiveTabChange={(nextTab) => {
            captureGitAuthorDraft();
            activeTab = nextTab as SettingsTab;
            const href = hrefs[activeTab];
            if (href) globalThis.history.pushState(null, "", href);
            void handle.update();
          }}
        >
          <TabsList
            aria-label="Settings sections"
            data-slot="tabs-list"
            data-variant="default"
            mix={tabsListStyle}
          >
            <TabsTrigger
              name="secrets"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="secrets" size={14} />
              Secrets
            </TabsTrigger>
            <TabsTrigger
              name="github"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="github" size={14} />
              GitHub
            </TabsTrigger>
            <TabsTrigger
              name="git-author"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="user" size={14} />
              Git author
            </TabsTrigger>
            <TabsTrigger
              name="runners"
              draggable={false}
              data-slot="tabs-trigger"
              mix={tabsTriggerStyle}
            >
              <Icon name="server" size={14} />
              Runners
            </TabsTrigger>
          </TabsList>

          {error
            ? (
              <p role="alert" mix={errorStyle}>
                {error}
              </p>
            )
            : null}

          <TabsContent
            name="secrets"
            data-slot="tabs-content"
            mix={tabsPanelStyle}
          >
            <section
              aria-labelledby="secrets-heading"
              mix={settingsSectionStyle}
            >
              <header mix={sectionHeaderStyle}>
                <h2 id="secrets-heading" mix={sectionHeadingStyle}>Secrets</h2>
                <p mix={sectionCopyStyle}>
                  Provider API keys are encrypted with the control-panel master key and are never
                  shown again after they are saved.
                </p>
              </header>

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
                            actionHref={hrefs.secrets}
                            secret={secret}
                            csrfToken={csrfToken}
                          />
                        ))}
                    </TableBody>
                  </Table>
                </div>
                <AddSecretDialog
                  actionHref={hrefs.secrets}
                  csrfToken={csrfToken}
                  dialogId={addSecretDialogId}
                />
              </section>
            </section>
          </TabsContent>

          <TabsContent
            name="github"
            data-slot="tabs-content"
            mix={tabsPanelStyle}
          >
            <section
              aria-labelledby="github-heading"
              mix={settingsSectionStyle}
            >
              <header mix={sectionHeaderStyle}>
                <h2 id="github-heading" mix={sectionHeadingStyle}>GitHub credential</h2>
                <p mix={sectionCopyStyle}>
                  The token is encrypted and is never shown again after it is saved. Public projects
                  do not require one.
                </p>
              </header>
              <div mix={configurationCardStyle}>
                <div mix={configurationIdentityStyle}>
                  <strong>github.com</strong>
                  <span mix={configurationStatusStyle}>
                    {githubCredential
                      ? `Configured · updated ${formatSecretDate(githubCredential.updatedAt)}`
                      : "Not configured"}
                  </span>
                </div>
                <div mix={configurationActionsStyle}>
                  <Button
                    size="sm"
                    variant={githubCredential ? "outline" : "default"}
                    commandFor={githubDialogId}
                    command="show-modal"
                  >
                    {githubCredential ? "Replace token" : "Add token"}
                  </Button>
                  {githubCredential
                    ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        commandFor={deleteGithubDialogId}
                        command="show-modal"
                      >
                        Delete
                      </Button>
                    )
                    : null}
                </div>
              </div>
              <GitHubCredentialDialog
                actionHref={hrefs.github}
                csrfToken={csrfToken}
                dialogId={githubDialogId}
                replacing={Boolean(githubCredential)}
              />
              {githubCredential
                ? (
                  <DeleteGitHubCredentialDialog
                    actionHref={hrefs.github}
                    csrfToken={csrfToken}
                    dialogId={deleteGithubDialogId}
                  />
                )
                : null}
            </section>
          </TabsContent>

          <TabsContent
            name="git-author"
            data-slot="tabs-content"
            mix={tabsPanelStyle}
          >
            <section
              aria-labelledby="git-author-heading"
              mix={settingsSectionStyle}
            >
              <header mix={sectionHeaderStyle}>
                <h2 id="git-author-heading" mix={sectionHeadingStyle}>Git author</h2>
                <p mix={sectionCopyStyle}>
                  This global identity is required before a session can be provisioned and is used
                  for OpenOrb session commits.
                </p>
              </header>
              <form
                id={gitAuthorFormId}
                method="post"
                action={hrefs["git-author"]}
                mix={authorFormStyle}
              >
                <input type="hidden" name="_csrf" value={csrfToken} />
                <input type="hidden" name="intent" value="save-git-author" />
                <div mix={authorFieldsStyle}>
                  <Field>
                    <FieldLabel for="git-author-name">Name</FieldLabel>
                    <Input
                      id="git-author-name"
                      name="authorName"
                      defaultValue={authorName}
                      maxLength={200}
                      autoComplete="name"
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel for="git-author-email">Email</FieldLabel>
                    <Input
                      id="git-author-email"
                      type="email"
                      name="authorEmail"
                      defaultValue={authorEmail}
                      maxLength={254}
                      autoComplete="email"
                      required
                    />
                  </Field>
                </div>
                <div mix={authorFooterStyle}>
                  <span mix={configurationStatusStyle}>
                    {gitAuthor
                      ? `Configured · updated ${formatSecretDate(gitAuthor.updatedAt)}`
                      : "Not configured"}
                  </span>
                  <Button type="submit">Save Git author</Button>
                </div>
              </form>
            </section>
          </TabsContent>

          <TabsContent
            name="runners"
            data-slot="tabs-content"
            mix={tabsPanelStyle}
          >
            <section
              aria-labelledby="runners-heading"
              mix={settingsSectionStyle}
            >
              <header mix={sectionHeaderStyle}>
                <h2 id="runners-heading" mix={sectionHeadingStyle}>Runner enrollment</h2>
                <p mix={sectionCopyStyle}>
                  Run from your OpenOrb checkout to enroll a runner.
                </p>
              </header>
              <section aria-label="Runner enrollment command">
                <EnrollmentCommand
                  actionHref={hrefs.runners}
                  csrfToken={csrfToken}
                  enrollmentCommand={enrollmentCommand.command}
                />
              </section>
            </section>
          </TabsContent>
        </Tabs>
      );
    };
  },
);

function tabForCurrentUrl(hrefs: SettingsTabHrefs): SettingsTab | undefined {
  const currentUrl = new URL(globalThis.location.href);
  for (const name of ["secrets", "github", "git-author", "runners"] as const) {
    const tabUrl = new URL(hrefs[name], currentUrl);
    if (
      tabUrl.pathname === currentUrl.pathname &&
      tabUrl.search === currentUrl.search &&
      tabUrl.hash === currentUrl.hash
    ) {
      return name;
    }
  }
}

function EnrollmentCommand(
  handle: Handle<{ actionHref: string; csrfToken: string; enrollmentCommand: string }>,
) {
  let copyStatus: "copied" | "failed" | undefined;

  return () => (
    <Item
      variant="outline"
      size="sm"
      aria-label="Runner enrollment command"
      mix={enrollmentCommandItemStyle}
    >
      <ItemContent mix={enrollmentCommandContentStyle}>
        <ItemTitle mix={commandTitleStyle}>
          <code mix={commandValueStyle}>
            <span aria-hidden="true" mix={commandPromptStyle}>$</span>
            {handle.props.enrollmentCommand}
          </code>
        </ItemTitle>
      </ItemContent>
      <ItemActions mix={enrollmentCommandActionsStyle}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          mix={on("click", async (_event, signal) => {
            try {
              await globalThis.navigator.clipboard.writeText(handle.props.enrollmentCommand);
              copyStatus = "copied";
            } catch {
              copyStatus = "failed";
            }
            if (!signal.aborted) await handle.update();
          })}
        >
          Copy command
        </Button>
        <form method="post" action={handle.props.actionHref}>
          <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
          <input type="hidden" name="intent" value="regenerate-enrollment-token" />
          <Button type="submit" size="sm" variant="outline">
            Regenerate
          </Button>
        </form>
      </ItemActions>
      {copyStatus
        ? (
          <ItemFooter>
            <p role="status" aria-live="polite" mix={copyStatusStyle}>
              {copyStatus === "copied"
                ? "Enrollment command copied."
                : "Could not copy automatically. Select and copy the command manually."}
            </p>
          </ItemFooter>
        )
        : null}
    </Item>
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
        <AlertDialogTitle id={titleId}>Add provider secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Use the environment variable expected by the provider, such as OPENCODE_API_KEY.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
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
        <AlertDialogTitle id={titleId}>Edit secret</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          Replace the stored value for{" "}
          <strong>{secret.key}</strong>. The new value will be encrypted and cannot be shown again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
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
        <AlertDialogTitle id={titleId}>Delete secret?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This will permanently delete <strong>{secret.key}</strong>. This action cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref}>
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

const tabsRootStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  minWidth: 0,
  width: "100%",
  padding: "24px",
});
const tabsListStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "flex-start",
  flexShrink: 0,
  width: "100%",
  maxWidth: "100%",
  minHeight: "32px",
  padding: "3px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  border: 0,
  borderRadius: "var(--radius-lg)",
  boxShadow: "none",
  overflowX: "auto",
  overflowY: "hidden",
  overscrollBehaviorX: "contain",
  overscrollBehaviorY: "none",
  touchAction: "pan-x",
  userSelect: "none",
  WebkitOverflowScrolling: "touch",
  scrollbarWidth: "none",
  "&::-webkit-scrollbar": { display: "none" },
});
const tabsTriggerStyle = css({
  flex: "0 0 auto",
  gap: "6px",
  minHeight: "25px",
  padding: "2px 6px",
  color: "color-mix(in oklab, var(--foreground) 60%, transparent)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: "var(--radius-md)",
  boxShadow: "none",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1,
  textShadow: "none",
  WebkitUserDrag: "none",
  "& svg": {
    width: "16px",
    height: "16px",
    flexShrink: 0,
    pointerEvents: "none",
  },
  "&[data-state='inactive']:hover:not(:disabled):not([aria-disabled='true'])": {
    color: "var(--foreground)",
    background: "transparent",
  },
  "&[data-state='inactive']:active:not(:disabled):not([aria-disabled='true'])": {
    background: "transparent",
  },
  "&[data-state='active']": {
    "--rmx-tabs-tab-shadow": "none",
    color: "var(--foreground)",
    background: "var(--background)",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.08)",
    textShadow: "none",
  },
  "&[data-state='active']:hover:not(:disabled):not([aria-disabled='true'])": {
    background: "var(--background)",
  },
  "&[data-state='active']:active:not(:disabled):not([aria-disabled='true'])": {
    background: "var(--background)",
  },
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
});
const tabsPanelStyle = css({
  flex: "1",
  minWidth: 0,
  color: "inherit",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  lineHeight: "inherit",
});
const settingsSectionStyle = css({ display: "grid", gap: "24px", minWidth: 0 });
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
const configurationStatusStyle = css({ color: "var(--muted-foreground)", fontSize: "13px" });
const configurationActionsStyle = css({ display: "flex", flexWrap: "wrap", gap: "8px" });
const authorFormStyle = css({
  display: "grid",
  gap: "20px",
  padding: "20px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
});
const authorFieldsStyle = css({
  display: "grid",
  gap: "18px",
  [media.sm]: { gridTemplateColumns: "1fr 1fr" },
});
const authorFooterStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
  [media.sm]: { flexDirection: "row", alignItems: "center" },
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
const enrollmentCommandItemStyle = css({ flexDirection: "column", alignItems: "stretch" });
const enrollmentCommandContentStyle = css({ flexBasis: "100%" });
const enrollmentCommandActionsStyle = css({
  justifyContent: "flex-end",
  width: "100%",
  flexWrap: "wrap",
});
const commandTitleStyle = css({
  display: "block",
  width: "100%",
  overflow: "visible",
  whiteSpace: "normal",
});
const commandValueStyle = css({
  display: "block",
  width: "100%",
  overflowWrap: "anywhere",
  userSelect: "all",
  whiteSpace: "pre-wrap",
});
const commandPromptStyle = css({
  marginRight: "0.5ch",
  color: "var(--muted-foreground)",
  userSelect: "none",
});
const copyStatusStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "12px",
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
