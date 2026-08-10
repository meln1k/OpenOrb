import type { Handle } from "remix/ui";

import { routes } from "../../../routes.ts";
import {
  AuthCopy,
  AuthDocument,
  AuthFootnote,
  AuthForm,
  type AuthPageProps,
  AuthPasswordField,
} from "../ui.tsx";

export function LoginPage(handle: Handle<AuthPageProps>) {
  return () => (
    <AuthDocument title="Log in to OpenOrb" eyebrow="Administrator access" heading="Welcome back">
      <AuthCopy>Log in to manage projects, runners, and coding-agent sessions.</AuthCopy>
      <AuthForm
        action={routes.auth.login.action.href()}
        csrfToken={handle.props.csrfToken}
        error={handle.props.error}
        submitLabel="Log in"
      >
        <AuthPasswordField label="Password" name="password" autoComplete="current-password" />
      </AuthForm>
      <AuthFootnote>Use the administrator password configured during first-run setup.</AuthFootnote>
    </AuthDocument>
  );
}
