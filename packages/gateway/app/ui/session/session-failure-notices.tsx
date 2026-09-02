import type { SessionIssue, SessionRecoveryAction } from "@openorb/protocol/browser-session-events";
import { css, type Handle } from "remix/ui";

import { routes } from "@/app/routes.ts";
import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@/app/ui/components/marker.tsx";

interface SessionFailureNoticesProps {
  readonly connectionInterrupted: boolean;
  readonly csrfToken: string;
  readonly issues: readonly SessionIssue[];
  readonly recoveryAllowed: boolean;
  readonly sessionId: string;
}

export function SessionFailureNotices(handle: Handle<SessionFailureNoticesProps>) {
  return () => (
    <>
      {handle.props.connectionInterrupted
        ? (
          <Marker
            role="alert"
            data-runner-disconnected
            mix={[noticeMarkerStyle, failureStyle]}
          >
            <MarkerIcon>
              <Icon name="activity" />
            </MarkerIcon>
            <MarkerContent>
              The pinned runner is disconnected. Conversation history and session actions are
              unavailable until it reconnects.
            </MarkerContent>
          </Marker>
        )
        : null}
      {handle.props.issues.map((issue) => (
        <Marker
          key={`issue:${issue.category}:${issue.severity}`}
          role={issue.severity === "failure" ? "alert" : "status"}
          data-session-issue={issue.category}
          data-severity={issue.severity}
          mix={[
            noticeMarkerStyle,
            issue.severity === "failure" ? failureStyle : warningStyle,
          ]}
        >
          <MarkerIcon>
            <Icon name="activity" />
          </MarkerIcon>
          <MarkerContent mix={issueDetailStyle}>
            <strong>{issueLabel(issue.category)}</strong>
            <p>{issue.message}</p>
            {issue.diagnostics
              ? (
                <details>
                  <summary>Safe diagnostics</summary>
                  <pre data-session-issue-diagnostics>{issue.diagnostics}</pre>
                </details>
              )
              : null}
            {issue.recovery === "none" || !handle.props.recoveryAllowed ? null : (
              <form
                method="post"
                action={routes.app.sessions.retry.href({ sessionId: handle.props.sessionId })}
                mix={retryStyle}
              >
                <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
                <input type="hidden" name="recovery" value={issue.recovery} />
                <Button type="submit" size="sm" disabled={handle.props.connectionInterrupted}>
                  {recoveryLabel(issue.recovery)}
                </Button>
              </form>
            )}
          </MarkerContent>
        </Marker>
      ))}
    </>
  );
}

function issueLabel(category: SessionIssue["category"]): string {
  return category.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function recoveryLabel(recovery: Exclude<SessionRecoveryAction, "none">): string {
  switch (recovery) {
    case "retry-provisioning":
      return "Retry provisioning";
    case "resume-prior-checkpoint":
      return "Resume prior checkpoint";
    case "start-clean-vm":
      return "Start clean VM";
  }
}

const noticeMarkerStyle = css({ alignItems: "flex-start", flexShrink: 0 });
const warningStyle = css({ color: "var(--muted-foreground)", padding: "8px 16px" });
const failureStyle = css({
  color: "var(--destructive)",
  padding: "8px 16px",
  background: "color-mix(in oklab, var(--destructive) 8%, transparent)",
});
const issueDetailStyle = css({
  display: "grid",
  flex: 1,
  gap: "6px",
  "& strong, & summary": {
    color: "var(--muted-foreground)",
    fontSize: "13px",
    fontWeight: 500,
  },
  "& p": { margin: 0 },
  "& summary": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
    paddingLeft: "24px",
    overflow: "hidden",
    cursor: "pointer",
    listStyle: "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  "& summary::marker": { content: "''" },
  "& summary::-webkit-details-marker": { display: "none" },
  "& details": {
    width: "calc(100% + 24px)",
    minWidth: 0,
    marginLeft: "-24px",
  },
  "& pre": {
    boxSizing: "border-box",
    width: "100%",
    maxHeight: "280px",
    margin: "8px 0 0",
    padding: "12px",
    overflow: "auto",
    color: "var(--foreground)",
    background: "var(--muted)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});
const retryStyle = css({ flexShrink: 0, margin: 0 });
