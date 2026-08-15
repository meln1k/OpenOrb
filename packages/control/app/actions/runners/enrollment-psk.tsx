import { clientEntry, css, type Handle, on } from "remix/ui";

import { Button } from "@/app/ui/components/button.tsx";

export type EnrollmentPskProps = {
  enrollmentPsk: string;
};

export const EnrollmentPsk = clientEntry<EnrollmentPskProps>(
  import.meta.url,
  function EnrollmentPsk(handle: Handle<EnrollmentPskProps>) {
    let copyStatus: "copied" | "failed" | undefined;

    return () => {
      return (
        <div mix={pskStyle}>
          <code mix={pskValueStyle}>{handle.props.enrollmentPsk}</code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            mix={on("click", async (_event, signal) => {
              try {
                await globalThis.navigator.clipboard.writeText(handle.props.enrollmentPsk);
                copyStatus = "copied";
              } catch {
                copyStatus = "failed";
              }
              if (!signal.aborted) await handle.update();
            })}
          >
            Copy PSK
          </Button>
          {copyStatus
            ? (
              <p role="status" aria-live="polite" mix={copyStatusStyle}>
                {copyStatus === "copied"
                  ? "Enrollment PSK copied."
                  : "Could not copy automatically. Select and copy the PSK manually."}
              </p>
            )
            : null}
        </div>
      );
    };
  },
);

const pskStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
});
const pskValueStyle = css({
  display: "block",
  flex: "1 1 360px",
  minWidth: 0,
  padding: "8px",
  overflowWrap: "anywhere",
  background: "var(--muted)",
  borderRadius: "var(--radius-md)",
  userSelect: "all",
});
const copyStatusStyle = css({
  flexBasis: "100%",
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "12px",
});
