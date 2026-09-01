import { tryAsync } from "../../../../result/src/index.ts";
import { css, type Dispatched, type Handle, on } from "remix/ui";

import { routes } from "@/app/routes.ts";
import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  actionResponseAccepted,
  actionResponseError,
} from "@/app/ui/session/session-action-response.ts";
import {
  type SessionPageProjection,
  SessionPageScope,
} from "@/app/ui/session/session-page-controller.tsx";
import type { SessionState } from "@/app/ui/session/session-transcript-state.ts";
import {
  initialSessionVmPhase,
  isSessionVmTransitioning,
  type SessionVmPhase,
  sessionVmPhaseForStage,
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
        if (
          pendingAction !== undefined &&
          (actionReachedTarget(pendingAction, page.projection.sessionState) ||
            page.projection.sessionState === "error")
        ) {
          pendingAction = undefined;
        }
        actionError = undefined;
        void handle.update();
      }
    }, { signal: handle.signal });
    page.addEventListener("connection", () => void handle.update(), { signal: handle.signal });
  });

  async function submitVmAction(event: Dispatched<SubmitEvent, HTMLFormElement>) {
    event.preventDefault();
    const sessionState = page.projection.sessionState;
    const action = actionForState(sessionState);
    if (action === undefined || pendingAction !== undefined) return;
    const requestedAction: VmAction = action;
    const form = event.currentTarget;

    function rejectAction(message: string) {
      pendingAction = undefined;
      actionError = actionReachedTarget(requestedAction, page.projection.sessionState)
        ? undefined
        : message;
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
        `The VM ${action} acknowledgement was lost. Check its live state before retrying.`,
      );
      await handle.update();
      return;
    }
    if (handle.signal.aborted) return;
    if (!response.ok) {
      rejectAction(await actionResponseError(response, `VM ${action} was not accepted`));
      if (!handle.signal.aborted) await handle.update();
      return;
    }
    if (!await actionResponseAccepted(response)) {
      rejectAction(`The VM ${action} acknowledgement was invalid. Check its live state.`);
      await handle.update();
      return;
    }

    if (actionReachedTarget(requestedAction, page.projection.sessionState)) {
      pendingAction = undefined;
    }
    actionError = undefined;
    await handle.update();
  }

  const vmActionSubmit = on<HTMLFormElement, "submit">("submit", submitVmAction);

  return () => {
    const sessionState = page.projection.sessionState;
    const vmPhase = phaseForProjection(page.projection);
    const action = pendingAction ?? displayAction(sessionState, vmPhase);
    const canSubmit = !page.projection.connectionInterrupted &&
      pendingAction === undefined && actionForState(sessionState) === action;
    const transitioning = pendingAction !== undefined || isSessionVmTransitioning(vmPhase);
    const phaseLabel = sessionVmPhaseLabel(vmPhase);
    const actionLabel = action === "start" ? "Start Gondolin VM" : "Stop Gondolin VM";
    const actionTitle = canSubmit
      ? actionLabel
      : page.projection.connectionInterrupted
      ? "Gondolin VM controls are unavailable while the connection is interrupted"
      : pendingAction !== undefined
      ? `${pendingAction === "start" ? "Starting" : "Stopping"} Gondolin VM`
      : sessionState === "running"
      ? "Abort the active turn before stopping the Gondolin VM"
      : `${phaseLabel} Gondolin VM`;

    return (
      <div
        id={handle.id}
        aria-label="Gondolin VM controls"
        data-session-vm-control
        mix={vmControlStyle}
      >
        {actionError
          ? <span role="alert" title={actionError} mix={vmActionErrorStyle}>{actionError}</span>
          : null}
        <div
          aria-label={`Gondolin VM: ${phaseLabel}`}
          data-session-vm-status
          data-phase={vmPhase}
          mix={vmStatusStyle}
        >
          <Icon name="server" size={14} />
          <span data-slot="vm-name">VM</span>
          <span
            aria-hidden="true"
            data-slot="vm-state-indicator"
            data-transitioning={transitioning ? "true" : undefined}
            mix={vmStateIndicatorStyle}
          />
          <span role="status">{phaseLabel}</span>
        </div>
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

function phaseForProjection(projection: SessionPageProjection): SessionVmPhase {
  return projection.stage === null
    ? initialSessionVmPhase(projection.sessionState)
    : sessionVmPhaseForStage(projection.stage);
}

function actionForState(state: SessionState): VmAction | undefined {
  return state === "stopped" ? "start" : state === "ready" ? "stop" : undefined;
}

function actionReachedTarget(action: VmAction, state: SessionState): boolean {
  return action === "start" ? state === "ready" : state === "stopped";
}

function displayAction(state: SessionState, phase: SessionVmPhase): VmAction | undefined {
  if (state === "stopped" || phase === "waking" || phase === "starting") return "start";
  if (state === "ready" || state === "running" || phase === "stopping") return "stop";
  return undefined;
}

const vmControlStyle = css({
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  gap: "4px",
  minWidth: 0,
  marginLeft: "auto",
});
const vmStatusStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  height: "32px",
  paddingInline: "10px",
  color: "var(--muted-foreground)",
  background: "color-mix(in oklab, var(--muted) 65%, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  "& [data-slot='vm-name']": { display: "none" },
  "&[data-phase='active']": { color: "var(--primary)" },
  "&[data-phase='failed']": { color: "var(--destructive)" },
  [media.md]: { "& [data-slot='vm-name']": { display: "inline" } },
});
const vmStateIndicatorStyle = css({
  display: "block",
  width: "7px",
  height: "7px",
  background: "currentColor",
  borderRadius: "999px",
  "&[data-transitioning='true']": {
    background: "transparent",
    border: "1.5px solid color-mix(in oklab, currentColor 30%, transparent)",
    borderTopColor: "currentColor",
    animation: "openorb-vm-state-spin 800ms linear infinite",
  },
  "@keyframes openorb-vm-state-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": {
    "&[data-transitioning='true']": { animation: "none" },
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
  maxWidth: "220px",
  overflow: "hidden",
  color: "var(--destructive)",
  fontSize: "12px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
