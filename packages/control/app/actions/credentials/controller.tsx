import * as s from "remix/data-schema";
import * as f from "remix/data-schema/form-data";
import { requireAuth } from "remix/middleware/auth";
import { csrf, getCsrfToken } from "remix/middleware/csrf";
import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";

import { routes } from "../../routes.ts";
import { CredentialsPage } from "./page.tsx";

const secretKeySchema = s.string().refine(
  (value) => {
    const key = value.trim();
    return key.length > 0 && key.length <= 64 && /^[A-Za-z0-9_]+$/.test(key);
  },
  'Use a name of letters, digits, and underscores, such as "OPENCODE_API_KEY".',
);

const saveSchema = f.object({
  intent: f.field(s.literal("save")),
  key: f.field(secretKeySchema),
  value: f.field(
    s
      .string()
      .refine((value) => value.trim().length > 0, "The API key is required.")
      .refine((value) => value.trim().length <= 4096, "The API key is too long."),
  ),
});

const deleteSchema = f.object({
  intent: f.field(s.literal("delete")),
  key: f.field(secretKeySchema),
});

export default createController(routes.app.credentials, {
  middleware: [requireAuth(), csrf()],
  actions: {
    async index(context) {
      const secrets = await context.services.store.listSecrets();
      return context.render(
        <CredentialsPage csrfToken={getCsrfToken(context)} secrets={secrets} />,
      );
    },

    async action(context) {
      const { store } = context.services;

      const save = s.parseSafe(saveSchema, context.formData);
      if (save.success) {
        await store.saveSecret(save.value.key.trim(), save.value.value.trim());
        return redirect(routes.app.credentials.index.href(), 303);
      }

      const deletion = s.parseSafe(deleteSchema, context.formData);
      if (deletion.success) {
        await store.deleteSecret(deletion.value.key.trim());
        return redirect(routes.app.credentials.index.href(), 303);
      }

      const error = save.issues[0]?.message ?? deletion.issues[0]?.message ??
        "Invalid credential form submission.";
      return context.render(
        <CredentialsPage
          csrfToken={getCsrfToken(context)}
          secrets={await store.listSecrets()}
          error={error}
        />,
        { status: 400 },
      );
    },
  },
});
