import {
  DEFAULT_SESSION_THINKING_LEVEL,
  modelReferenceSchema,
  type OrbSize,
  orbSizeSchema,
} from "@openorb/protocol";
import {
  initialPromptPreview,
  isSafeGitReference,
  MAX_RPC_INITIAL_PROMPT_BYTES,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { tryAsync } from "@openorb/result";
import { validate as validateUuid } from "@std/uuid";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { Accept } from "remix/headers/accept";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { type ContextWithParams, createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import { AppPage } from "@/app/actions/app/page.tsx";
import { SessionDetailFrame, SessionDetailPage } from "@/app/actions/sessions/page.tsx";
import type { Administrator } from "@/app/cells/workspace/api.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import { selectRunnerForWorkspace } from "@/app/cells/runners/runner-selection.ts";
import type { SessionPlacement } from "@/app/cells/session/environment/provider.ts";
import type { AppServices } from "@/app/middleware/services.ts";
import { routes } from "@/app/routes.ts";
import { loadSessionComposerData } from "@/app/session-composer-data.ts";
import { isModelReference } from "@/app/model-provider-catalog.ts";
import { resolveSessionModelRuntime } from "@/app/model-provider-runtime.ts";
import type { SessionComposerValues } from "@/app/ui/public/session-composer.tsx";
import { SessionWorkspaceLoadError } from "@/app/ui/public/shell.tsx";
import { currentSessionRecovery } from "@/app/utils/session-recovery.ts";

const sessionIdSchema = s.string().refine(validateUuid, "Expected a session UUID.");
/** Empty for a Session without a project. */
const projectIdSchema = s.string().refine(
  (value) => value === "" || s.parseSafe(sessionIdSchema, value).success,
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
const thinkingLevelSchema = s.union([
  s.literal("off" as const),
  s.literal("minimal" as const),
  s.literal("low" as const),
  s.literal("medium" as const),
  s.literal("high" as const),
  s.literal("xhigh" as const),
  s.literal("max" as const),
]);

const environmentSchema = s.union([s.literal("sandbox" as const), s.literal("runner" as const)]);
const createSessionSchema = f.object({
  projectId: f.field(projectIdSchema),
  model: f.field(modelReferenceSchema),
  ref: f.field(sessionGitRefSchema),
  environment: f.field(environmentSchema),
  runnerId: f.field(s.string()),
  orbSize: f.field(orbSizeSchema),
  branchName: f.field(sessionBranchNameSchema),
  thinkingLevel: f.field(s.optional(thinkingLevelSchema)),
  initialPrompt: f.field(promptSchema),
});
const continueSessionSchema = f.object({
  prompt: f.field(promptSchema),
  thinkingLevel: f.field(s.optional(thinkingLevelSchema)),
});
const setThinkingLevelSchema = f.object({
  thinkingLevel: f.field(thinkingLevelSchema),
});
const retrySessionSchema = f.object({
  recovery: f.field(s.union([
    s.literal("retry-provisioning" as const),
    s.literal("restart-environment" as const),
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

      const { workspace } = context.services;
      const workspaceId = context.auth.identity.workspaceId;
      // The Sandbox inspects untrusted content and never checks out a project (ADR 0007).
      const projectId = parsed.value.environment === "sandbox" ? "" : parsed.value.projectId;
      const project = projectId === "" ? undefined : await workspace.getProject(
        workspaceId,
        projectId,
      );
      if (project === null) {
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
      const placement = await placeSession(parsed.value, workspaceId, context.services);
      if ("rejected" in placement) {
        return await renderCreateError(context, placement.rejected, 409, submitted);
      }

      const [[modelRuntime, modelCredentialError], gitAuthor] = await Promise.all([
        resolveSessionModelRuntime(workspaceId, parsed.value.model, workspace),
        workspace.getGitAuthorConfiguration(context.auth.identity.userId),
      ]);
      if (modelCredentialError !== undefined) {
        return await renderCreateError(
          context,
          "The saved model provider credential could not be read.",
          500,
          submitted,
        );
      }
      if (modelRuntime === null) {
        return await renderCreateError(
          context,
          "Configure the selected model provider before starting a session.",
          409,
          submitted,
        );
      }
      if (project !== undefined && gitAuthor === null) {
        return await renderCreateError(
          context,
          "Configure your Git author name and email before starting a session with a project.",
          409,
          submitted,
        );
      }

      const sessionId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      // The catalog entry first, so a Session that fails to start is still visible and deletable.
      const [catalog, catalogError] = await workspace.reconcileSessionManifestEntries(workspaceId, [
        {
          id: sessionId,
          ...(project === undefined ? {} : { projectId: project.id }),
          createdAt,
          initialPromptPreview: initialPromptPreview(parsed.value.initialPrompt),
        },
      ]);
      if (catalogError !== undefined) {
        return await renderCreateError(
          context,
          "The session could not be recorded.",
          500,
          submitted,
        );
      }
      if (!catalog.acceptedSessionIds.includes(sessionId)) {
        return await renderCreateError(
          context,
          "The session could not be recorded.",
          500,
          submitted,
        );
      }
      const [, createError] = await sessionCall(
        context.services.sessions(sessionId).create({
          workspaceId,
          sessionId,
          ...(project === undefined || gitAuthor === null ? {} : {
            project: {
              id: project.id,
              repositoryUrl: project.repositoryUrl,
              ref: parsed.value.ref,
              branchName: parsed.value.branchName,
              gitAuthor: { name: gitAuthor.authorName, email: gitAuthor.authorEmail },
            },
          }),
          createdAt,
          placement,
          orbSize: parsed.value.orbSize,
          model: parsed.value.model,
          thinkingLevel: parsed.value.thinkingLevel ?? DEFAULT_SESSION_THINKING_LEVEL,
          initialPrompt: parsed.value.initialPrompt,
        }),
      );
      if (createError !== undefined) {
        await workspace.deleteSessionCatalogEntry(workspaceId, sessionId, new Date().toISOString());
        return await renderCreateError(context, createError, 503, submitted);
      }

      return redirect(routes.app.sessions.detail.href({ sessionId }), 303);
    },

    async detail(context) {
      return await renderDetailPage(context);
    },

    async frame(context) {
      return await renderDetailFrame(context);
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
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const sessionApi = context.services.sessions(sessionId);
      const [snapshot, viewError] = await sessionCall(sessionApi.view());
      if (viewError !== undefined) {
        return await sessionCommandError(context, "The session is unavailable.", 503);
      }
      if (snapshot === null) return await sessionCommandError(context, "Session not found.", 404);
      if (snapshot.agentState === "error") {
        return await sessionCommandError(
          context,
          "The session cannot accept a prompt right now.",
          409,
        );
      }
      const [modelRuntime, modelCredentialError] = await resolveSessionModelRuntime(
        workspaceId,
        snapshot.model,
        context.services.workspace,
      );
      if (modelCredentialError !== undefined) {
        return await sessionCommandError(
          context,
          "The saved model provider credential could not be read.",
          500,
        );
      }
      if (modelRuntime === null) {
        return await sessionCommandError(
          context,
          "Reconfigure this session's model provider before continuing.",
          409,
        );
      }
      const [, promptError] = await sessionCall(sessionApi.submit({
        prompt: parsed.value.prompt,
        requestId: crypto.randomUUID(),
        ...(parsed.value.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: parsed.value.thinkingLevel }),
      }));
      if (promptError !== undefined) {
        return await sessionCommandError(context, promptError, 503);
      }
      return sessionCommandAccepted(context, sessionId);
    },

    async thinkingLevel(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const parsed = s.parseSafe(setThinkingLevelSchema, context.formData);
      if (!parsed.success) {
        return await sessionCommandError(context, "Choose a valid thinking level.", 400);
      }
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const [level, levelError] = await sessionCall(
        context.services.sessions(sessionId).setThinkingLevel(parsed.value.thinkingLevel),
      );
      if (levelError !== undefined) return await sessionCommandError(context, levelError, 409);
      return Response.json({ status: "accepted", level }, { status: 202 });
    },

    async abort(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const sessionApi = context.services.sessions(sessionId);
      const [snapshot] = await sessionCall(sessionApi.view());
      if (snapshot?.agentState !== "running") {
        return await sessionCommandError(context, "There is no active Pi run to abort.", 409);
      }
      const [, abortError] = await sessionCall(sessionApi.abort());
      if (abortError !== undefined) return await sessionCommandError(context, abortError, 503);
      return sessionCommandAccepted(context, sessionId);
    },

    async stop(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return await sessionCommandError(context, "Session not found.", 404);
      const sessionApi = context.services.sessions(sessionId);
      const [snapshot] = await sessionCall(sessionApi.view());
      if (
        snapshot === undefined || snapshot === null ||
        snapshot.agentState === "paused" && snapshot.environmentState === "stopped"
      ) {
        return await sessionCommandError(
          context,
          "The session cannot be stopped right now.",
          409,
        );
      }
      const [, stopError] = await sessionCall(sessionApi.stop());
      if (stopError !== undefined) return await sessionCommandError(context, stopError, 503);
      return sessionCommandAccepted(context, sessionId);
    },

    async delete(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return await sessionCommandError(context, "Session not found.", 404);
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return await sessionCommandError(context, "Session not found.", 404);

      const [deleted, deletionError] = await context.services.workspace.deleteSessionCatalogEntry(
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

      // Compute and Session storage are removed in the background; the alarm retries offline runners.
      await sessionCall(context.services.sessions(sessionId).delete());
      return redirect(routes.app.index.href(), 303);
    },

    async retry(context) {
      const workspaceId = context.auth.identity.workspaceId;
      const sessionId = parseSessionId(context.params.sessionId);
      if (!sessionId) return new Response("Session not found.", { status: 404 });
      const session = await context.services.workspace.getSessionCatalogEntry(
        workspaceId,
        sessionId,
      );
      if (!session) return new Response("Session not found.", { status: 404 });
      const parsed = s.parseSafe(retrySessionSchema, context.formData);
      if (!parsed.success) {
        return await renderDetailPage(context, "Choose an offered recovery action.", 400);
      }

      const sessionApi = context.services.sessions(sessionId);
      const [snapshot] = await sessionCall(sessionApi.view());
      if (!snapshot || snapshot.state !== "error") {
        return await renderDetailPage(
          context,
          "Only a failed session with an offered recovery action can be retried.",
          409,
        );
      }
      const recovery = currentSessionRecovery(snapshot.issues) ??
        (snapshot.environmentState === "error" ? "restart-environment" : undefined);
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
      const [, retryError] = await sessionCall(sessionApi.retry(recovery));
      if (retryError !== undefined) return await renderDetailPage(context, retryError, 503);
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
    context.services.workspace.listSessionNavigationEntries(workspaceId),
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
    context.services.workspace.getSessionCatalogEntry(workspaceId, sessionId),
    context.services.workspace.listSessionNavigationEntries(workspaceId),
  ]);
  if (!session) return new Response("Session not found.", { status: 404 });
  return context.render(
    <SessionDetailPage
      composer={composer}
      csrfToken={getCsrfToken(context)}
      frameSrc={error === undefined ? undefined : sessionErrorFrameHref(sessionId, error)}
      session={session}
      sidebarSessions={sidebarSessions}
    />,
    { status },
  );
}

async function renderDetailFrame(context: SessionDetailContext) {
  const workspaceId = context.auth.identity.workspaceId;
  const sessionId = parseSessionId(context.params.sessionId);
  if (!sessionId) return renderMissingSessionFrame(context);
  const session = await context.services.workspace.getSessionCatalogEntry(
    workspaceId,
    sessionId,
  );
  if (!session) return renderMissingSessionFrame(context);
  const error = new URL(context.request.url).searchParams.get("error") || undefined;
  const [view] = await sessionCall(context.services.sessions(sessionId).view());
  const snapshot = view ?? null; // Unavailable and deleted Sessions both render offline.
  return context.render(
    <SessionDetailFrame
      csrfToken={getCsrfToken(context)}
      error={error}
      session={session}
      snapshot={snapshot}
    />,
  );
}

function renderMissingSessionFrame(context: SessionDetailContext) {
  return context.render(
    <SessionWorkspaceLoadError
      message="This session no longer exists. Choose another session from the sidebar."
      title="Session not found"
    />,
    { status: 404 },
  );
}

function sessionErrorFrameHref(sessionId: string, error: string): string {
  const href = routes.app.sessions.frame.href({ sessionId });
  return `${href}?${new URLSearchParams({ error })}`;
}

function parseSessionId(value: string): string | null {
  return s.parseSafe(sessionIdSchema, value).success ? value : null;
}

/** Where a new Session runs: the built-in Sandbox, or an available runner (ADR 0007). */
async function placeSession(
  input: {
    readonly environment: "sandbox" | "runner";
    readonly runnerId: string;
    readonly orbSize: OrbSize;
  },
  workspaceId: WorkspaceId,
  services: Pick<AppServices, "workspace" | "runnerConnections">,
): Promise<SessionPlacement | { readonly rejected: string }> {
  if (input.environment === "sandbox") return { provider: "sandbox" };
  const selected = await selectRunnerForWorkspace(
    workspaceId,
    input.runnerId.trim() || undefined,
    input.orbSize,
    services.workspace,
    services.runnerConnections,
  );
  return selected.status === "rejected"
    ? { rejected: selected.message }
    : { provider: "runner", runnerId: selected.runner.id };
}

function submittedValues(formData: FormData): SessionComposerValues {
  return {
    projectId: stringField(formData, "projectId"),
    model: stringField(formData, "model"),
    ref: stringField(formData, "ref"),
    orbSize: stringField(formData, "orbSize"),
    environment: stringField(formData, "environment"),
    branchName: stringField(formData, "branchName"),
    thinkingLevel: stringField(formData, "thinkingLevel"),
    initialPrompt: stringField(formData, "initialPrompt"),
  };
}

function stringField(formData: FormData, name: string): string {
  const parsed = s.parseSafe(s.string(), formData.get(name));
  return parsed.success ? parsed.value : "";
}

/** Session Durable Object calls; their errors carry user-facing messages across native RPC. */
async function sessionCall<T>(call: Promise<T>) {
  return await tryAsync(
    call,
    (cause) => cause instanceof Error ? cause.message : "The session is unavailable.",
  );
}
