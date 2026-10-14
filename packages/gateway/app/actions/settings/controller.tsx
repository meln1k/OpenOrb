import { requireAuth } from "remix/middleware/auth";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import type { Administrator } from "../../cells/workspace/api.ts";
import { csrf } from "../../middleware/csrf.ts";
import { routes } from "../../routes.ts";

export default createController(routes.app.settings, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    index() {
      return redirect(routes.app.settings.providers.index.href());
    },
  },
});
