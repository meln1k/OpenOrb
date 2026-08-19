import { css, type Handle, type RemixNode } from "remix/ui";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  cardTitleStyle,
  designSystemStyle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
} from "@/app/ui/components/index.ts";
import { Document } from "@/app/ui/document.tsx";

export interface AuthPageProps {
  csrfToken: string;
  error?: string;
}

interface AuthDocumentProps {
  title: string;
  heading: string;
  description: string;
  children?: RemixNode;
  footer?: RemixNode;
}

export function AuthDocument(handle: Handle<AuthDocumentProps>) {
  return () => (
    <Document title={handle.props.title}>
      <main mix={[designSystemStyle, pageStyle]}>
        <div mix={pageContentStyle}>
          <AuthBrand />
          <Card role="region" aria-labelledby="auth-heading">
            <CardHeader mix={centeredCardHeaderStyle}>
              <h1 id="auth-heading" mix={[cardTitleStyle, authCardTitleStyle]}>
                {handle.props.heading}
              </h1>
              <CardDescription>{handle.props.description}</CardDescription>
            </CardHeader>
            <CardContent>{handle.props.children}</CardContent>
          </Card>
          {handle.props.footer}
        </div>
      </main>
    </Document>
  );
}

export function AuthForm(
  handle: Handle<{
    action: string;
    csrfToken: string;
    error?: string;
    submitLabel: string;
    children?: RemixNode;
  }>,
) {
  return () => (
    <form method="post" action={handle.props.action}>
      <FieldGroup>
        <AuthError message={handle.props.error} />
        {handle.props.children}
        <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
        <Button type="submit" mix={fullWidthStyle}>
          {handle.props.submitLabel}
        </Button>
      </FieldGroup>
    </form>
  );
}

export function AuthPasswordField(
  handle: Handle<{ label: string; name: string; autoComplete: string }>,
) {
  return () => (
    <Field>
      <FieldLabel htmlFor={handle.props.name}>{handle.props.label}</FieldLabel>
      <Input
        id={handle.props.name}
        type="password"
        name={handle.props.name}
        autoComplete={handle.props.autoComplete}
        required
      />
    </Field>
  );
}

export function AuthFootnote(handle: Handle<{ children?: RemixNode }>) {
  return () => <FieldDescription mix={footnoteStyle}>{handle.props.children}</FieldDescription>;
}

function AuthBrand() {
  return () => (
    <a href="/" aria-label="OpenOrb home" mix={brandStyle}>
      <img src="/favicon.svg" alt="" width="24" height="24" mix={brandMarkStyle} />
      <span>OpenOrb</span>
    </a>
  );
}

function AuthError(handle: Handle<{ message?: string }>) {
  return () =>
    handle.props.message
      ? (
        <Alert variant="destructive">
          <AlertDescription>{handle.props.message}</AlertDescription>
        </Alert>
      )
      : null;
}

const pageStyle = css({
  minHeight: "100svh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "clamp(24px, 5vw, 40px)",
  background: "var(--muted)",
});

const pageContentStyle = css({
  width: "100%",
  maxWidth: "384px",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
});

const centeredCardHeaderStyle = css({ textAlign: "center" });
const authCardTitleStyle = css({ fontSize: "20px" });
const fullWidthStyle = css({ width: "100%" });

const brandStyle = css({
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "center",
  gap: "8px",
  color: "var(--foreground)",
  fontSize: "14px",
  fontWeight: 600,
  textDecoration: "none",
  borderRadius: "var(--radius-md)",
  outline: "none",
  "&:focus-visible": {
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--ring) 45%, transparent)",
  },
});

const brandMarkStyle = css({
  display: "block",
  width: "24px",
  height: "24px",
  borderRadius: "var(--radius-md)",
});

const footnoteStyle = css({
  padding: "0 24px",
  textAlign: "center",
});
