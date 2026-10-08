import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import { assetServer } from "@/app/assets.ts";
import { routes } from "@/app/routes.ts";

export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await assetServer.fetch(context.request)) ?? new Response("Not Found", { status: 404 })
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
      if (!(await workspace.call("hasAdministrator"))) {
        return redirect(routes.auth.setup.index.href(), 303);
      }
      return redirect(routes.auth.login.index.href(), 303);
    },
  },
});
