import { type Cookie, createCookie } from "remix/cookie";
import { auth, createSessionAuthScheme } from "remix/middleware/auth";
import { formData } from "remix/middleware/form-data";
import { render } from "remix/middleware/render";
import { session } from "remix/middleware/session";
import { createRouter, type Middleware, type RouterContext } from "remix/router";

import authController from "./actions/auth/controller.tsx";
import loginController from "./actions/auth/login/controller.tsx";
import setupController from "./actions/auth/setup/controller.tsx";
import appController from "./actions/app/controller.tsx";
import controller from "./actions/controller.tsx";
import projectsController from "./actions/projects/controller.tsx";
import sessionsController from "./actions/sessions/controller.tsx";
import settingsController from "./actions/settings/controller.tsx";
import settingsGitAuthorController from "./actions/settings/git-author/controller.tsx";
import settingsGitHubController from "./actions/settings/github/controller.tsx";
import settingsProvidersController from "./actions/settings/providers/controller.tsx";
import settingsRunnersController from "./actions/settings/runners/controller.tsx";
import settingsSecretsController from "./actions/settings/secrets/controller.tsx";
import apiRunnersController from "./actions/api/runners/controller.ts";
import apiSessionsController from "./actions/api/sessions/controller.ts";
import type { Administrator } from "./cells/workspace/api.ts";
import { type AppServices, AppServicesKey, provideAppServices } from "./middleware/services.ts";
import { rewriteTrailingSlash } from "./middleware/trailing-slash.ts";
import { redirectUnauthorizedPages } from "./middleware/unauthorized-page.ts";
import { routes } from "./routes.ts";
import {
  BROWSER_SESSION_MAX_AGE_SECONDS,
  parseBrowserSessionAuth,
} from "./utils/session-policy.ts";

export function createSessionCookie(options: { secure?: boolean; secret: string }): Cookie {
  if (!options.secret) throw new TypeError("SESSION_SECRET is required");
  const secret = options.secret;
  const secure = options.secure ?? false;

  return createCookie("openorb_session", {
    secrets: [secret],
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: BROWSER_SESSION_MAX_AGE_SECONDS,
  });
}

export function createAppRouter(services: AppServices, sessionCookie: Cookie) {
  const appRouter = createRouter({
    middleware: [
      rewriteTrailingSlash(),
      staticFiles(services),
      formData(),
      session(sessionCookie, services.sessionStorage),
      redirectUnauthorizedPages(),
      provideAppServices(services),
      auth({
        schemes: [
          createSessionAuthScheme<Administrator, Administrator>({
            read(currentSession) {
              const value = currentSession.get("auth");
              return parseBrowserSessionAuth(value);
            },
            async verify(value, context) {
              const currentServices = context.get(AppServicesKey);
              if (!currentServices) {
                throw new TypeError("App services middleware is missing.");
              }
              const identity = await currentServices.workspace.getAdministrator(value.userId);
              return identity?.workspaceId === value.workspaceId ? identity : null;
            },
            invalidate(currentSession) {
              currentSession.unset("auth");
            },
          }),
        ],
      }),
      render({ assets: services.assets }),
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

/**
 * Root public files and compiled browser assets are public and need no browser session, so they
 * are served before the session and auth middleware, which each cost a Workspace DO call.
 */
function staticFiles(services: AppServices): Middleware {
  return async (context, next) => {
    if (context.request.method !== "GET" && context.request.method !== "HEAD") return next();

    return (
      (await services.assets.fetchPublic(context.request)) ??
      (await services.assets.fetch(context.request)) ??
      next()
    );
  };
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppContext = RouterContext<AppRouter>;

declare module "remix" {
  interface RouterTypes {
    context: AppContext;
  }
}
