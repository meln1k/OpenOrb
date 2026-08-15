import type { Handle } from "remix/ui";

import { routes } from "@/app/routes.ts";
import {
  AuthDocument,
  AuthForm,
  type AuthPageProps,
  AuthPasswordField,
} from "@/app/actions/auth/ui.tsx";

export function SetupPage(handle: Handle<AuthPageProps>) {
  return () => (
    <AuthDocument
      title="Set up OpenOrb"
      heading="Create your administrator"
      description="Choose the password that protects this single-user control panel"
    >
      <AuthForm
        action={routes.auth.setup.action.href()}
        csrfToken={handle.props.csrfToken}
        error={handle.props.error}
        submitLabel="Create administrator"
      >
        <AuthPasswordField label="Password" name="password" autoComplete="new-password" />
        <AuthPasswordField
          label="Confirm password"
          name="confirmPassword"
          autoComplete="new-password"
        />
      </AuthForm>
    </AuthDocument>
  );
}
