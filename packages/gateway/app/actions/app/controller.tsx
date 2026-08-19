import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";

import { AppPage } from "@/app/actions/app/page.tsx";
import type { Administrator } from "@/app/data/administrator-repository.ts";
import { csrf } from "@/app/middleware/csrf.ts";
import { routes } from "@/app/routes.ts";
import { loadSessionComposerData } from "@/app/session-composer-data.ts";

export default createController(routes.app, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      const userId = context.auth.identity.id;
      const [composer, sidebarSessions] = await Promise.all([
        loadSessionComposerData(userId, context.services),
        context.services.store.listSessionCatalogEntries(userId),
      ]);
      return context.render(
        <AppPage
          composer={composer}
          csrfToken={getCsrfToken(context)}
          sidebarSessions={sidebarSessions}
        />,
      );
    },
  },
});
