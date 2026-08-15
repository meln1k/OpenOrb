import { type Cookie, createCookie } from "remix/cookie";
import { v7 } from "@std/uuid";
import { auth, createSessionAuthScheme } from "remix/middleware/auth";
import { formData } from "remix/middleware/form-data";
import { session } from "remix/middleware/session";
import { staticFiles } from "remix/middleware/static";
import { createRouter, type RouterContext } from "remix/router";

import authController from "./actions/auth/controller.tsx";
import loginController from "./actions/auth/login/controller.tsx";
import setupController from "./actions/auth/setup/controller.tsx";
import appController from "./actions/app/controller.tsx";
import controller from "./actions/controller.tsx";
import projectsController from "./actions/projects/controller.tsx";
import runnersController from "./actions/runners/controller.tsx";
import settingsController from "./actions/settings/controller.tsx";
import apiRunnersController from "./actions/api/runners/controller.ts";
import type { Administrator } from "./data/administrator-repository.ts";
import { type AppServices, AppServicesKey, provideAppServices } from "./middleware/services.ts";
import { render } from "./middleware/render.tsx";
import { routes } from "./routes.ts";
import { BROWSER_SESSION_MAX_AGE_SECONDS } from "./utils/session-policy.ts";

export function createSessionCookie(options: { secure?: boolean; secret?: string } = {}): Cookie {
  const secret = options.secret ?? Deno.env.get("SESSION_SECRET");
  if (!secret && Deno.env.get("NODE_ENV") !== "test") {
    throw new Error("SESSION_SECRET is required outside tests.");
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
      staticFiles("./public", { index: false }),
      formData(),
      session(sessionCookie, services.store.sessionStorage),
      provideAppServices(services),
      auth({
        schemes: [
          createSessionAuthScheme<Administrator, { userId: string }>({
            read(currentSession) {
              const value = currentSession.get("auth");
              return isAuthSession(value) ? value : null;
            },
            verify(value, context) {
              const currentServices = context.get(AppServicesKey);
              if (!currentServices) {
                throw new Error("App services middleware is missing.");
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
  appRouter.map(routes.app.runners, runnersController);
  appRouter.map(routes.app.settings, settingsController);
  appRouter.map(routes.api.runners, apiRunnersController);

  return appRouter;
}

function isAuthSession(value: unknown): value is { userId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "userId" in value &&
    typeof value.userId === "string" &&
    v7.validate(value.userId)
  );
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppContext = RouterContext<AppRouter>;

declare module "remix/router" {
  interface RouterTypes {
    context: AppContext;
  }
}
