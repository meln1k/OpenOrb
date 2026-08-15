import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";

import { routes } from "@/app/routes.ts";
import { DashboardPage } from "@/app/actions/app/page.tsx";

export default createController(routes.app, {
  middleware: [requireAuth()],
  actions: {
    index(context) {
      return context.render(
        <DashboardPage csrfToken={getCsrfToken(context)} />,
      );
    },
  },
});
