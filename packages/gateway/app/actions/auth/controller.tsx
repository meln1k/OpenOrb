import { createController } from "remix/router";
import { requireAuth } from "remix/middleware/auth";
import { redirect } from "remix/response/redirect";
import { routes } from "@/app/routes.ts";
import { csrf } from "@/app/middleware/csrf.ts";

export default createController(routes.auth, {
  middleware: [requireAuth(), csrf()],
  actions: {
    logout(context) {
      context.session.destroy();
      return redirect(routes.auth.login.index.href(), 303);
    },
  },
});
