import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { createController } from "remix/router";
import { getCsrfToken } from "remix/middleware/csrf";
import { redirect } from "remix/response/redirect";

import { routes } from "../../../routes.ts";
import { csrf } from "../../../middleware/csrf.ts";
import { SetupPage } from "./page.tsx";

const setupSchema = f.object({
  password: f.field(s.string().refine((value) => value.length > 0, "Password is required.")),
  confirmPassword: f.field(s.string().refine((value) => value.length > 0, "Password is required.")),
});

export default createController(routes.auth.setup, {
  middleware: [csrf()],
  actions: {
    async index(context) {
      const { store } = context.services;
      if (await store.hasAdministrator()) {
        return redirect(routes.auth.login.index.href(), 303);
      }

      return context.render(<SetupPage csrfToken={getCsrfToken(context)} />);
    },
    async action(context) {
      const { store } = context.services;
      if (await store.hasAdministrator()) {
        return new Response("Administrator setup is already complete.", { status: 409 });
      }

      const parsed = s.parseSafe(setupSchema, context.formData);
      if (!parsed.success) {
        return context.render(
          <SetupPage
            csrfToken={getCsrfToken(context)}
            error="Enter a password and confirmation."
          />,
          { status: 400 },
        );
      }

      if (parsed.value.password !== parsed.value.confirmPassword) {
        return context.render(
          <SetupPage csrfToken={getCsrfToken(context)} error="The passwords do not match." />,
          { status: 400 },
        );
      }

      const created = await store.createAdministrator(parsed.value.password);
      if (!created) {
        return new Response("Administrator setup is already complete.", { status: 409 });
      }

      return redirect(routes.auth.login.index.href(), 303);
    },
  },
});
