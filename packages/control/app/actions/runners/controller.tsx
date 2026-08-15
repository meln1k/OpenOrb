import * as f from "remix/data-schema/form-data";
import * as s from "remix/data-schema";
import { requireAuth } from "remix/middleware/auth";
import { getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { validate as validateUuid } from "@std/uuid";

import type { Administrator } from "../../data/administrator-repository.ts";
import { csrf } from "../../middleware/csrf.ts";
import { routes } from "../../routes.ts";
import { RunnersPage } from "./page.tsx";

const uuidSchema = s.string().refine(
  validateUuid,
  "The enrollment token identifier is invalid.",
);

const createSchema = f.object({
  intent: f.field(s.literal("create-enrollment-token")),
});

const revokeSchema = f.object({
  intent: f.field(s.literal("revoke-enrollment-token")),
  tokenId: f.field(uuidSchema),
});

export default createController(routes.app.runners, {
  middleware: [requireAuth<Administrator>(), csrf()],
  actions: {
    async index(context) {
      const tokens = await context.services.store.listRunnerEnrollmentTokens(
        context.auth.identity.id,
      );
      return context.render(
        <RunnersPage csrfToken={getCsrfToken(context)} enrollmentTokens={tokens} />,
      );
    },

    async action(context) {
      const store = context.services.store;
      const userId = context.auth.identity.id;
      const intent = context.formData.get("intent");
      const renderError = async (error: string, status: number) =>
        context.render(
          <RunnersPage
            csrfToken={getCsrfToken(context)}
            enrollmentTokens={await store.listRunnerEnrollmentTokens(userId)}
            error={error}
          />,
          { status },
        );

      if (intent === "create-enrollment-token") {
        const parsed = s.parseSafe(createSchema, context.formData);
        if (!parsed.success) return renderError("Invalid enrollment token request.", 400);

        const created = await store.createRunnerEnrollmentToken(userId);
        return context.render(
          <RunnersPage
            csrfToken={getCsrfToken(context)}
            enrollmentTokens={await store.listRunnerEnrollmentTokens(userId)}
            newEnrollmentPsk={created.token}
          />,
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      }

      if (intent === "revoke-enrollment-token") {
        const parsed = s.parseSafe(revokeSchema, context.formData);
        if (!parsed.success) {
          return renderError(parsed.issues[0]?.message ?? "Invalid token revocation.", 400);
        }
        const result = await store.revokeRunnerEnrollmentToken(userId, parsed.value.tokenId);
        if (result === "not-found") return renderError("Enrollment token not found.", 404);
        return redirect(routes.app.runners.index.href(), 303);
      }

      return renderError("Invalid runner form submission.", 400);
    },
  },
});
