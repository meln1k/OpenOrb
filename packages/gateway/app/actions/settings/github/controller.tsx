import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { GitHubSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";

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

type GitHubContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;

export default createController(routes.app.settings.github, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderGitHub(context);
    },

    async action(context) {
      switch (context.formData.get("intent")) {
        case "save-github-credential": {
          const parsed = s.parseSafe(saveGitHubCredentialSchema, context.formData);
          if (!parsed.success) {
            return await renderGitHub(
              context,
              parsed.issues[0]?.message ?? "Invalid GitHub credential.",
              400,
            );
          }
          await context.services.store.saveGitHubCredential(
            context.auth.identity.id,
            parsed.value.token.trim(),
          );
          return redirect(routes.app.settings.github.index.href(), 303);
        }
        case "delete-github-credential": {
          const parsed = s.parseSafe(deleteGitHubCredentialSchema, context.formData);
          if (!parsed.success) {
            return await renderGitHub(context, "Invalid GitHub credential deletion.", 400);
          }
          const result = await context.services.store.deleteGitHubCredential(
            context.auth.identity.id,
          );
          if (result.status === "not-found") {
            return await renderGitHub(
              context,
              "The GitHub credential no longer exists.",
              404,
            );
          }
          return redirect(routes.app.settings.github.index.href(), 303);
        }
        default:
          return await renderGitHub(
            context,
            "Invalid GitHub credential form submission.",
            400,
          );
      }
    },
  },
});

async function renderGitHub(
  context: GitHubContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const credential = await context.services.store.getGitHubCredential(context.auth.identity.id);
  return context.render(
    <GitHubSettingsPage
      csrfToken={getCsrfToken(context)}
      credential={credential}
      error={error}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}
