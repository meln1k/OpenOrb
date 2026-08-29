import { type Cookie, createCookie } from "remix/cookie";
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { auth, createSessionAuthScheme } from "remix/middleware/auth";
import { formData } from "remix/middleware/form-data";
import { session } from "remix/middleware/session";
import { createRouter, type Middleware, type RouterContext } from "remix/router";

import authController from "@/app/actions/auth/controller.tsx";
import loginController from "@/app/actions/auth/login/controller.tsx";
import setupController from "@/app/actions/auth/setup/controller.tsx";
import appController from "@/app/actions/app/controller.tsx";
import controller from "@/app/actions/controller.tsx";
import projectsController from "@/app/actions/projects/controller.tsx";
import sessionsController from "@/app/actions/sessions/controller.tsx";
import settingsController from "@/app/actions/settings/controller.tsx";
import settingsGitAuthorController from "@/app/actions/settings/git-author/controller.tsx";
import settingsGitHubController from "@/app/actions/settings/github/controller.tsx";
import settingsProvidersController from "@/app/actions/settings/providers/controller.tsx";
import settingsRunnersController from "@/app/actions/settings/runners/controller.tsx";
import settingsSecretsController from "@/app/actions/settings/secrets/controller.tsx";
import apiRunnersController from "@/app/actions/api/runners/controller.ts";
import apiSessionsController from "@/app/actions/api/sessions/controller.ts";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { type AppServices, AppServicesKey, provideAppServices } from "@/app/middleware/services.ts";
import { render } from "@/app/middleware/render.tsx";
import { routes } from "@/app/routes.ts";
import {
  BROWSER_SESSION_MAX_AGE_SECONDS,
  parseBrowserSessionAuth,
} from "@/app/utils/session-policy.ts";

const PUBLIC_DIRECTORY = fromFileUrl(new URL("../public/", import.meta.url));

export function createSessionCookie(options: { secure?: boolean; secret?: string } = {}): Cookie {
  const secret = options.secret ?? Deno.env.get("SESSION_SECRET");
  if (!secret && Deno.env.get("NODE_ENV") !== "test") {
    throw new SessionConfigurationError("SESSION_SECRET is required outside tests.");
  }

  const secure = options.secure ??
    (Deno.env.get("NODE_ENV") === "production" ||
      Deno.env.get("OPENORB_SESSION_COOKIE_SECURE") === "true");

  return createCookie("openorb_session", {
    secrets: [secret ?? "test-only-session-secret"],
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: BROWSER_SESSION_MAX_AGE_SECONDS,
  });
}

export function createAppRouter(
  services: AppServices,
  sessionCookie: Cookie = createSessionCookie(),
) {
  const appRouter = createRouter({
    middleware: [
      publicFiles(),
      formData(),
      session(sessionCookie, services.store.sessionStorage),
      provideAppServices(services),
      auth({
        schemes: [
          createSessionAuthScheme<Administrator, { userId: string }>({
            read(currentSession) {
              const value = currentSession.get("auth");
              return parseBrowserSessionAuth(value);
            },
            verify(value, context) {
              const currentServices = context.get(AppServicesKey);
              if (!currentServices) {
                throw new TypeError("App services middleware is missing.");
              }
              return currentServices.store.getAdministrator(value.userId);
            },
            invalidate(currentSession) {
              currentSession.unset("auth");
            },
          }),
        ],
      }),
      render(),
    ],
  });

  appRouter.map(routes, controller);
  appRouter.map(routes.auth, authController);
  appRouter.map(routes.auth.login, loginController);
  appRouter.map(routes.auth.setup, setupController);
  appRouter.map(routes.app, appController);
  appRouter.map(routes.app.projects, projectsController);
  appRouter.map(routes.app.sessions, sessionsController);
  appRouter.map(routes.app.settings, settingsController);
  appRouter.map(routes.app.settings.providers, settingsProvidersController);
  appRouter.map(routes.app.settings.secrets, settingsSecretsController);
  appRouter.map(routes.app.settings.github, settingsGitHubController);
  appRouter.map(routes.app.settings.gitAuthor, settingsGitAuthorController);
  appRouter.map(routes.app.settings.runners, settingsRunnersController);
  appRouter.map(routes.api.runners, apiRunnersController);
  appRouter.map(routes.api.sessions, apiSessionsController);

  return appRouter;
}

class SessionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConfigurationError";
  }
}

function publicFiles(): Middleware {
  return async (context, next) => {
    if (context.request.method !== "GET" && context.request.method !== "HEAD") return next();

    const response = await serveDir(context.request, {
      fsRoot: PUBLIC_DIRECTORY,
      quiet: true,
      showIndex: false,
    });
    return response.status === 404 ? next() : response;
  };
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppContext = RouterContext<AppRouter>;

declare module "remix/router" {
  interface RouterTypes {
    context: AppContext;
  }
}
