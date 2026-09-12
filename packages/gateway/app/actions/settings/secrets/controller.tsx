import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";
import {
  isReservedSessionEnvironmentName,
  isValidSessionSecretHost,
  MAX_SESSION_ENVIRONMENT_SECRETS,
  MAX_SESSION_SECRET_HOST_CHARACTERS,
  MAX_SESSION_SECRET_HOSTS,
} from "@openorb/protocol/runner-api";

import { SecretsSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";

const secretKeySchema = s.string().refine(
  (value) => {
    const key = value.trim();
    return key.length > 0 && key.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !isReservedSessionEnvironmentName(key);
  },
  'Start with a letter or underscore and use only letters, digits, and underscores, such as "SERVICE_TOKEN". OpenOrb runtime variable names are reserved.',
);
const allowedHostsSchema = s.string().refine(
  (value) => {
    const hosts = splitAllowedHosts(value);
    return hosts.length <= MAX_SESSION_SECRET_HOSTS &&
      hosts.every(isValidSessionSecretHost) &&
      !(hosts.includes("*") && hosts.length > 1);
  },
  `Enter at most ${MAX_SESSION_SECRET_HOSTS} hostnames of at most ${MAX_SESSION_SECRET_HOST_CHARACTERS} characters, separated by commas. Use names such as api.example.com or *.example.com; use * alone or leave blank for any public host.`,
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
  allowedHosts: f.field(allowedHostsSchema),
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
          const result = await context.services.store.saveSecret(
            context.auth.identity.workspaceId,
            parsed.value.key.trim(),
            parsed.value.value.trim(),
            normalizeAllowedHosts(parsed.value.allowedHosts),
          );
          if (result.status === "limit-exceeded") {
            return await renderSecrets(
              context,
              `A workspace can store at most ${MAX_SESSION_ENVIRONMENT_SECRETS} generic secrets.`,
              400,
            );
          }
          if (result.status === "rpc-frame-limit-exceeded") {
            return await renderSecrets(
              context,
              "The workspace's generic secrets are too large to send to a runner.",
              400,
            );
          }
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

function splitAllowedHosts(value: string): string[] {
  return value.trim().toLowerCase().split(/[\s,]+/u).filter(Boolean);
}

function normalizeAllowedHosts(value: string): readonly string[] | undefined {
  const hosts = [...new Set(splitAllowedHosts(value))];
  return hosts.length === 0 || hosts.includes("*") ? undefined : hosts;
}
