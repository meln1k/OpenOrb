import {
  DEFAULT_ORB_SIZE,
  DEFAULT_SESSION_MODEL,
  ORB_SIZE_RESOURCES,
  ORB_SIZES,
  type OrbSize,
} from "@openorb/protocol";
import { css, type Handle } from "remix/ui";

import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { routes } from "@/app/routes.ts";
import { DialogBehavior } from "@/app/ui/components/alert-dialog.tsx";
import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { media } from "@/app/ui/responsive.ts";

export interface SessionComposerValues {
  projectId: string;
  model: string;
  ref: string;
  orbSize: string;
  branchName: string;
  initialPrompt: string;
}

export interface SessionComposerProps extends SessionComposerData {
  autoOpen?: boolean;
  csrfToken: string;
  dialogId: string;
  error?: string;
  values?: SessionComposerValues;
}

export function SessionComposer(handle: Handle<SessionComposerProps>) {
  const {
    autoOpen,
    csrfToken,
    dialogId,
    error,
    hasConnectedRunner,
    models,
    projects,
    values,
  } = handle.props;
  const titleId = `${dialogId}-title`;
  const firstProject = projects[0];
  const selectedProjectId = values?.projectId ?? firstProject?.id ?? "";
  const selectedModel = values?.model ??
    models.find((model) => model.id === DEFAULT_SESSION_MODEL)?.id ??
    models[0]?.id ??
    "";
  const selectedOrbSize = values?.orbSize || DEFAULT_ORB_SIZE;
  const ref = values?.ref ?? firstProject?.defaultRef ?? "main";
  const branchName = values?.branchName ?? "openorb/session";
  const canSubmit = projects.length > 0 && models.length > 0 && hasConnectedRunner;

  return () => (
    <dialog
      id={dialogId}
      role="dialog"
      aria-labelledby={titleId}
      open={autoOpen || undefined}
      data-slot="session-composer"
      mix={dialogStyle}
    >
      <form method="post" action={routes.app.sessions.create.href()} mix={formStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="runnerId" value="" />
        <input type="hidden" name="ref" value={ref} />
        <input type="hidden" name="branchName" value={branchName} />
        <header mix={headerStyle}>
          <Button
            type="button"
            variant="ghost"
            commandFor={dialogId}
            command="close"
            aria-label="Close new session"
            mix={closeButtonStyle}
          >
            <Icon name="x" size={20} />
            Close
          </Button>
          <h2 id={titleId} mix={screenReaderOnlyStyle}>New session</h2>
        </header>
        <div mix={promptAreaStyle}>
          {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
          <textarea
            name="initialPrompt"
            aria-label="Initial prompt"
            placeholder="Write prompt…"
            value={values?.initialPrompt ?? ""}
            required
            autoFocus
            mix={promptStyle}
          />
          {projects.length === 0
            ? (
              <p mix={noticeStyle}>
                Add a <a href={routes.app.projects.index.href()}>project</a>{" "}
                before starting a session.
              </p>
            )
            : !hasConnectedRunner
            ? <p mix={noticeStyle}>Connect an available runner before starting a session.</p>
            : models.length === 0
            ? <p mix={noticeStyle}>Configure a model provider before starting a session.</p>
            : null}
        </div>
        <footer mix={footerStyle}>
          <div mix={controlsStyle}>
            <label aria-label="Project" mix={selectControlStyle}>
              <Icon name="folder" />
              <select
                name="projectId"
                value={selectedProjectId}
                required
                disabled={projects.length === 0}
                mix={selectStyle}
              >
                {projects.length === 0
                  ? <option value="">No projects</option>
                  : projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
              </select>
              <Icon name="chevron-down" />
            </label>
            <label aria-label="Orb size" mix={selectControlStyle}>
              <Icon name="server" />
              <select name="orbSize" value={selectedOrbSize} required mix={selectStyle}>
                {ORB_SIZES.map((orbSize) => (
                  <option
                    key={orbSize}
                    value={orbSize}
                    selected={orbSize === selectedOrbSize || undefined}
                  >
                    {formatOrbSize(orbSize)}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </label>
            <label aria-label="Model" mix={selectControlStyle}>
              <Icon name="sparkles" />
              <select
                name="model"
                value={selectedModel}
                required
                disabled={models.length === 0}
                mix={selectStyle}
              >
                {models.length === 0
                  ? <option value="">No model</option>
                  : models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.providerName} · {model.name}
                    </option>
                  ))}
              </select>
              <Icon name="chevron-down" />
            </label>
          </div>
          <Button
            type="submit"
            size="icon-lg"
            aria-label="Start session"
            title={canSubmit ? "Start session" : "Project, model, and runner required"}
            data-submit-enabled={canSubmit ? "true" : "false"}
            data-submit-label="Start session"
            data-submit-pending-label="Starting session"
            disabled={!canSubmit}
          >
            <span aria-hidden="true" data-slot="submit-idle" mix={submitIdleStyle}>
              <Icon name="arrow-right" size={20} />
            </span>
            <span aria-hidden="true" data-slot="spinner" hidden mix={submitSpinnerStyle} />
          </Button>
        </footer>
      </form>
      <DialogBehavior
        dialogId={dialogId}
        keepOpenWhileSubmitting
        open={Boolean(autoOpen)}
      />
    </dialog>
  );
}

function formatOrbSize(orbSize: OrbSize): string {
  const resources = ORB_SIZE_RESOURCES[orbSize];
  return `${orbSize} · ${resources.cpuCount} CPU${resources.cpuCount === 1 ? "" : "s"} · ${
    resources.memoryMiB / 1024
  } GB memory`;
}

const dialogStyle = css({
  position: "fixed",
  inset: "var(--openorb-visual-viewport-center, 50%) auto auto 50%",
  zIndex: 60,
  display: "none",
  width: "min(calc(100% - 24px), 1040px)",
  height: "min(620px, calc(var(--openorb-visual-viewport-height, 100dvh) - 24px))",
  maxWidth: "none",
  maxHeight: "none",
  margin: 0,
  padding: 0,
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 16px 48px rgb(0 0 0 / 0.24)",
  outline: "none",
  overflow: "hidden",
  transform: "translate(-50%, -50%)",
  "&[open]": { display: "block" },
  "&::backdrop": { background: "rgb(0 0 0 / 0.5)" },
  [media.sm]: {
    width: "min(calc(100% - 32px), 1040px)",
    height: "min(620px, calc(var(--openorb-visual-viewport-height, 100dvh) - 32px))",
  },
});
const formStyle = css({
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  width: "100%",
  height: "100%",
});
const headerStyle = css({
  display: "flex",
  alignItems: "center",
  minHeight: "72px",
  padding: "16px",
});
const closeButtonStyle = css({
  color: "var(--muted-foreground)",
});
const promptAreaStyle = css({
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  padding: "12px 28px 24px",
  [media.sm]: { padding: "20px 48px 32px" },
});
const promptStyle = css({
  flex: 1,
  width: "100%",
  minHeight: 0,
  padding: 0,
  color: "var(--foreground)",
  background: "transparent",
  border: 0,
  outline: "none",
  resize: "none",
  font: "inherit",
  fontSize: "clamp(20px, 3vw, 28px)",
  lineHeight: 1.4,
  "&::placeholder": { color: "var(--muted-foreground)" },
});
const noticeStyle = css({
  margin: "12px 0 0",
  color: "var(--muted-foreground)",
  fontSize: "14px",
  "& a": { color: "var(--primary)" },
});
const errorStyle = css({
  margin: "0 0 16px",
  padding: "10px 12px",
  color: "var(--destructive)",
  background: "color-mix(in oklab, var(--destructive) 10%, transparent)",
  border: "1px solid color-mix(in oklab, var(--destructive) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  fontSize: "14px",
});
const footerStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "12px",
  minWidth: 0,
  padding: "16px",
  background: "var(--muted)",
  borderTop: "1px solid var(--border)",
});
const controlsStyle = css({
  display: "flex",
  flex: 1,
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
  overscrollBehaviorX: "contain",
  scrollSnapType: "x proximity",
  scrollbarWidth: "none",
  touchAction: "pan-x",
  WebkitOverflowScrolling: "touch",
  "&::-webkit-scrollbar": { display: "none" },
  "& > *": { scrollSnapAlign: "start" },
});
const controlBaseStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  flexShrink: 0,
  height: "40px",
  padding: "0 12px",
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  transition: "color 150ms ease, background-color 150ms ease, border-color 150ms ease",
  "@media (prefers-color-scheme: dark)": {
    background: "color-mix(in oklab, var(--input) 30%, transparent)",
    borderColor: "var(--input)",
  },
});
const selectControlStyle = [
  controlBaseStyle,
  css({
    cursor: "pointer",
    "&:hover": { color: "var(--accent-foreground)", background: "var(--accent)" },
    "&:focus-within": {
      borderColor: "var(--ring)",
      boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
    },
    "&:has(select:disabled)": { cursor: "not-allowed", opacity: 0.55 },
    "@media (prefers-color-scheme: dark)": {
      "&:hover": { background: "color-mix(in oklab, var(--input) 50%, transparent)" },
    },
  }),
];
const selectStyle = css({
  maxWidth: "210px",
  color: "inherit",
  background: "transparent",
  border: 0,
  outline: 0,
  appearance: "none",
  font: "inherit",
  fontWeight: "inherit",
  cursor: "inherit",
  textOverflow: "ellipsis",
});
const submitIdleStyle = css({
  display: "inline-flex",
  "&[hidden]": { display: "none" },
});
const submitSpinnerStyle = css({
  display: "block",
  width: "18px",
  height: "18px",
  border: "2px solid color-mix(in oklab, currentColor 35%, transparent)",
  borderTopColor: "currentColor",
  borderRadius: "999px",
  animation: "openorb-composer-submit-spin 800ms linear infinite",
  "&[hidden]": { display: "none" },
  "@keyframes openorb-composer-submit-spin": { to: { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});
const screenReaderOnlyStyle = css({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
});
