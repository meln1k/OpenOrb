import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { ProvidersSettingsPage } from "../page.tsx";
import type {
  Administrator,
  OpenAICodexAuthorizationStatus,
} from "../../../cells/workspace/api.ts";
import { csrf } from "../../../middleware/csrf.ts";
import {
  MODEL_PROVIDER_OPTIONS,
  OPENAI_CODEX_PROVIDER_ID,
} from "../../../model-provider-catalog.ts";
import type { AppContext } from "../../../router.ts";
import { SEARCH_PROVIDER_IDS } from "../../../search-provider-catalog.ts";
import { routes } from "../../../routes.ts";
import { tryAsync } from "@openorb/result";

const CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY = "chatgpt-authorization-attempt";

const modelProviderIdSchema = s
  .string()
  .refine(
    (value) => MODEL_PROVIDER_OPTIONS.some((provider) => provider.id === value),
    "Select a model provider from the list.",
  );

const apiKeyField = f.field(
  s
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, "The API key is required.")
    .refine((value) => value.length <= 4096, "The API key is too long."),
);

const saveProviderSchema = f.object({
  intent: f.field(s.literal("save-provider")),
  providerId: f.field(modelProviderIdSchema),
  apiKey: apiKeyField,
});

const deleteProviderSchema = f.object({
  intent: f.field(s.literal("delete-provider")),
  providerId: f.field(modelProviderIdSchema),
});

const searchProviderIdSchema = s.enum_(SEARCH_PROVIDER_IDS);

const saveSearchProviderSchema = f.object({
  intent: f.field(s.literal("save-search-provider")),
  providerId: f.field(searchProviderIdSchema),
  apiKey: apiKeyField,
});

const deleteSearchProviderSchema = f.object({
  intent: f.field(s.literal("delete-search-provider")),
  providerId: f.field(searchProviderIdSchema),
});

const authorizationAttemptIdSchema = s.string().refine((value) => value.length > 0);

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
        case "start-chatgpt": {
          const [authorization, startError] = await tryAsync(
            context.services.workspace.startProviderLogin(context.auth.identity.workspaceId),
            () => true,
          );
          if (startError !== undefined) {
            return await renderProviders(
              context,
              "ChatGPT sign-in could not be started. Try again.",
              502,
            );
          }
          context.session.set(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY, authorization.id);
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        case "poll-chatgpt": {
          const attemptId = readAuthorizationAttemptId(
            context.session.get(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY),
          );
          if (!attemptId) {
            context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
            return pollError(context, "The ChatGPT sign-in is no longer active.", 409);
          }
          const result = await context.services.workspace.getProviderLoginStatus(
            context.auth.identity.workspaceId,
            attemptId,
          );
          if (result.status === "pending") return pollPending(context);
          context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
          if (result.status === "complete") return pollComplete(context);
          if (result.status === "error") {
            return pollError(context, "ChatGPT sign-in could not be completed. Try again.", 502);
          }
          return pollError(context, "The ChatGPT sign-in is no longer active.", 409);
        }
        case "cancel-chatgpt": {
          const attemptId = readAuthorizationAttemptId(
            context.session.get(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY),
          );
          if (attemptId) {
            await context.services.workspace.cancelProviderLogin(
              context.auth.identity.workspaceId,
              attemptId,
            );
          }
          context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        case "disconnect-chatgpt": {
          const deleted = await context.services.workspace.disconnectProvider(
            context.auth.identity.workspaceId,
          );
          context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
          if (deleted.status === "not-found") {
            return await renderProviders(context, "ChatGPT is no longer connected.", 404);
          }
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        case "save-provider":
          return await submitProviderForm(
            context,
            saveProviderSchema,
            "Invalid model provider form submission.",
            (value) =>
              context.services.workspace.saveModelProviderCredential(
                context.auth.identity.workspaceId,
                value.providerId,
                value.apiKey,
              ),
          );
        case "delete-provider":
          return await submitProviderForm(
            context,
            deleteProviderSchema,
            "Invalid model provider deletion.",
            (value) =>
              context.services.workspace.deleteModelProviderCredential(
                context.auth.identity.workspaceId,
                value.providerId,
              ),
          );
        case "save-search-provider":
          return await submitProviderForm(
            context,
            saveSearchProviderSchema,
            "Invalid web search provider form submission.",
            (value) =>
              context.services.workspace.saveSearchProviderCredential(
                context.auth.identity.workspaceId,
                value.providerId,
                value.apiKey,
              ),
          );
        case "delete-search-provider":
          return await submitProviderForm(
            context,
            deleteSearchProviderSchema,
            "Invalid web search provider deletion.",
            (value) =>
              context.services.workspace.deleteSearchProviderCredential(
                context.auth.identity.workspaceId,
                value.providerId,
              ),
          );
        default:
          return await renderProviders(context, "Invalid provider form submission.", 400);
      }
    },
  },
});

/** Validates one provider form, applies it, and returns to the page; invalid input re-renders it. */
async function submitProviderForm<T>(
  context: ProvidersContext,
  schema: s.Schema<unknown, T>,
  invalidMessage: string,
  apply: (value: T) => Promise<object>,
): Promise<Response> {
  const parsed = s.parseSafe(schema, context.formData);
  if (!parsed.success) {
    return await renderProviders(context, parsed.issues[0]?.message ?? invalidMessage, 400);
  }
  await apply(parsed.value);
  return redirect(routes.app.settings.providers.index.href(), 303);
}

async function renderProviders(
  context: ProvidersContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const attemptId = readAuthorizationAttemptId(
    context.session.get(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY),
  );
  const authorizationStatus: OpenAICodexAuthorizationStatus = attemptId
    ? await context.services.workspace.getProviderLoginStatus(
        context.auth.identity.workspaceId,
        attemptId,
      )
    : { status: "missing" };
  if (attemptId && authorizationStatus.status !== "pending") {
    context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
  }
  const [providers, searchProviders] = await Promise.all([
    context.services.workspace.listModelProviderCredentials(context.auth.identity.workspaceId),
    context.services.workspace.listSearchProviderCredentials(context.auth.identity.workspaceId),
  ]);
  const chatGPTCredential = providers.find(
    (provider) =>
      provider.providerId === OPENAI_CODEX_PROVIDER_ID && provider.credentialType === "oauth",
  );
  const chatGPTAuthorization =
    authorizationStatus.status === "pending" ? authorizationStatus.authorization : undefined;
  return context.render(
    <ProvidersSettingsPage
      chatGPTAuthorization={
        chatGPTAuthorization === undefined
          ? undefined
          : {
              userCode: chatGPTAuthorization.userCode,
              verificationUri: chatGPTAuthorization.verificationUri,
              intervalSeconds: chatGPTAuthorization.intervalSeconds,
            }
      }
      chatGPTCredential={chatGPTCredential}
      csrfToken={getCsrfToken(context)}
      error={
        error ??
        (authorizationStatus.status === "error"
          ? "ChatGPT sign-in could not be completed. Try again."
          : undefined)
      }
      providerOptions={MODEL_PROVIDER_OPTIONS}
      providers={providers.filter((provider) => provider.credentialType === "api_key")}
      searchProviders={searchProviders}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}

function readAuthorizationAttemptId(value: unknown): string | undefined {
  const parsed = s.parseSafe(authorizationAttemptIdSchema, value);
  return parsed.success ? parsed.value : undefined;
}

function wantsJson(context: ProvidersContext): boolean {
  return context.request.headers.get("accept")?.includes("application/json") ?? false;
}

function pollPending(context: ProvidersContext): Response | Promise<Response> {
  return wantsJson(context)
    ? Response.json({ status: "pending" }, { headers: { "cache-control": "no-store" } })
    : renderProviders(context);
}

function pollComplete(context: ProvidersContext): Response {
  return wantsJson(context)
    ? Response.json(
        {
          status: "complete",
          redirect: routes.app.settings.providers.index.href(),
        },
        { headers: { "cache-control": "no-store" } },
      )
    : redirect(routes.app.settings.providers.index.href(), 303);
}

function pollError(
  context: ProvidersContext,
  message: string,
  status: number,
): Response | Promise<Response> {
  return wantsJson(context)
    ? Response.json(
        { status: "error", message },
        { status, headers: { "cache-control": "no-store" } },
      )
    : renderProviders(context, message, status);
}
