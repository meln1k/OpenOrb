import { css, type Handle } from "remix/ui";

import type { Project } from "../../data/project-repository.ts";
import { routes } from "../../routes.ts";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldDescription,
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
import { AppShell } from "../../ui/shell.tsx";
import { media } from "../../ui/responsive.ts";

export interface ProjectsPageProps {
  csrfToken: string;
  projects: Project[];
  error?: string;
}

export function ProjectsPage(handle: Handle<ProjectsPageProps>) {
  const { csrfToken, projects, error } = handle.props;
  const addDialogId = `${handle.id}-add-project`;

  return () => (
    <AppShell
      activeSection="projects"
      csrfToken={csrfToken}
      title="Projects · OpenOrb"
      eyebrow="Projects"
      heading="Projects"
      copy="Configure the GitHub repositories used to start OpenOrb sessions."
    >
      {error
        ? (
          <p role="alert" mix={errorStyle}>
            {error}
          </p>
        )
        : null}
      <section aria-label="Configured projects" mix={projectPanelStyle}>
        <header mix={panelHeaderStyle}>
          <div mix={panelTitleStyle}>
            <h2 mix={sectionHeadingStyle}>Configured projects</h2>
            <p mix={sectionCopyStyle}>
              Private repository operations automatically use the GitHub token from Settings.
            </p>
          </div>
          <Button commandFor={addDialogId} command="show-modal">
            <Icon name="plus" />
            Add project
          </Button>
        </header>
        <div mix={tableFrameStyle}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead mix={actionsHeadStyle}>
                  <span mix={screenReaderOnlyStyle}>Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0
                ? (
                  <TableRow>
                    <TableCell colSpan={2} mix={emptyCellStyle}>No projects configured.</TableCell>
                  </TableRow>
                )
                : projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    csrfToken={csrfToken}
                  />
                ))}
            </TableBody>
          </Table>
        </div>
      </section>
      <ProjectDialog
        dialogId={addDialogId}
        csrfToken={csrfToken}
      />
    </AppShell>
  );
}

function ProjectRow(
  handle: Handle<{
    project: Project;
    csrfToken: string;
  }>,
) {
  const { project, csrfToken } = handle.props;
  const editDialogId = `${handle.id}-edit`;
  const deleteDialogId = `${handle.id}-delete`;

  return () => (
    <TableRow>
      <TableCell>
        <strong mix={projectNameStyle}>{project.name}</strong>
        <span mix={repositoryStyle}>{project.repositoryUrl}</span>
      </TableCell>
      <TableCell mix={actionsCellStyle}>
        <DropdownMenu mix={rowMenuStyle}>
          <DropdownMenuTrigger
            aria-label={`Open actions for ${project.name}`}
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
        <ProjectDialog
          dialogId={editDialogId}
          csrfToken={csrfToken}
          project={project}
        />
        <DeleteProjectDialog
          dialogId={deleteDialogId}
          csrfToken={csrfToken}
          project={project}
        />
      </TableCell>
    </TableRow>
  );
}

function ProjectDialog(
  handle: Handle<{
    dialogId: string;
    csrfToken: string;
    project?: Project;
  }>,
) {
  const { dialogId, csrfToken, project } = handle.props;
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
        <AlertDialogTitle id={titleId}>{project ? "Edit project" : "Add project"}</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          OpenOrb accepts GitHub HTTPS repositories only. SSH and other Git hosts are not supported.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={routes.app.projects.action.href()} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value={project ? "update-project" : "create-project"} />
        {project ? <input type="hidden" name="projectId" value={project.id} /> : null}
        <ProjectFormFields project={project} idPrefix={dialogId} />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit">{project ? "Save changes" : "Add project"}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function ProjectFormFields(
  handle: Handle<{
    project?: Project;
    idPrefix: string;
  }>,
) {
  const { project, idPrefix } = handle.props;

  return () => (
    <div mix={fieldsStyle}>
      <Field>
        <FieldLabel for={`${idPrefix}-name`}>Name</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          value={project?.name ?? ""}
          placeholder="OpenOrb"
          maxLength={100}
          required
        />
      </Field>
      <Field>
        <FieldLabel for={`${idPrefix}-repository`}>GitHub repository</FieldLabel>
        <Input
          id={`${idPrefix}-repository`}
          name="repository"
          value={project?.repositoryUrl ?? ""}
          placeholder="owner/repository"
          required
        />
        <FieldDescription>
          Use owner/repository or https://github.com/owner/repository.git.
        </FieldDescription>
      </Field>
    </div>
  );
}

function DeleteProjectDialog(
  handle: Handle<{ dialogId: string; csrfToken: string; project: Project }>,
) {
  const { dialogId, csrfToken, project } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog id={dialogId} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete project?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This deletes{" "}
          <strong>{project.name}</strong>. Projects referenced by sessions cannot be deleted.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={routes.app.projects.action.href()}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete-project" />
        <input type="hidden" name="projectId" value={project.id} />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete project</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

const projectPanelStyle = css({ display: "grid", gap: "16px", minWidth: 0 });
const panelHeaderStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "16px",
  [media.sm]: { flexDirection: "row", alignItems: "center" },
});
const panelTitleStyle = css({ display: "grid", gap: "6px" });
const sectionHeadingStyle = css({ margin: 0, fontSize: "18px", fontWeight: 600 });
const sectionCopyStyle = css({
  maxWidth: "680px",
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});
const tableFrameStyle = css({
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
});
const emptyCellStyle = css({
  height: "120px",
  color: "var(--muted-foreground)",
  textAlign: "center",
});
const projectNameStyle = css({ display: "block", fontWeight: 600 });
const repositoryStyle = css({
  display: "block",
  maxWidth: "420px",
  marginTop: "3px",
  overflow: "hidden",
  color: "var(--muted-foreground)",
  fontSize: "12px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const actionsHeadStyle = css({ width: "52px" });
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
});
const dialogFormStyle = css({ display: "grid", gap: "20px" });
const fieldsStyle = css({ display: "grid", gap: "18px" });
const errorStyle = css({
  margin: 0,
  padding: "12px 14px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 8%, var(--background))",
  border: "1px solid color-mix(in oklab, var(--destructive) 30%, var(--border))",
  borderRadius: "var(--radius-md)",
  fontSize: "14px",
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
