import { tryAsync } from "../../../../result/src/index.ts";
import { css, type Dispatched, type Handle, on } from "remix/component";

import { routes } from "@/app/routes.ts";
import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/app/ui/components/tooltip.tsx";
import {
  actionResponseAccepted,
  actionResponseError,
} from "@/app/ui/session/session-action-response.ts";
import {
  type SessionPageProjection,
  SessionPageScope,
} from "@/app/ui/session/session-page-controller.tsx";
import {
  isSessionVmTransitioning,
  sessionVmPhase,
  sessionVmPhaseLabel,
} from "@/app/ui/session/session-vm-state.ts";

export type SessionVmControlProps = {
  csrfToken: string;
  sessionId: string;
};

type VmAction = "start" | "stop";

export function SessionVmControl(handle: Handle<SessionVmControlProps>) {
  const page = handle.context.get(SessionPageScope);
  let pendingAction: VmAction | undefined;
  let actionError: string | undefined;

  handle.queueTask(() => {
    page.addEventListener("session", (message) => {
      if (message.detail.type === "session.state") {
        void handle.update();
      }
    }, { signal: handle.signal });
    page.addEventListener("connection", () => void handle.update(), { signal: handle.signal });
  });

  async function submitVmAction(event: Dispatched<SubmitEvent, HTMLFormElement>) {
    event.preventDefault();
    const action = actionForState(page.projection);
    if (action === undefined || pendingAction !== undefined) return;
    const form = event.currentTarget;

    function rejectAction(message: string) {
      pendingAction = undefined;
      actionError = message;
    }

    pendingAction = action;
    actionError = undefined;
    await handle.update();
    if (handle.signal.aborted) return;

    const [response, requestError] = await tryAsync(
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: handle.signal,
      }),
      () => true,
    );
    if (requestError !== undefined) {
      if (handle.signal.aborted) return;
      rejectAction(
        `The session ${action} acknowledgement was lost. Check its live state before retrying.`,
      );
      await handle.update();
      return;
    }
    if (handle.signal.aborted) return;
    if (!response.ok) {
      rejectAction(await actionResponseError(response, `Session ${action} was not accepted`));
      if (!handle.signal.aborted) await handle.update();
      return;
    }
    if (!await actionResponseAccepted(response)) {
      rejectAction(`The session ${action} acknowledgement was invalid. Check its live state.`);
      await handle.update();
      return;
    }

    pendingAction = undefined;
    actionError = undefined;
    await handle.update();
  }

  const vmActionSubmit = on<HTMLFormElement, "submit">("submit", submitVmAction);

  return () => {
    const vmPhase = sessionVmPhase(page.projection.environmentState);
    const action = pendingAction ?? actionForState(page.projection);
    const canSubmit = !page.projection.connectionInterrupted &&
      pendingAction === undefined && action !== undefined;
    const transitioning = pendingAction !== undefined || isSessionVmTransitioning(vmPhase);
    const phaseLabel = sessionVmPhaseLabel(vmPhase);
    const actionLabel = action === "start" ? "Wake" : "Stop Session";
    const lifecycleLabel = `Agent: ${page.projection.agentState ?? "unknown"} · Environment: ${
      page.projection.environmentState ?? "unknown"
    }`;
    const actionTitle = canSubmit
      ? actionLabel
      : page.projection.connectionInterrupted
      ? "Session controls are unavailable while the connection is interrupted"
      : pendingAction !== undefined
      ? `${pendingAction === "start" ? "Waking" : "Stopping"} session`
      : `${phaseLabel} Gondolin VM`;

    return (
      <div
        id={handle.id}
        aria-label="Session controls"
        data-session-vm-control
        mix={vmControlStyle}
      >
        {actionError
          ? <span role="alert" title={actionError} mix={vmActionErrorStyle}>{actionError}</span>
          : null}
        <span role="status" data-agent-environment-status>{lifecycleLabel}</span>
        <Tooltip>
          <TooltipTrigger
            role="status"
            tabIndex={0}
            aria-label={lifecycleLabel}
            data-session-vm-status
            data-phase={vmPhase}
            mix={vmStatusStyle}
          >
            <span aria-hidden="true" data-slot="vm-state-indicator" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Stop Session pauses the agent and stops its environment. Environment tools do not pause
            the agent.
          </TooltipContent>
        </Tooltip>
        {action === undefined ? null : (
          <form
            method="post"
            action={action === "start"
              ? routes.api.sessions.wake.href({ sessionId: handle.props.sessionId })
              : routes.app.sessions.stop.href({ sessionId: handle.props.sessionId })}
            mix={vmActionSubmit}
          >
            <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label={actionLabel}
              title={actionTitle}
              disabled={!canSubmit}
              mix={vmActionStyle}
            >
              {transitioning
                ? <span aria-hidden="true" data-slot="vm-action-spinner" mix={vmSpinnerStyle} />
                : <Icon name={action === "start" ? "play" : "square"} size={14} />}
            </Button>
          </form>
        )}
      </div>
    );
  };
}

export function actionForState(
  state: Pick<SessionPageProjection, "agentState" | "environmentState">,
): VmAction | undefined {
  if (
    state.agentState === null || state.environmentState === null ||
    state.environmentState === "stopping"
  ) return undefined;
  return state.agentState === "paused" ? "start" : "stop";
}

const vmControlStyle = css({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  flexShrink: 1,
  gap: "4px",
  fontSize: "12px",
  color: "var(--muted-foreground)",
  minWidth: 0,
  maxWidth: "100%",
  marginLeft: "auto",
});
const vmStatusStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "24px",
  height: "32px",
  color: "var(--muted-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  "&:focus-visible": { outline: "1px solid var(--ring)", outlineOffset: "1px" },
  "&[data-phase='starting'], &[data-phase='waking']": { color: "#ca8a04" },
  "&[data-phase='active']": { color: "#16834b" },
  "&[data-phase='failed']": { color: "var(--destructive)" },
  "& [data-slot='vm-state-indicator']": {
    display: "block",
    width: "8px",
    height: "8px",
    background: "currentColor",
    borderRadius: "999px",
  },
});
const vmActionStyle = css({ borderRadius: "999px" });
const vmSpinnerStyle = css({
  display: "block",
  width: "14px",
  height: "14px",
  border: "2px solid color-mix(in oklab, currentColor 30%, transparent)",
  borderTopColor: "currentColor",
  borderRadius: "999px",
  animation: "openorb-vm-action-spin 800ms linear infinite",
  "@keyframes openorb-vm-action-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});
const vmActionErrorStyle = css({
  order: 1,
  flexBasis: "100%",
  color: "var(--destructive)",
  fontSize: "12px",
  textAlign: "right",
  overflowWrap: "anywhere",
});
