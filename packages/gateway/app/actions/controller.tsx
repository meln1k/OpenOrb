import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import { routes } from "@/app/routes.ts";

export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await context.services.assets.fetch(context.request)) ??
          new Response("Not Found", { status: 404 })
      );
    },
    health() {
      return Response.json({ service: "openorb-gateway", status: "ok" });
    },
    async home(context) {
      const { workspace } = context.services;
      if (context.auth.ok) {
        return redirect(routes.app.index.href(), 303);
      }
      if (!(await workspace.hasAdministrator())) {
        return redirect(routes.auth.setup.index.href(), 303);
      }
      return redirect(routes.auth.login.index.href(), 303);
    },
  },
});
