import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { isReservedGitCredentialSecretKey } from "@/app/data/git-configuration-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { routes } from "@/app/routes.ts";
import { SettingsPage, type SettingsTab, settingsTabHref } from "@/app/actions/settings/page.tsx";

const secretKeySchema = s.string().refine(
  (value) => {
    const key = value.trim();
    return key.length > 0 &&
      key.length <= 64 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !isReservedGitCredentialSecretKey(key);
  },
  'Start with a letter or underscore and use only letters, digits, and underscores, such as "OPENCODE_API_KEY". OPENORB_GITHUB_TOKEN_ names are reserved.',
);

const saveSchema = f.object({
  intent: f.field(s.literal("save")),
  key: f.field(secretKeySchema),
  value: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The API key is required.")
      .refine((value) => value.trim().length <= 4096, "The API key is too long."),
  ),
});

const deleteSchema = f.object({
  intent: f.field(s.literal("delete")),
  key: f.field(secretKeySchema),
});

const saveGitHubCredentialSchema = f.object({
  intent: f.field(s.literal("save-github-credential")),
  token: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The GitHub token is required.")
      .refine((value) => value.trim().length <= 4096, "The GitHub token is too long."),
  ),
});

const deleteGitHubCredentialSchema = f.object({
  intent: f.field(s.literal("delete-github-credential")),
});

const saveGitAuthorSchema = f.object({
  intent: f.field(s.literal("save-git-author")),
  authorName: f.field(
    s.string().refine(
      (value) => value.trim().length > 0 && value.trim().length <= 200,
      "The Git author name is required and must be at most 200 characters.",
    ),
  ),
  authorEmail: f.field(
    s.string().refine((value) => {
      const email = value.trim();
      return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }, "Expected valid email."),
  ),
});

const regenerateEnrollmentTokenSchema = f.object({
  intent: f.field(s.literal("regenerate-enrollment-token")),
});

export default createController(routes.app.settings, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      const userId = context.auth.identity.id;
      const activeTab = settingsTabFromRequest(context.request);
      const [secrets, githubCredential, gitAuthor, enrollmentToken] = await Promise.all([
        context.services.store.listSecrets(userId),
        context.services.store.getGitHubCredential(userId),
        context.services.store.getGitAuthorConfiguration(userId),
        context.services.store.getRunnerEnrollmentToken(userId),
      ]);
      return context.render(
        <SettingsPage
          csrfToken={getCsrfToken(context)}
          controlPanelUrl={runnerControlPanelUrl(context.request)}
          secrets={secrets}
          githubCredential={githubCredential}
          gitAuthor={gitAuthor}
          enrollmentToken={enrollmentToken}
          activeTab={activeTab}
        />,
        { headers: { "cache-control": "no-store" } },
      );
    },

    async action(context) {
      const { store } = context.services;
      const userId = context.auth.identity.id;
      const intent = context.formData.get("intent");
      const activeTab = settingsTabFromRequest(context.request, intent);
      const renderError = async (error: string, status: number) => {
        const [secrets, githubCredential, gitAuthor, enrollmentToken] = await Promise.all([
          store.listSecrets(userId),
          store.getGitHubCredential(userId),
          store.getGitAuthorConfiguration(userId),
          store.getRunnerEnrollmentToken(userId),
        ]);
        return context.render(
          <SettingsPage
            csrfToken={getCsrfToken(context)}
            controlPanelUrl={runnerControlPanelUrl(context.request)}
            secrets={secrets}
            githubCredential={githubCredential}
            gitAuthor={gitAuthor}
            enrollmentToken={enrollmentToken}
            activeTab={activeTab}
            error={error}
          />,
          { status, headers: { "cache-control": "no-store" } },
        );
      };

      if (intent === "save") {
        const save = s.parseSafe(saveSchema, context.formData);
        if (!save.success) {
          return renderError(
            save.issues[0]?.message ?? "Invalid secret form submission.",
            400,
          );
        }
        await store.saveSecret(userId, save.value.key.trim(), save.value.value.trim());
        return redirect(settingsTabHref("secrets"), 303);
      }

      if (intent === "delete") {
        const deletion = s.parseSafe(deleteSchema, context.formData);
        if (!deletion.success) {
          return renderError(
            deletion.issues[0]?.message ?? "Invalid secret deletion.",
            400,
          );
        }
        await store.deleteSecret(userId, deletion.value.key.trim());
        return redirect(settingsTabHref("secrets"), 303);
      }

      if (intent === "save-github-credential") {
        const parsed = s.parseSafe(saveGitHubCredentialSchema, context.formData);
        if (!parsed.success) {
          return renderError(
            parsed.issues[0]?.message ?? "Invalid GitHub credential.",
            400,
          );
        }
        await store.saveGitHubCredential(userId, parsed.value.token.trim());
        return redirect(settingsTabHref("github"), 303);
      }

      if (intent === "delete-github-credential") {
        const parsed = s.parseSafe(deleteGitHubCredentialSchema, context.formData);
        if (!parsed.success) {
          return renderError("Invalid GitHub credential deletion.", 400);
        }
        const result = await store.deleteGitHubCredential(userId);
        if (result.status === "not-found") {
          return renderError("The GitHub credential no longer exists.", 404);
        }
        return redirect(settingsTabHref("github"), 303);
      }

      if (intent === "save-git-author") {
        const parsed = s.parseSafe(saveGitAuthorSchema, context.formData);
        if (!parsed.success) {
          return renderError(
            parsed.issues[0]?.message ?? "Invalid Git author identity.",
            400,
          );
        }
        await store.saveGitAuthorConfiguration(userId, {
          authorName: parsed.value.authorName.trim(),
          authorEmail: parsed.value.authorEmail.trim(),
        });
        return redirect(settingsTabHref("git-author"), 303);
      }

      if (intent === "regenerate-enrollment-token") {
        const parsed = s.parseSafe(regenerateEnrollmentTokenSchema, context.formData);
        if (!parsed.success) return renderError("Invalid enrollment token request.", 400);
        await store.regenerateRunnerEnrollmentToken(userId);
        return redirect(settingsTabHref("runners"), 303);
      }

      return renderError("Invalid settings form submission.", 400);
    },
  },
});

function settingsTabFromRequest(request: Request, intent?: FormDataEntryValue | null): SettingsTab {
  const tab = new URL(request.url).searchParams.get("tab");
  if (tab === "github" || tab === "git-author" || tab === "runners" || tab === "secrets") {
    return tab;
  }
  if (intent === "save-github-credential" || intent === "delete-github-credential") return "github";
  if (intent === "save-git-author") return "git-author";
  if (intent === "regenerate-enrollment-token") return "runners";
  return "secrets";
}

function runnerControlPanelUrl(request: Request): string {
  const publicUrl = Deno.env.get("PUBLIC_URL");
  return new URL(publicUrl ?? request.url).origin;
}
