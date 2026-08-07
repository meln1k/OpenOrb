import { createController } from "remix/router";

import { assetServer } from "../assets.ts";
import { routes } from "../routes.ts";
import { HomePage } from "../ui/home-page.tsx";

export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await assetServer.fetch(context.request)) ?? new Response("Not Found", { status: 404 })
      );
    },
    health() {
      return Response.json({ service: "openorb-control", status: "ok" });
    },
    home(context) {
      return context.render(<HomePage />);
    },
  },
});
