import { runnerIdSchema } from "@openorb/protocol";
import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController, type MiddlewareContext } from "remix/router";
import { redirect } from "remix/response/redirect";
import { Effect } from "effect";

import { RunnersSettingsPage, type SettingsRunner } from "@/app/actions/settings/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import type { RunnerRecord } from "@/app/data/runner-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import type { AppContext } from "@/app/router.ts";
import type { RunnerRegistryService } from "@/app/runner-registry.ts";
import { routes } from "@/app/routes.ts";

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

type RunnersContext = MiddlewareContext<
  [ReturnType<typeof requireAuth<Administrator>>, ReturnType<typeof csrf>],
  AppContext
>;

export default createController(routes.app.settings.runners, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      return await renderRunners(context);
    },

    async action(context) {
      switch (context.formData.get("intent")) {
        case "regenerate-enrollment-token": {
          const parsed = s.parseSafe(regenerateEnrollmentTokenSchema, context.formData);
          if (!parsed.success) {
            return await renderRunners(context, "Invalid enrollment token request.", 400);
          }
          await context.services.store.regenerateRunnerEnrollmentToken(context.auth.identity.id);
          return redirect(routes.app.settings.runners.index.href(), 303);
        }
        case "revoke-runner": {
          const parsed = s.parseSafe(revokeRunnerSchema, context.formData);
          if (!parsed.success) {
            return await renderRunners(context, "Invalid runner revocation request.", 400);
          }
          const userId = context.auth.identity.id;
          const result = await context.services.store.revokeRunner(userId, parsed.value.runnerId);
          if (result === "not-found") {
            return await renderRunners(context, "Runner not found.", 404);
          }
          await Effect.runPromise(
            context.services.runnerConnections.disconnectRunner(userId, parsed.value.runnerId),
            { signal: context.request.signal },
          );
          return redirect(routes.app.settings.runners.index.href(), 303);
        }
        case "delete-runner": {
          const parsed = s.parseSafe(deleteRunnerSchema, context.formData);
          if (!parsed.success) {
            return await renderRunners(context, "Invalid runner deletion request.", 400);
          }
          const result = await context.services.store.deleteRunner(
            context.auth.identity.id,
            parsed.value.runnerId,
          );
          if (result === "not-found") {
            return await renderRunners(context, "Runner not found.", 404);
          }
          if (result === "not-revoked") {
            return await renderRunners(context, "Revoke the runner before deleting it.", 409);
          }
          return redirect(routes.app.settings.runners.index.href(), 303);
        }
        default:
          return await renderRunners(context, "Invalid runner form submission.", 400);
      }
    },
  },
});

async function renderRunners(
  context: RunnersContext,
  error?: string,
  status = 200,
): Promise<Response> {
  const userId = context.auth.identity.id;
  const [enrollmentToken, runners] = await Promise.all([
    context.services.store.getRunnerEnrollmentToken(userId),
    context.services.store.listRunners(userId),
  ]);
  return context.render(
    <RunnersSettingsPage
      csrfToken={getCsrfToken(context)}
      enrollmentToken={enrollmentToken}
      error={error}
      gatewayUrl={runnerGatewayUrl(context.request)}
      runners={await settingsRunners(userId, runners, context.services.runnerConnections)}
    />,
    { status, headers: { "cache-control": "no-store" } },
  );
}

function runnerGatewayUrl(request: Request): string {
  const publicUrl = Deno.env.get("PUBLIC_URL");
  return new URL(publicUrl ?? request.url).origin;
}

async function settingsRunners(
  userId: string,
  runners: RunnerRecord[],
  connections: RunnerRegistryService,
): Promise<SettingsRunner[]> {
  return await Promise.all(runners.map(async (runner) => {
    const liveState = runner.revokedAt === null
      ? await Effect.runPromise(connections.getRunnerLiveState(userId, runner.id))
      : null;
    return {
      id: runner.id,
      name: runner.name,
      architecture: runner.architecture,
      status: runner.revokedAt !== null ? "revoked" : liveState ? "online" : "offline",
      capacity: liveState?.capacity ?? null,
    };
  }));
}
