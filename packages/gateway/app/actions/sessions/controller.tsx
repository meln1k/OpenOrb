import { modelReferenceSchema, orbSizeSchema, parseModelReference } from "@openorb/protocol";
import {
  GitAuthor,
  isSafeGitReference,
  MAX_RPC_INITIAL_PROMPT_BYTES,
  ProjectId,
} from "@openorb/protocol/runner-api";
import { validate as validateUuid } from "@std/uuid";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { Accept } from "remix/headers/accept";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { type ContextWithParams, createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";
import { Effect, Schema } from "effect";

import { AppPage } from "@/app/actions/app/page.tsx";
import { SessionDetailPage } from "@/app/actions/sessions/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { selectRunnerForWorkspace } from "@/app/runner-selection.ts";
import { routes } from "@/app/routes.ts";
import { loadSessionComposerData } from "@/app/session-composer-data.ts";
import { isModelReference, sessionModelRuntime } from "@/app/model-provider-catalog.ts";
import type { SessionComposerValues } from "@/app/ui/session-composer.tsx";
import { currentSessionRecovery } from "@/app/utils/session-recovery.ts";

const sessionIdSchema = s.string().refine(validateUuid, "Expected a session UUID.");
const projectIdSchema = s.string().refine(
  (value) => s.parseSafe(sessionIdSchema, value).success,
  "The project identifier is invalid.",
);
const sessionGitRefSchema = s.string().refine(
  isSafeGitReference,
  "Expected a valid Git branch or tag reference.",
);
const sessionBranchNameSchema = s.string().refine(
  isSafeGitReference,
  "Expected a valid Git branch name.",
);
const promptSchema = s.string().refine(
  (value) =>
    value.trim().length > 0 && new TextEncoder().encode(value).byteLength <=
      MAX_RPC_INITIAL_PROMPT_BYTES,
  `The prompt is required and must be at most ${MAX_RPC_INITIAL_PROMPT_BYTES} UTF-8 bytes.`,
);

const createSessionSchema = f.object({
  sessionId: f.field(sessionIdSchema),
  projectId: f.field(projectIdSchema),
  model: f.field(modelReferenceSchema),
  ref: f.field(sessionGitRefSchema),
  runnerId: f.field(s.string()),
  orbSize: f.field(orbSizeSchema),
  branchName: f.field(sessionBranchNameSchema),
  initialPrompt: f.field(promptSchema),
});
const continueSessionSchema = f.object({
  prompt: f.field(promptSchema),
});
const retrySessionSchema = f.object({
  recovery: f.field(s.union([
    s.literal("retry-provisioning" as const),
    s.literal("resume-prior-checkpoint" as const),
    s.literal("start-clean-vm" as const),
  ])),
});

type SessionsContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;
type SessionDetailContext = ContextWithParams<SessionsContext, { sessionId: string }>;

export default createController(routes.app.sessions, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    index() {
      return redirect(routes.app.index.href(), 302);
    },

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
      const workspaceId = context.auth.identity.workspaceId;
      const project = await store.getProject(workspaceId, parsed.value.projectId);
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
      const selected = await selectRunnerForWorkspace(
        workspaceId,
        runnerId,
        parsed.value.orbSize,
        store,
        context.services.runnerConnections,
      );
      if (selected.status === "rejected") {
        return await renderCreateError(context, selected.message, 409, submitted);
      }

      const [
        [githubToken, gitCredentialError],
        [modelApiKey, modelCredentialError],
        gitAuthor,
      ] = await Promise.all([
        store.getGitHubToken(workspaceId),
        store.getModelProviderApiKey(workspaceId, providerId),
        store.getGitAuthorConfiguration(context.auth.identity.userId),
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
      if (gitAuthor === null) {
        return await renderCreateError(
          context,
          "Configure your Git author name and email before starting a session.",
          409,
          submitted,
        );
      }

      const sessionId = parsed.value.sessionId;
      const provisioned = await Effect.runPromise(
        context.services.runnerConnections.provisionSession({
          workspaceId,
          runnerId: selected.runner.id,
          sessionId,
          payload: {
            mode: "create",
            projectId: Schema.decodeUnknownSync(ProjectId)(project.id),
            repositoryUrl: project.repositoryUrl,
            ref: parsed.value.ref,
            branchName: parsed.value.branchName,
            gitAuthor: new GitAuthor({
              name: gitAuthor.authorName,
              email: gitAuthor.authorEmail,
            }),
            orbSize: parsed.value.orbSize,
            initialPrompt: parsed.value.initialPrompt,
            modelRuntime: sessionModelRuntime(parsed.value.model, modelApiKey),
            ...(githubToken ? { githubToken } : {}),
          },
        }),
        { signal: context.request.signal },
      );
      if (provisioned.status !== "accepted") {
        return await renderCreateError(context, provisioned.message, 503, submitted);
      }

      return redirect(routes.app.sessions.detail.href({ sessionId }), 303);
    },

    async detail(context) {
      return await renderDetailPage(context);
    },

    async message(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const parsed = s.parseSafe(continueSessionSchema, context.formData);
      if (!parsed.success) {
        return await sessionCommandError(
          context,
          parsed.issues[0]?.message ?? "Invalid prompt.",
          400,
        );
      }
      const session = await context.services.store.getSessionCatalogEntry(workspaceId, sessionId);
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const [snapshot, runnerId] = await Promise.all([
        Effect.runPromise(
          context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
        ),
        Effect.runPromise(
          context.services.runnerConnections.getSessionRunner(workspaceId, sessionId),
        ),
      ]);
      if (!snapshot || !runnerId) {
        return await sessionCommandError(context, "The pinned runner is offline.", 503);
      }
      if (
        snapshot.state !== "ready" && snapshot.state !== "running" &&
        snapshot.state !== "stopped"
      ) {
        return await sessionCommandError(
          context,
          "The session cannot accept a prompt right now.",
          409,
        );
      }

      const [[modelApiKey, modelCredentialError], [githubToken, gitCredentialError]] = await Promise
        .all([
          context.services.store.getModelProviderApiKey(
            workspaceId,
            parseModelReference(snapshot.model).providerId,
          ),
          context.services.store.getGitHubToken(workspaceId),
        ]);
      if (modelCredentialError !== undefined) {
        return await sessionCommandError(
          context,
          "The saved model provider credential could not be read.",
          500,
        );
      }
      if (gitCredentialError !== undefined) {
        return await sessionCommandError(
          context,
          "The saved GitHub credential could not be read.",
          500,
        );
      }
      if (modelApiKey === null) {
        return await sessionCommandError(
          context,
          "Reconfigure this session's model provider before continuing.",
          409,
        );
      }

      const prompted = await Effect.runPromise(
        context.services.runnerConnections.promptSession({
          workspaceId,
          sessionId,
          payload: {
            prompt: parsed.value.prompt,
            modelRuntime: sessionModelRuntime(snapshot.model, modelApiKey),
            ...(githubToken === null ? {} : { githubToken }),
          },
        }),
        { signal: context.request.signal },
      );
      if (prompted.status !== "accepted") {
        return await sessionCommandError(
          context,
          prompted.message,
          prompted.status === "rejected" ? 409 : 503,
        );
      }
      return sessionCommandAccepted(context, sessionId);
    },

    async abort(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.store.getSessionCatalogEntry(workspaceId, sessionId);
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const [snapshot, runnerId] = await Promise.all([
        Effect.runPromise(
          context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
        ),
        Effect.runPromise(
          context.services.runnerConnections.getSessionRunner(workspaceId, sessionId),
        ),
      ]);
      if (!snapshot || !runnerId) {
        return await sessionCommandError(context, "The pinned runner is offline.", 503);
      }
      if (snapshot.state !== "running") {
        return await sessionCommandError(context, "There is no active Pi run to abort.", 409);
      }

      const aborted = await Effect.runPromise(
        context.services.runnerConnections.abortSession({ workspaceId, sessionId }),
        { signal: context.request.signal },
      );
      if (aborted.status !== "accepted") {
        return await sessionCommandError(
          context,
          aborted.message,
          aborted.status === "rejected" ? 409 : 503,
        );
      }
      return sessionCommandAccepted(context, sessionId);
    },

    async stop(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.store.getSessionCatalogEntry(workspaceId, sessionId);
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const [snapshot, runnerId] = await Promise.all([
        Effect.runPromise(
          context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
        ),
        Effect.runPromise(
          context.services.runnerConnections.getSessionRunner(workspaceId, sessionId),
        ),
      ]);
      if (!snapshot || !runnerId) {
        return await sessionCommandError(context, "The pinned runner is offline.", 503);
      }
      if (snapshot.state !== "ready") {
        return await sessionCommandError(
          context,
          snapshot.state === "running"
            ? "Abort the active Pi run before stopping the session."
            : "The session is not ready and idle.",
          409,
        );
      }

      const stopped = await Effect.runPromise(
        context.services.runnerConnections.stopSession({ workspaceId, sessionId }),
        { signal: context.request.signal },
      );
      if (stopped.status !== "accepted") {
        return await sessionCommandError(
          context,
          stopped.message,
          stopped.status === "rejected" ? 409 : 503,
        );
      }
      return sessionCommandAccepted(context, sessionId);
    },

    async delete(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.store.getSessionCatalogEntry(workspaceId, sessionId);
      if (!session) return await sessionCommandError(context, "Session not found.", 404);

      const [deleted, deletionError] = await context.services.store.deleteSessionCatalogEntry(
        workspaceId,
        sessionId,
        new Date().toISOString(),
      );
      if (deletionError !== undefined) {
        return await sessionCommandError(context, deletionError.message, 500);
      }
      if (deleted === "not-found") {
        return new Response("Session not found.", { status: 404 });
      }

      await Effect.runPromise(
        context.services.runnerConnections.deleteSession({ workspaceId, sessionId }),
      );
      return redirect(routes.app.index.href(), 303);
    },

    async retry(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return new Response("Session not found.", { status: 404 });
      const session = await context.services.store.getSessionCatalogEntry(workspaceId, sessionId);
      if (!session) return new Response("Session not found.", { status: 404 });
      const parsed = s.parseSafe(retrySessionSchema, context.formData);
      if (!parsed.success) {
        return await renderDetailPage(context, "Choose an offered recovery action.", 400);
      }

      const runnerId = await Effect.runPromise(
        context.services.runnerConnections.getSessionRunner(workspaceId, sessionId),
      );
      if (!runnerId) {
        return await renderDetailPage(context, "The pinned runner is offline.", 409);
      }
      const snapshot = await Effect.runPromise(
        context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
      );
      if (!snapshot || snapshot.state !== "error") {
        return await renderDetailPage(
          context,
          "Only a failed session with an offered recovery action can be retried.",
          409,
        );
      }
      const recovery = currentSessionRecovery(snapshot.issues);
      if (recovery === undefined) {
        return await renderDetailPage(
          context,
          "This failure has no automatic recovery action.",
          409,
        );
      }
      if (parsed.value.recovery !== recovery) {
        return await renderDetailPage(
          context,
          "The offered recovery action changed. Review the current failure before trying again.",
          409,
        );
      }

      const [[githubToken, gitCredentialError], [modelApiKey, modelCredentialError]] = await Promise
        .all([
          context.services.store.getGitHubToken(workspaceId),
          context.services.store.getModelProviderApiKey(
            workspaceId,
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
      const modelRuntime = sessionModelRuntime(snapshot.model, modelApiKey);
      const recovered = recovery === "retry-provisioning"
        ? await Effect.runPromise(
          context.services.runnerConnections.provisionSession({
            workspaceId,
            runnerId,
            sessionId,
            payload: {
              mode: "retry",
              modelRuntime,
              ...(githubToken ? { githubToken } : {}),
            },
          }),
          { signal: context.request.signal },
        )
        : await Effect.runPromise(
          context.services.runnerConnections.wakeSession({
            workspaceId,
            sessionId,
            payload: {
              modelRuntime,
              recovery,
              ...(githubToken ? { githubToken } : {}),
            },
          }),
          { signal: context.request.signal },
        );
      if (recovered.status !== "accepted") {
        return await renderDetailPage(context, recovered.message, 503);
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
  const workspaceId = context.auth.identity.workspaceId;
  const [composer, sidebarSessions] = await Promise.all([
    loadSessionComposerData(workspaceId, context.services),
    context.services.store.listSessionCatalogEntries(workspaceId),
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

async function sessionCommandError(
  context: SessionDetailContext,
  error: string,
  status: number,
): Promise<Response> {
  if (prefersJson(context.request)) return Response.json({ error }, { status });
  return await renderDetailPage(context, error, status);
}

function sessionCommandAccepted(
  context: SessionDetailContext,
  sessionId: string,
): Response {
  if (prefersJson(context.request)) {
    return Response.json({ status: "accepted" }, { status: 202 });
  }
  return redirect(routes.app.sessions.detail.href({ sessionId }), 303);
}

function prefersJson(request: Request): boolean {
  return Accept.from(request.headers.get("Accept")).getPreferred([
    "text/html",
    "application/json",
  ]) === "application/json";
}

async function renderDetailPage(
  context: SessionDetailContext,
  error?: string,
  status = 200,
) {
  const workspaceId = context.auth.identity.workspaceId;
  const sessionId = parseSessionId(context.params.sessionId);
  if (!sessionId) return new Response("Session not found.", { status: 404 });
  const [composer, session, sidebarSessions] = await Promise.all([
    loadSessionComposerData(workspaceId, context.services),
    context.services.store.getSessionCatalogEntry(workspaceId, sessionId),
    context.services.store.listSessionCatalogEntries(workspaceId),
  ]);
  if (!session) return new Response("Session not found.", { status: 404 });
  const [runnerId, snapshot] = await Promise.all([
    Effect.runPromise(context.services.runnerConnections.getSessionRunner(workspaceId, sessionId)),
    Effect.runPromise(
      context.services.runnerConnections.getSessionSnapshot(workspaceId, sessionId),
    ),
  ]);
  return context.render(
    <SessionDetailPage
      composer={composer}
      csrfToken={getCsrfToken(context)}
      session={session}
      runnerId={runnerId}
      snapshot={snapshot}
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
    sessionId: stringField(formData, "sessionId"),
    projectId: stringField(formData, "projectId"),
    model: stringField(formData, "model"),
    ref: stringField(formData, "ref"),
    orbSize: stringField(formData, "orbSize"),
    branchName: stringField(formData, "branchName"),
    initialPrompt: stringField(formData, "initialPrompt"),
  };
}

function stringField(formData: FormData, name: string): string {
  const parsed = s.parseSafe(s.string(), formData.get(name));
  return parsed.success ? parsed.value : "";
}
