import { createCookie, type Cookie } from "remix/cookie";
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
import type { Administrator } from "./data/administrator-repository.ts";
import { ControlRuntimeKey, provideControlRuntime, type ControlRuntime } from "./data/runtime.ts";
import { render } from "./middleware/render.tsx";
import { routes } from "./routes.ts";
import { BROWSER_SESSION_MAX_AGE_SECONDS } from "./session-policy.ts";

export function createSessionCookie(options: { secure?: boolean; secret?: string } = {}): Cookie {
  const secret = options.secret ?? process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV !== "test") {
    throw new Error("SESSION_SECRET is required outside tests.");
  }

  const secure =
    options.secure ??
    (process.env.NODE_ENV === "production" || process.env.OPENORB_SESSION_COOKIE_SECURE === "true");

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
  runtime: ControlRuntime,
  sessionCookie: Cookie = createSessionCookie(),
) {
  const appRouter = createRouter({
    middleware: [
      staticFiles("./public", { index: false }),
      formData(),
      session(sessionCookie, runtime.store.sessionStorage),
      provideControlRuntime(runtime),
      auth({
        schemes: [
          createSessionAuthScheme<Administrator, { userId: number }>({
            read(currentSession) {
              const value = currentSession.get("auth");
              return isAuthSession(value) ? value : null;
            },
            async verify(value, context) {
              const currentRuntime = context.get(ControlRuntimeKey);
              if (!currentRuntime) {
                throw new Error("Control runtime middleware is missing.");
              }
              return currentRuntime.store.getAdministrator(value.userId);
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

  return appRouter;
}

function isAuthSession(value: unknown): value is { userId: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "userId" in value &&
    typeof value.userId === "number" &&
    Number.isInteger(value.userId)
  );
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppContext = RouterContext<AppRouter>;

declare module "remix/router" {
  interface RouterTypes {
    context: AppContext;
  }
}
