import { css, type Handle } from "remix/ui";

import type { RunnerEnrollmentToken } from "../../data/runner-repository.ts";
import { routes } from "../../routes.ts";
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icon,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/components/index.ts";
import { AppShell } from "../../ui/shell.tsx";

export interface RunnersPageProps {
  csrfToken: string;
  enrollmentTokens: RunnerEnrollmentToken[];
  error?: string;
  newEnrollmentPsk?: string;
}

export function RunnersPage(handle: Handle<RunnersPageProps>) {
  const { csrfToken, enrollmentTokens, error, newEnrollmentPsk } = handle.props;

  return () => (
    <AppShell
      activeSection="runners"
      csrfToken={csrfToken}
      title="Runners · OpenOrb"
      eyebrow="Runners"
      heading="Runners"
      copy="Create a reusable PSK to enroll outbound-only OpenOrb runners."
    >
      {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
      {newEnrollmentPsk
        ? (
          <section aria-labelledby="new-enrollment-psk" mix={tokenRevealStyle}>
            <h2 id="new-enrollment-psk" mix={tokenHeadingStyle}>Copy this enrollment PSK now</h2>
            <p mix={tokenCopyStyle}>
              OpenOrb stores only its hash. This clear value will not be shown again.
            </p>
            <code mix={tokenValueStyle}>{newEnrollmentPsk}</code>
          </section>
        )
        : null}
      <Card>
        <CardHeader>
          <CardTitle>Enrollment PSKs</CardTitle>
          <CardDescription>
            A PSK can enroll multiple runners until you revoke it. Enrolled runners use a separate
            bearer token afterward.
          </CardDescription>
          <CardAction>
            <form method="post" action={routes.app.runners.action.href()}>
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="create-enrollment-token" />
              <Button type="submit">
                <Icon name="plus" />
                Create PSK
              </Button>
            </form>
          </CardAction>
        </CardHeader>
        <CardContent mix={cardContentStyle}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead mix={actionsHeadStyle}>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enrollmentTokens.length === 0
                ? (
                  <TableRow>
                    <TableCell colSpan={3} mix={emptyCellStyle}>
                      No enrollment PSKs created.
                    </TableCell>
                  </TableRow>
                )
                : enrollmentTokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      <time dateTime={token.createdAt.toString()}>
                        {token.createdAt.toString()}
                      </time>
                    </TableCell>
                    <TableCell>{token.revokedAt ? "Revoked" : "Active"}</TableCell>
                    <TableCell mix={actionsCellStyle}>
                      {token.revokedAt
                        ? "—"
                        : (
                          <form method="post" action={routes.app.runners.action.href()}>
                            <input type="hidden" name="_csrf" value={csrfToken} />
                            <input
                              type="hidden"
                              name="intent"
                              value="revoke-enrollment-token"
                            />
                            <input type="hidden" name="tokenId" value={token.id} />
                            <Button type="submit" size="sm" variant="destructive">Revoke</Button>
                          </form>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </AppShell>
  );
}

const cardContentStyle = css({ overflowX: "auto" });
const emptyCellStyle = css({
  height: "96px",
  color: "var(--muted-foreground)",
  textAlign: "center",
});
const actionsHeadStyle = css({ width: "110px", textAlign: "right" });
const actionsCellStyle = css({ textAlign: "right" });
const tokenRevealStyle = css({
  display: "grid",
  gap: "8px",
  padding: "16px",
  background: "color-mix(in oklab, var(--primary) 8%, var(--background))",
  border: "1px solid color-mix(in oklab, var(--primary) 30%, var(--border))",
  borderRadius: "var(--radius-lg)",
});
const tokenHeadingStyle = css({ margin: 0, fontSize: "16px", fontWeight: 600 });
const tokenCopyStyle = css({ margin: 0, color: "var(--muted-foreground)", fontSize: "14px" });
const tokenValueStyle = css({
  display: "block",
  padding: "12px",
  overflowWrap: "anywhere",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  userSelect: "all",
});
const errorStyle = css({
  margin: 0,
  padding: "12px 14px",
  color: "var(--destructive)",
  border: "1px solid color-mix(in oklab, var(--destructive) 30%, var(--border))",
  borderRadius: "var(--radius-md)",
});
