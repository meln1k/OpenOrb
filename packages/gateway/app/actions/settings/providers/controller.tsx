import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { ProvidersSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { MODEL_PROVIDER_OPTIONS } from "@/app/model-provider-catalog.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";

const modelProviderIdSchema = s.string().refine(
  (value) => MODEL_PROVIDER_OPTIONS.some((provider) => provider.id === value),
  "Select a model provider from the list.",
);

const saveProviderSchema = f.object({
  intent: f.field(s.literal("save-provider")),
  providerId: f.field(modelProviderIdSchema),
  apiKey: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The API key is required.")
      .refine((value) => value.trim().length <= 4096, "The API key is too long."),
  ),
});

const deleteProviderSchema = f.object({
  intent: f.field(s.literal("delete-provider")),
  providerId: f.field(modelProviderIdSchema),
});

type ProvidersContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;

export default createController(routes.app.settings.providers, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderProviders(context);
    },

    async action(context) {
      switch (context.formData.get("intent")) {
        case "save-provider": {
          const parsed = s.parseSafe(saveProviderSchema, context.formData);
          if (!parsed.success) {
            return await renderProviders(
              context,
              parsed.issues[0]?.message ?? "Invalid model provider form submission.",
              400,
            );
          }
          await context.services.store.saveModelProviderCredential(
            context.auth.identity.workspaceId,
            parsed.value.providerId,
            parsed.value.apiKey.trim(),
          );
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        case "delete-provider": {
          const parsed = s.parseSafe(deleteProviderSchema, context.formData);
          if (!parsed.success) {
            return await renderProviders(
              context,
              parsed.issues[0]?.message ?? "Invalid model provider deletion.",
              400,
            );
          }
          await context.services.store.deleteModelProviderCredential(
            context.auth.identity.workspaceId,
            parsed.value.providerId,
          );
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        default:
          return await renderProviders(context, "Invalid provider form submission.", 400);
      }
    },
  },
});

async function renderProviders(
  context: ProvidersContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const providers = await context.services.store.listModelProviderCredentials(
    context.auth.identity.workspaceId,
  );
  return context.render(
    <ProvidersSettingsPage
      csrfToken={getCsrfToken(context)}
      error={error}
      providerOptions={MODEL_PROVIDER_OPTIONS}
      providers={providers}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}
