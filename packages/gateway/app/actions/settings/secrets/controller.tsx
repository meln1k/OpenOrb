import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { SecretsSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { isReservedGitCredentialSecretKey } from "@/app/data/git-configuration-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";

const secretKeySchema = s.string().refine(
  (value) => {
    const key = value.trim();
    return key.length > 0 && key.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !isReservedGitCredentialSecretKey(key);
  },
  'Start with a letter or underscore and use only letters, digits, and underscores, such as "SERVICE_TOKEN". OPENORB_GITHUB_TOKEN_ names are reserved.',
);

const saveSecretSchema = f.object({
  intent: f.field(s.literal("save-secret")),
  key: f.field(secretKeySchema),
  value: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The secret value is required.")
      .refine((value) => value.trim().length <= 4096, "The secret value is too long."),
  ),
});

const deleteSecretSchema = f.object({
  intent: f.field(s.literal("delete-secret")),
  key: f.field(secretKeySchema),
});

type SecretsContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;

export default createController(routes.app.settings.secrets, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderSecrets(context);
    },

    async action(context) {
      switch (context.formData.get("intent")) {
        case "save-secret": {
          const parsed = s.parseSafe(saveSecretSchema, context.formData);
          if (!parsed.success) {
            return await renderSecrets(
              context,
              parsed.issues[0]?.message ?? "Invalid secret form submission.",
              400,
            );
          }
          await context.services.store.saveSecret(
            context.auth.identity.workspaceId,
            parsed.value.key.trim(),
            parsed.value.value.trim(),
          );
          return redirect(routes.app.settings.secrets.index.href(), 303);
        }
        case "delete-secret": {
          const parsed = s.parseSafe(deleteSecretSchema, context.formData);
          if (!parsed.success) {
            return await renderSecrets(
              context,
              parsed.issues[0]?.message ?? "Invalid secret deletion.",
              400,
            );
          }
          await context.services.store.deleteSecret(
            context.auth.identity.workspaceId,
            parsed.value.key.trim(),
          );
          return redirect(routes.app.settings.secrets.index.href(), 303);
        }
        default:
          return await renderSecrets(context, "Invalid secret form submission.", 400);
      }
    },
  },
});

async function renderSecrets(
  context: SecretsContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const secrets = await context.services.store.listSecrets(context.auth.identity.workspaceId);
  return context.render(
    <SecretsSettingsPage csrfToken={getCsrfToken(context)} error={error} secrets={secrets} />,
    { status, headers: { "cache-control": "no-store" } },
  );
}
