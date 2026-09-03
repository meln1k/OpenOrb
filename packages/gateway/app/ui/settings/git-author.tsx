import { css, type Handle } from "remix/ui";
import { Button, SubmitProgressBehavior } from "@/app/ui/components/button.tsx";
import { Field, FieldLabel } from "@/app/ui/components/field.tsx";
import { Input } from "@/app/ui/components/input.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  configurationStatusStyle,
  formatSettingsDate,
  sectionCopyStyle,
  sectionHeaderStyle,
  sectionHeadingStyle,
  settingsSectionStyle,
} from "@/app/ui/settings/settings-shared.ts";
import type { SettingsGitAuthor } from "@/app/ui/settings/settings-navigation.tsx";
export function GitAuthorSection(
  handle: Handle<
    {
      actionHref: string;
      authorEmail: string;
      authorName: string;
      csrfToken: string;
      formId: string;
      gitAuthor: SettingsGitAuthor | null;
    }
  >,
) {
  const { actionHref, authorEmail, authorName, csrfToken, formId, gitAuthor } = handle.props;
  return () => (
    <section aria-labelledby="git-author-heading" mix={settingsSectionStyle}>
      <header mix={sectionHeaderStyle}>
        <h2 id="git-author-heading" mix={sectionHeadingStyle}>Git author</h2>
        <p mix={sectionCopyStyle}>
          This global identity is required before a session can be provisioned and is used for
          OpenOrb session commits.
        </p>
      </header>
      <form id={formId} method="post" action={actionHref} mix={authorFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-git-author" />
        <div mix={authorFieldsStyle}>
          <Field>
            <FieldLabel for="git-author-name">Name</FieldLabel>
            <Input
              id="git-author-name"
              name="authorName"
              defaultValue={authorName}
              maxLength={200}
              autoComplete="name"
              required
            />
          </Field>
          <Field>
            <FieldLabel for="git-author-email">Email</FieldLabel>
            <Input
              id="git-author-email"
              type="email"
              name="authorEmail"
              defaultValue={authorEmail}
              maxLength={254}
              autoComplete="email"
              required
            />
          </Field>
        </div>
        <div mix={authorFooterStyle}>
          <span mix={configurationStatusStyle}>
            {gitAuthor
              ? `Configured · updated ${formatSettingsDate(gitAuthor.updatedAt)}`
              : "Not configured"}
          </span>
          <Button type="submit">
            <span data-slot="submit-idle" mix={submitLabelStyle}>Save Git author</span>
            <span data-slot="submit-progress" hidden mix={submitLabelStyle}>
              <span aria-hidden="true" mix={submitSpinnerStyle} />
              Saving Git author
            </span>
          </Button>
        </div>
        <SubmitProgressBehavior
          formId={formId}
          idleLabel="Save Git author"
          pendingLabel="Saving Git author"
        />
      </form>
    </section>
  );
}

const authorFormStyle = css({
  display: "grid",
  gap: "20px",
  padding: "20px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
});
const authorFieldsStyle = css({
  display: "grid",
  gap: "18px",
});
const authorFooterStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
  [media.sm]: { flexDirection: "row", alignItems: "center" },
});
const submitLabelStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  "&[hidden]": { display: "none" },
});
const submitSpinnerStyle = css({
  width: "14px",
  height: "14px",
  border: "2px solid color-mix(in oklab, currentColor 35%, transparent)",
  borderTopColor: "currentColor",
  borderRadius: "999px",
  animation: "openorb-git-author-submit-spin 800ms linear infinite",
  "@keyframes openorb-git-author-submit-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});
