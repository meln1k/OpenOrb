import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { ProvidersSettingsPage } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { MODEL_PROVIDER_OPTIONS, OPENAI_CODEX_PROVIDER_ID } from "@/app/model-provider-catalog.ts";
import type { OpenAICodexAuthorizationStatus } from "@/app/openai-codex-authorization.ts";
import type { AppContext } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { tryAsync } from "@openorb/result";

const CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY = "chatgpt-authorization-attempt";

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
            context.services.openAICodexAuthorization.start(
              context.auth.identity.workspaceId,
            ),
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
          const result = context.services.openAICodexAuthorization.status(
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
            await context.services.openAICodexAuthorization.cancel(
              context.auth.identity.workspaceId,
              attemptId,
            );
          }
          context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
        case "disconnect-chatgpt": {
          const deleted = await context.services.openAICodexAuthorization.disconnect(
            context.auth.identity.workspaceId,
          );
          context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
          if (deleted.status === "not-found") {
            return await renderProviders(context, "ChatGPT is no longer connected.", 404);
          }
          return redirect(routes.app.settings.providers.index.href(), 303);
        }
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
  const attemptId = readAuthorizationAttemptId(
    context.session.get(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY),
  );
  const authorizationStatus: OpenAICodexAuthorizationStatus = attemptId
    ? context.services.openAICodexAuthorization.status(
      context.auth.identity.workspaceId,
      attemptId,
    )
    : { status: "missing" };
  if (attemptId && authorizationStatus.status !== "pending") {
    context.session.unset(CHATGPT_AUTHORIZATION_ATTEMPT_SESSION_KEY);
  }
  const providers = await context.services.store.listModelProviderCredentials(
    context.auth.identity.workspaceId,
  );
  const chatGPTCredential = providers.find((provider) =>
    provider.providerId === OPENAI_CODEX_PROVIDER_ID && provider.credentialType === "oauth"
  );
  const chatGPTAuthorization = authorizationStatus.status === "pending"
    ? authorizationStatus.authorization
    : undefined;
  return context.render(
    <ProvidersSettingsPage
      chatGPTAuthorization={chatGPTAuthorization === undefined ? undefined : {
        userCode: chatGPTAuthorization.userCode,
        verificationUri: chatGPTAuthorization.verificationUri,
        intervalSeconds: chatGPTAuthorization.intervalSeconds,
      }}
      chatGPTCredential={chatGPTCredential}
      csrfToken={getCsrfToken(context)}
      error={error ??
        (authorizationStatus.status === "error"
          ? "ChatGPT sign-in could not be completed. Try again."
          : undefined)}
      providerOptions={MODEL_PROVIDER_OPTIONS}
      providers={providers.filter((provider) => provider.credentialType === "api_key")}
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
    ? Response.json({
      status: "complete",
      redirect: routes.app.settings.providers.index.href(),
    }, { headers: { "cache-control": "no-store" } })
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
