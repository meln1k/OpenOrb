import {
  DEFAULT_SESSION_THINKING_LEVEL,
  MAX_INITIAL_PROMPT_BYTES,
  modelReferenceSchema,
  parseModelReference,
  sessionBranchNameSchema,
  sessionGitRefSchema,
  sessionIdSchema,
  type SessionModelRuntime,
} from "@openorb/protocol";
import { v7 } from "@std/uuid";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { type ContextWithParams, createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { AppPage } from "@/app/actions/app/page.tsx";
import { SessionDetailPage } from "@/app/actions/sessions/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { selectRunnerForUser } from "@/app/runner-selection.ts";
import { routes } from "@/app/routes.ts";
import { loadSessionComposerData } from "@/app/session-composer-data.ts";
import { isModelReference } from "@/app/model-provider-catalog.ts";
import type { SessionComposerValues } from "@/app/ui/session-composer.tsx";

const projectIdSchema = s.string().refine(
  (value) => s.parseSafe(sessionIdSchema, value).success,
  "The project identifier is invalid.",
);
const promptSchema = s.string().refine(
  (value) =>
    value.trim().length > 0 && new TextEncoder().encode(value).byteLength <=
      MAX_INITIAL_PROMPT_BYTES,
  `The initial prompt is required and must be at most ${MAX_INITIAL_PROMPT_BYTES} UTF-8 bytes.`,
);

const createSessionSchema = f.object({
  projectId: f.field(projectIdSchema),
  model: f.field(modelReferenceSchema),
  ref: f.field(sessionGitRefSchema),
  runnerId: f.field(s.string()),
  branchName: f.field(sessionBranchNameSchema),
  initialPrompt: f.field(promptSchema),
});

type SessionsContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;
type SessionDetailContext = ContextWithParams<SessionsContext, { sessionId: string }>;

export default createController(routes.app.sessions, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async create(context) {
      const parsed = s.parseSafe(createSessionSchema, context.formData);
      const submitted = submittedValues(context.formData);
      if (!parsed.success) {
        return await renderCreateError(
          context,
          parsed.issues[0]?.message ?? "Invalid session.",
          400,
          submitted,
        );
      }

      const { store } = context.services;
      const userId = context.auth.identity.id;
      const project = await store.getProject(userId, parsed.value.projectId);
      if (!project) {
        return await renderCreateError(
          context,
          "Project is unavailable or does not exist.",
          404,
          submitted,
        );
      }
      if (!isModelReference(parsed.value.model)) {
        return await renderCreateError(
          context,
          "The selected Pi model is unavailable.",
          400,
          submitted,
        );
      }
      const { providerId } = parseModelReference(parsed.value.model);

      const runnerId = parsed.value.runnerId.trim() || undefined;
      const selected = await selectRunnerForUser(
        userId,
        runnerId,
        store,
        context.services.runnerConnections,
      );
      if (selected.status === "rejected") {
        return await renderCreateError(context, selected.message, 409, submitted);
      }

      const [[githubToken, gitCredentialError], [modelApiKey, modelCredentialError]] = await Promise
        .all([
          store.getGitHubToken(userId),
          store.getModelProviderApiKey(userId, providerId),
        ]);
      if (gitCredentialError !== undefined) {
        return await renderCreateError(
          context,
          "The saved GitHub credential could not be read.",
          500,
          submitted,
        );
      }
      if (modelCredentialError !== undefined) {
        return await renderCreateError(
          context,
          "The saved model provider credential could not be read.",
          500,
          submitted,
        );
      }
      if (modelApiKey === null) {
        return await renderCreateError(
          context,
          "Configure the selected model provider before starting a session.",
          409,
          submitted,
        );
      }

      const sessionId = v7.generate();
      const provisioned = await context.services.runnerConnections.provisionSession({
        userId,
        runnerId: selected.runner.id,
        sessionId,
        payload: {
          mode: "create",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
          ref: parsed.value.ref,
          branchName: parsed.value.branchName,
          initialPrompt: parsed.value.initialPrompt,
          modelRuntime: sessionModelRuntime(parsed.value.model, modelApiKey),
          githubToken: githubToken ?? undefined,
        },
      });
      if (provisioned.status !== "accepted") {
        return await renderCreateError(context, provisioned.message, 503, submitted);
      }

      return redirect(routes.app.sessions.detail.href({ sessionId }), 303);
    },

    async detail(context) {
      return await renderDetailPage(context);
    },

    async retry(context) {
      const userId = context.auth.identity.id;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return new Response("Session not found.", { status: 404 });
      const session = await context.services.store.getSessionCatalogEntry(userId, sessionId);
      if (!session) return new Response("Session not found.", { status: 404 });

      const runnerId = context.services.runnerConnections.getSessionRunner(userId, sessionId);
      if (!runnerId) {
        return await renderDetailPage(context, "The pinned runner is offline.", 409);
      }
      const snapshot = context.services.runnerConnections.getSessionSnapshot(userId, sessionId);
      if (!snapshot || snapshot.state !== "error") {
        return await renderDetailPage(
          context,
          "Only a failed provisioning attempt can be retried.",
          409,
        );
      }

      const [[githubToken, gitCredentialError], [modelApiKey, modelCredentialError]] = await Promise
        .all([
          context.services.store.getGitHubToken(userId),
          context.services.store.getModelProviderApiKey(
            userId,
            parseModelReference(snapshot.model).providerId,
          ),
        ]);
      if (gitCredentialError !== undefined) {
        return await renderDetailPage(
          context,
          "The saved GitHub credential could not be read.",
          500,
        );
      }
      if (modelCredentialError !== undefined) {
        return await renderDetailPage(
          context,
          "The saved model provider credential could not be read.",
          500,
        );
      }
      if (modelApiKey === null) {
        return await renderDetailPage(
          context,
          "Reconfigure this session's model provider before retrying.",
          409,
        );
      }
      const provisioned = await context.services.runnerConnections.provisionSession({
        userId,
        runnerId,
        sessionId,
        payload: {
          mode: "retry",
          modelRuntime: sessionModelRuntime(snapshot.model, modelApiKey),
          githubToken: githubToken ?? undefined,
        },
      });
      if (provisioned.status !== "accepted") {
        return await renderDetailPage(context, provisioned.message, 503);
      }
      return redirect(routes.app.sessions.detail.href({ sessionId }), 303);
    },
  },
});

async function renderCreateError(
  context: SessionsContext,
  error: string,
  status: number,
  values: SessionComposerValues,
) {
  const userId = context.auth.identity.id;
  const [composer, sidebarSessions] = await Promise.all([
    loadSessionComposerData(userId, context.services),
    context.services.store.listSessionCatalogEntries(userId),
  ]);
  return context.render(
    <AppPage
      composer={{ ...composer, autoOpen: true, error, values }}
      csrfToken={getCsrfToken(context)}
      sidebarSessions={sidebarSessions}
      title="New session · OpenOrb"
    />,
    { status },
  );
}

async function renderDetailPage(
  context: SessionDetailContext,
  error?: string,
  status = 200,
) {
  const userId = context.auth.identity.id;
  const sessionId = parseSessionId(context.params.sessionId);
  if (!sessionId) return new Response("Session not found.", { status: 404 });
  const [composer, session, sidebarSessions] = await Promise.all([
    loadSessionComposerData(userId, context.services),
    context.services.store.getSessionCatalogEntry(userId, sessionId),
    context.services.store.listSessionCatalogEntries(userId),
  ]);
  if (!session) return new Response("Session not found.", { status: 404 });
  const project = await context.services.store.getProject(userId, session.projectId);
  if (!project) return new Response("Session project not found.", { status: 404 });
  const runnerId = context.services.runnerConnections.getSessionRunner(userId, sessionId);
  const snapshot = context.services.runnerConnections.getSessionSnapshot(userId, sessionId);
  return context.render(
    <SessionDetailPage
      composer={composer}
      csrfToken={getCsrfToken(context)}
      session={session}
      project={project}
      runnerId={runnerId}
      snapshot={snapshot}
      eventsHref={routes.api.sessions.events.href({ sessionId })}
      retryHref={routes.app.sessions.retry.href({ sessionId })}
      sidebarSessions={sidebarSessions}
      error={error}
    />,
    { status },
  );
}

function parseSessionId(value: string): string | null {
  return s.parseSafe(sessionIdSchema, value).success ? value : null;
}

function submittedValues(formData: FormData): SessionComposerValues {
  return {
    projectId: stringField(formData, "projectId"),
    model: stringField(formData, "model"),
    ref: stringField(formData, "ref"),
    runnerId: stringField(formData, "runnerId"),
    branchName: stringField(formData, "branchName"),
    initialPrompt: stringField(formData, "initialPrompt"),
  };
}

function sessionModelRuntime(model: string, apiKey: string): SessionModelRuntime {
  return {
    model,
    thinkingLevel: DEFAULT_SESSION_THINKING_LEVEL,
    credential: { type: "api_key" as const, value: apiKey },
  };
}

function stringField(formData: FormData, name: string): string {
  const parsed = s.parseSafe(s.string(), formData.get(name));
  return parsed.success ? parsed.value : "";
}
