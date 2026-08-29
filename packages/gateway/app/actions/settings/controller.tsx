import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { routes } from "@/app/routes.ts";

export default createController(routes.app.settings, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    index() {
      return redirect(routes.app.settings.providers.index.href());
    },
  },
});
