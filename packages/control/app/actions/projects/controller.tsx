import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import type { Administrator } from "../../data/administrator-repository.ts";
import { csrf } from "../../middleware/csrf.ts";
import { routes } from "../../routes.ts";
import { ProjectsPage } from "./page.tsx";
import { canonicalizeGitHubRepository } from "./project-input.ts";

const uuidSchema = s.string().refine(
  (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  "The project identifier is invalid.",
);
const nameSchema = s.string().refine(
  (value) => value.trim().length > 0 && value.trim().length <= 100,
  "The project name is required and must be at most 100 characters.",
);
const repositorySchema = s.string().refine(
  (value) => canonicalizeGitHubRepository(value) !== null,
  "Use owner/repository or an HTTPS github.com URL. SSH and non-GitHub repositories are not supported.",
);

const createSchema = f.object({
  intent: f.field(s.literal("create-project")),
  name: f.field(nameSchema),
  repository: f.field(repositorySchema),
});
const updateSchema = f.object({
  intent: f.field(s.literal("update-project")),
  projectId: f.field(uuidSchema),
  name: f.field(nameSchema),
  repository: f.field(repositorySchema),
});
const deleteSchema = f.object({
  intent: f.field(s.literal("delete-project")),
  projectId: f.field(uuidSchema),
});

export default createController(routes.app.projects, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      const projects = await context.services.store.listProjects(context.auth.identity.id);
      return context.render(
        <ProjectsPage
          csrfToken={getCsrfToken(context)}
          projects={projects}
        />,
      );
    },

    async action(context) {
      const { store } = context.services;
      const userId = context.auth.identity.id;
      const intent = context.formData.get("intent");
      const renderError = async (error: string, status: number) => {
        const projects = await store.listProjects(userId);
        return context.render(
          <ProjectsPage
            csrfToken={getCsrfToken(context)}
            projects={projects}
            error={error}
          />,
          { status },
        );
      };
      const saveProject = async (
        values: { name: string; repository: string },
        projectId?: string,
      ) => {
        const repositoryUrl = canonicalizeGitHubRepository(values.repository);
        if (!repositoryUrl) {
          return renderError("The GitHub repository is invalid.", 400);
        }
        const result = await store.saveProject(userId, {
          id: projectId,
          name: values.name.trim(),
          repositoryUrl,
        });
        if (result.status === "name-conflict") {
          return renderError("A project with that name already exists.", 409);
        }
        if (result.status === "not-found") {
          return renderError("The project no longer exists.", 404);
        }
        return redirect(routes.app.projects.index.href(), 303);
      };

      if (intent === "create-project") {
        const parsed = s.parseSafe(createSchema, context.formData);
        if (!parsed.success) {
          return renderError(parsed.issues[0]?.message ?? "Invalid project.", 400);
        }
        return saveProject(parsed.value);
      }

      if (intent === "update-project") {
        const parsed = s.parseSafe(updateSchema, context.formData);
        if (!parsed.success) {
          return renderError(parsed.issues[0]?.message ?? "Invalid project.", 400);
        }
        return saveProject(parsed.value, parsed.value.projectId);
      }

      if (intent === "delete-project") {
        const parsed = s.parseSafe(deleteSchema, context.formData);
        if (!parsed.success) {
          return renderError(parsed.issues[0]?.message ?? "Invalid project deletion.", 400);
        }
        const result = await store.deleteProject(userId, parsed.value.projectId);
        if (result === "in-use") {
          return renderError("This project is used by a session and cannot be deleted.", 409);
        }
        if (result === "not-found") {
          return renderError("The project no longer exists.", 404);
        }
        return redirect(routes.app.projects.index.href(), 303);
      }

      return renderError("Invalid project form submission.", 400);
    },
  },
});
