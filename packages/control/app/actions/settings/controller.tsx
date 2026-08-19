import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import type { InferOutput } from "remix/data-schema";
import { runnerIdSchema } from "@openorb/protocol";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { isReservedGitCredentialSecretKey } from "@/app/data/git-configuration-repository.ts";
import type { RunnerRecord } from "@/app/data/runner-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import type { RunnerConnectionRegistry } from "@/app/runner-connection-gateway.ts";
import { routes } from "@/app/routes.ts";
import {
  SettingsPage,
  type SettingsRunner,
  type SettingsTab,
  settingsTabHref,
} from "@/app/actions/settings/page.tsx";

const secretKeySchema = s.string().refine(
  (value) => {
    const key = value.trim();
    return key.length > 0 &&
      key.length <= 64 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !isReservedGitCredentialSecretKey(key);
  },
  'Start with a letter or underscore and use only letters, digits, and underscores, such as "OPENCODE_API_KEY". OPENORB_GITHUB_TOKEN_ names are reserved.',
);

const saveSchema = f.object({
  intent: f.field(s.literal("save")),
  key: f.field(secretKeySchema),
  value: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The API key is required.")
      .refine((value) => value.trim().length <= 4096, "The API key is too long."),
  ),
});

const deleteSchema = f.object({
  intent: f.field(s.literal("delete")),
  key: f.field(secretKeySchema),
});

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

const regenerateEnrollmentTokenSchema = f.object({
  intent: f.field(s.literal("regenerate-enrollment-token")),
});

const revokeRunnerSchema = f.object({
  intent: f.field(s.literal("revoke-runner")),
  runnerId: f.field(runnerIdSchema),
});

const deleteRunnerSchema = f.object({
  intent: f.field(s.literal("delete-runner")),
  runnerId: f.field(runnerIdSchema),
});

const settingsIntentSchema = s.union([
  s.literal("save" as const),
  s.literal("delete" as const),
  s.literal("save-github-credential" as const),
  s.literal("delete-github-credential" as const),
  s.literal("save-git-author" as const),
  s.literal("regenerate-enrollment-token" as const),
  s.literal("revoke-runner" as const),
  s.literal("delete-runner" as const),
]);

type SettingsContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;
type SettingsIntent = InferOutput<typeof settingsIntentSchema>;
type ActionHandler = (context: SettingsContext) => Promise<Response>;

const actionHandlers = {
  save: saveSecret,
  delete: deleteSecret,
  "save-github-credential": saveGitHubCredential,
  "delete-github-credential": deleteGitHubCredential,
  "save-git-author": saveGitAuthor,
  "regenerate-enrollment-token": regenerateEnrollmentToken,
  "revoke-runner": revokeRunner,
  "delete-runner": deleteRunner,
} satisfies Record<SettingsIntent, ActionHandler>;

export default createController(routes.app.settings, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderSettings(context);
    },

    async action(context) {
      const parsedIntent = s.parseSafe(settingsIntentSchema, context.formData.get("intent"));
      const intent = parsedIntent.success ? parsedIntent.value : null;
      const handler = intent === null ? undefined : actionHandlers[intent];
      return handler
        ? await handler(context)
        : await renderSettings(context, "Invalid settings form submission.", 400, intent);
    },
  },
});

async function renderSettings(
  context: SettingsContext,
  error?: string,
  status = 200,
  intent?: FormDataEntryValue | null,
): Promise<Response> {
  const userId = context.auth.identity.id;
  const { store } = context.services;
  const [secrets, githubCredential, gitAuthor, enrollmentToken, runners] = await Promise.all([
    store.listSecrets(userId),
    store.getGitHubCredential(userId),
    store.getGitAuthorConfiguration(userId),
    store.getRunnerEnrollmentToken(userId),
    store.listRunners(userId),
  ]);
  return context.render(
    <SettingsPage
      csrfToken={getCsrfToken(context)}
      controlPanelUrl={runnerControlPanelUrl(context.request)}
      secrets={secrets}
      githubCredential={githubCredential}
      gitAuthor={gitAuthor}
      enrollmentToken={enrollmentToken}
      runners={settingsRunners(userId, runners, context.services.runnerConnections)}
      activeTab={settingsTabFromRequest(context.request, intent)}
      error={error}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function saveSecret(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(saveSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      parsed.issues[0]?.message ?? "Invalid secret form submission.",
      400,
      "save",
    );
  }
  await context.services.store.saveSecret(
    context.auth.identity.id,
    parsed.value.key.trim(),
    parsed.value.value.trim(),
  );
  return redirect(settingsTabHref("secrets"), 303);
}

async function deleteSecret(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(deleteSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      parsed.issues[0]?.message ?? "Invalid secret deletion.",
      400,
      "delete",
    );
  }
  await context.services.store.deleteSecret(context.auth.identity.id, parsed.value.key.trim());
  return redirect(settingsTabHref("secrets"), 303);
}

async function saveGitHubCredential(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(saveGitHubCredentialSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      parsed.issues[0]?.message ?? "Invalid GitHub credential.",
      400,
      "save-github-credential",
    );
  }
  await context.services.store.saveGitHubCredential(
    context.auth.identity.id,
    parsed.value.token.trim(),
  );
  return redirect(settingsTabHref("github"), 303);
}

async function deleteGitHubCredential(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(deleteGitHubCredentialSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      "Invalid GitHub credential deletion.",
      400,
      "delete-github-credential",
    );
  }
  const result = await context.services.store.deleteGitHubCredential(context.auth.identity.id);
  if (result.status === "not-found") {
    return await renderSettings(
      context,
      "The GitHub credential no longer exists.",
      404,
      "delete-github-credential",
    );
  }
  return redirect(settingsTabHref("github"), 303);
}

async function saveGitAuthor(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(saveGitAuthorSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      parsed.issues[0]?.message ?? "Invalid Git author identity.",
      400,
      "save-git-author",
    );
  }
  await context.services.store.saveGitAuthorConfiguration(context.auth.identity.id, {
    authorName: parsed.value.authorName.trim(),
    authorEmail: parsed.value.authorEmail.trim(),
  });
  return redirect(settingsTabHref("git-author"), 303);
}

async function regenerateEnrollmentToken(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(regenerateEnrollmentTokenSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      "Invalid enrollment token request.",
      400,
      "regenerate-enrollment-token",
    );
  }
  await context.services.store.regenerateRunnerEnrollmentToken(context.auth.identity.id);
  return redirect(settingsTabHref("runners"), 303);
}

async function revokeRunner(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(revokeRunnerSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(
      context,
      "Invalid runner revocation request.",
      400,
      "revoke-runner",
    );
  }
  const userId = context.auth.identity.id;
  const result = await context.services.store.revokeRunner(userId, parsed.value.runnerId);
  if (result === "not-found") {
    return await renderSettings(context, "Runner not found.", 404, "revoke-runner");
  }
  context.services.runnerConnections.disconnectRunner(userId, parsed.value.runnerId);
  return redirect(settingsTabHref("runners"), 303);
}

async function deleteRunner(context: SettingsContext): Promise<Response> {
  const parsed = s.parseSafe(deleteRunnerSchema, context.formData);
  if (!parsed.success) {
    return await renderSettings(context, "Invalid runner deletion request.", 400, "delete-runner");
  }
  const result = await context.services.store.deleteRunner(
    context.auth.identity.id,
    parsed.value.runnerId,
  );
  if (result === "not-found") {
    return await renderSettings(context, "Runner not found.", 404, "delete-runner");
  }
  if (result === "not-revoked") {
    return await renderSettings(
      context,
      "Revoke the runner before deleting it.",
      409,
      "delete-runner",
    );
  }
  return redirect(settingsTabHref("runners"), 303);
}

function settingsTabFromRequest(request: Request, intent?: FormDataEntryValue | null): SettingsTab {
  const tab = new URL(request.url).searchParams.get("tab");
  if (tab === "github" || tab === "git-author" || tab === "runners" || tab === "secrets") {
    return tab;
  }
  if (intent === "save-github-credential" || intent === "delete-github-credential") return "github";
  if (intent === "save-git-author") return "git-author";
  if (
    intent === "regenerate-enrollment-token" || intent === "revoke-runner" ||
    intent === "delete-runner"
  ) return "runners";
  return "secrets";
}

function runnerControlPanelUrl(request: Request): string {
  const publicUrl = Deno.env.get("PUBLIC_URL");
  return new URL(publicUrl ?? request.url).origin;
}

function settingsRunners(
  userId: string,
  runners: RunnerRecord[],
  connections: RunnerConnectionRegistry,
): SettingsRunner[] {
  return runners.map((runner) => {
    const liveState = runner.revokedAt === null
      ? connections.getRunnerLiveState(userId, runner.id)
      : null;
    return {
      id: runner.id,
      name: runner.name,
      architecture: runner.architecture,
      status: runner.revokedAt !== null ? "revoked" : liveState ? "online" : "offline",
      capacity: liveState?.capacity ?? null,
    };
  });
}
