import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { completeAuth, createCredentialsAuthProvider, verifyCredentials } from "remix/auth";
import { csrf, getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { AppServicesKey, requestRateLimitKey } from "../../../middleware/services.ts";
import { routes } from "../../../routes.ts";
import { LoginPage } from "./page.tsx";

const loginSchema = f.object({
  password: f.field(s.string().refine((value) => value.length > 0, "Password is required.")),
});

const passwordProvider = createCredentialsAuthProvider({
  parse(context) {
    const formData = context.get(FormData);
    if (!formData) {
      throw new Error("Expected formData() middleware before credential verification.");
    }

    return s.parse(loginSchema, formData);
  },
  verify({ password }, context) {
    const services = context.get(AppServicesKey);
    if (!services) {
      throw new Error("App services middleware is missing.");
    }
    return services.store.verifyAdministratorPassword(password);
  },
});

export default createController(routes.auth.login, {
  middleware: [csrf()],
  actions: {
    async index(context) {
      if (context.auth.ok) {
        return redirect(routes.app.index.href(), 303);
      }

      const { store } = context.services;
      if (!(await store.hasAdministrator())) {
        return redirect(routes.auth.setup.index.href(), 303);
      }

      return context.render(<LoginPage csrfToken={getCsrfToken(context)} />);
    },
    async action(context) {
      const services = context.services;
      if (!(await services.store.hasAdministrator())) {
        return redirect(routes.auth.setup.index.href(), 303);
      }

      const key = requestRateLimitKey(context.request);
      if (!services.loginRateLimiter.allow(key)) {
        return context.render(
          <LoginPage
            csrfToken={getCsrfToken(context)}
            error="Too many login attempts. Try again later."
          />,
          { status: 429 },
        );
      }

      const parsed = s.parseSafe(loginSchema, context.formData);
      if (!parsed.success) {
        return context.render(
          <LoginPage csrfToken={getCsrfToken(context)} error="Enter your password." />,
          { status: 400 },
        );
      }

      const user = await verifyCredentials(passwordProvider, context);
      if (!user) {
        return context.render(
          <LoginPage csrfToken={getCsrfToken(context)} error="Invalid password." />,
          { status: 401 },
        );
      }

      services.loginRateLimiter.reset(key);
      const session = completeAuth(context);
      session.set("auth", { userId: user.id });
      return redirect(routes.app.index.href(), 303);
    },
  },
});

export { loginSchema, passwordProvider };
