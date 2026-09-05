import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { GitAuthorSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";

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

type GitAuthorContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;

export default createController(routes.app.settings.gitAuthor, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderGitAuthor(context);
    },

    async action(context) {
      if (context.formData.get("intent") !== "save-git-author") {
        return await renderGitAuthor(context, "Invalid Git author form submission.", 400);
      }
      const parsed = s.parseSafe(saveGitAuthorSchema, context.formData);
      if (!parsed.success) {
        return await renderGitAuthor(
          context,
          parsed.issues[0]?.message ?? "Invalid Git author identity.",
          400,
        );
      }
      await context.services.store.saveGitAuthorConfiguration(context.auth.identity.userId, {
        authorName: parsed.value.authorName.trim(),
        authorEmail: parsed.value.authorEmail.trim(),
      });
      return redirect(routes.app.settings.gitAuthor.index.href(), 303);
    },
  },
});

async function renderGitAuthor(
  context: GitAuthorContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const gitAuthor = await context.services.store.getGitAuthorConfiguration(
    context.auth.identity.userId,
  );
  return context.render(
    <GitAuthorSettingsPage
      csrfToken={getCsrfToken(context)}
      error={error}
      gitAuthor={gitAuthor}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}
