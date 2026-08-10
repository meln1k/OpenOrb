import type { Handle } from "remix/ui";

import { routes } from "../../../routes.ts";
import {
  AuthDocument,
  AuthFootnote,
  AuthForm,
  type AuthPageProps,
  AuthPasswordField,
} from "../ui.tsx";

export function LoginPage(handle: Handle<AuthPageProps>) {
  return () => (
    <AuthDocument
      title="Log in to OpenOrb"
      heading="Welcome back"
      description="Enter your password to access your control panel"
      footer={
        <AuthFootnote>
          Use the administrator password configured during first-run setup.
        </AuthFootnote>
      }
    >
      <AuthForm
        action={routes.auth.login.action.href()}
        csrfToken={handle.props.csrfToken}
        error={handle.props.error}
        submitLabel="Log in"
      >
        <AuthPasswordField label="Password" name="password" autoComplete="current-password" />
      </AuthForm>
    </AuthDocument>
  );
}
