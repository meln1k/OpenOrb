import {
  DEFAULT_SESSION_MODEL,
  DEFAULT_SESSION_THINKING_LEVEL,
} from "../../../protocol/src/model-provider.ts";
import {
  DEFAULT_ORB_SIZE,
  ORB_SIZE_RESOURCES,
  ORB_SIZES,
  type OrbSize,
} from "../../../protocol/src/orb-size.ts";
import {
  SESSION_THINKING_LEVELS,
  type SessionThinkingLevel,
} from "../../../protocol/src/thinking-level.ts";
import { clientEntry, css, type Handle, on } from "remix/ui";
import * as popover from "remix/ui/popover";
import * as selectControl from "remix/ui/select/primitives";

import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { routes } from "@/app/routes.ts";
import { DialogBehavior } from "@/app/ui/components/alert-dialog.tsx";
import { Button } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  clampThinkingLevel,
  formatThinkingLevel,
  nextThinkingLevel,
} from "@/app/ui/session-thinking-level.ts";
import { SessionComposerBehavior } from "@/app/ui/session/session-composer-behavior.tsx";

declare global {
  interface HTMLElementEventMap {
    "openorb:cycle-thinking-level": Event;
    "openorb:update-thinking-levels": CustomEvent<readonly string[]>;
  }
}

export type SessionComposerValues = {
  projectId: string;
  model: string;
  ref: string;
  orbSize: string;
  thinkingLevel: string;
  branchName: string;
  initialPrompt: string;
};

export type SessionComposerProps = SessionComposerData & {
  autoOpen?: boolean;
  csrfToken: string;
  dialogId: string;
  error?: string;
  values?: SessionComposerValues;
};

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
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedModel = values?.model ??
    models.find((model) => model.id === DEFAULT_SESSION_MODEL)?.id ??
    models[0]?.id ??
    "";
  const selectedOrbSize = values?.orbSize || DEFAULT_ORB_SIZE;
  const selectedModelOption = models.find((model) => model.id === selectedModel);
  const supportedThinkingLevels = selectedModelOption?.thinkingLevels ?? SESSION_THINKING_LEVELS;
  const selectedThinkingLevel = clampThinkingLevel(
    values?.thinkingLevel || DEFAULT_SESSION_THINKING_LEVEL,
    supportedThinkingLevels,
  );
  const ref = values?.ref ?? firstProject?.defaultRef ?? "main";
  const branchName = values?.branchName ?? ref;
  const canSubmit = projects.length > 0 && models.length > 0 && hasConnectedRunner;

  return () => (
    <dialog
      id={dialogId}
      role="dialog"
      aria-labelledby={titleId}
      aria-keyshortcuts="Shift+Tab"
      open={autoOpen || undefined}
      data-slot="session-composer"
      data-thinking-level={selectedThinkingLevel}
      mix={dialogStyle}
    >
      <form
        method="post"
        action={routes.app.sessions.create.href()}
        data-rmx-document
        mix={formStyle}
      >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="runnerId" value="" />
        <input type="hidden" name="ref" value={ref} />
        <input type="hidden" name="branchName" value={branchName} />
        <header mix={headerStyle}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            commandFor={dialogId}
            command="close"
            aria-label="Close new session"
            mix={closeButtonStyle}
          >
            <Icon name="x" size={20} />
          </Button>
          <h2 id={titleId} mix={screenReaderOnlyStyle}>New session</h2>
        </header>
        <div mix={promptAreaStyle}>
          {error ? <p role="alert" mix={errorStyle}>{error}</p> : null}
          <textarea
            name="initialPrompt"
            aria-label="Initial prompt"
            placeholder="Write prompt…"
            defaultValue={values?.initialPrompt ?? ""}
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
            <selectControl.Context
              defaultLabel={selectedProject?.name ?? "No projects"}
              defaultValue={selectedProjectId}
              disabled={projects.length === 0}
              name="projectId"
            >
              <button
                type="button"
                aria-label="Project"
                mix={[selectControlStyle, projectTriggerStyle, selectControl.trigger()]}
              >
                <Icon name="folder" />
                <SelectLabel />
                <Icon name="chevron-down" />
              </button>
              <popover.Context>
                <div
                  mix={[
                    selectControl.popover(),
                    selectorPopoverStyle,
                    projectPopoverPositionStyle,
                  ]}
                >
                  <SelectorPopoverHeader title="Choose a project" />
                  <div mix={[selectControl.list(), selectorListStyle]}>
                    {projects.map((project) => (
                      <div
                        key={project.id}
                        mix={[
                          selectControl.option({ label: project.name, value: project.id }),
                          selectorOptionStyle,
                        ]}
                      >
                        <span>{project.name}</span>
                        <span
                          aria-hidden="true"
                          data-slot="selector-option-indicator"
                          mix={selectorOptionIndicatorStyle}
                        >
                          <Icon name="check" />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </popover.Context>
              <input
                name="projectId"
                required
                mix={selectControl.hiddenInput()}
              />
            </selectControl.Context>
            <selectControl.Context
              defaultLabel={selectedOrbSize}
              defaultValue={selectedOrbSize}
              name="orbSize"
            >
              <button
                type="button"
                aria-label="Orb size"
                mix={[selectControlStyle, orbSizeTriggerStyle, selectControl.trigger()]}
              >
                <Icon name="server" />
                <SelectLabel />
                <Icon name="chevron-down" />
              </button>
              <popover.Context>
                <div
                  mix={[selectControl.popover(), selectorPopoverStyle, orbSizePopoverPositionStyle]}
                >
                  <SelectorPopoverHeader title="Choose a VM size" />
                  <div mix={[selectControl.list(), selectorListStyle]}>
                    {ORB_SIZES.map((orbSize) => (
                      <div
                        key={orbSize}
                        mix={[
                          selectControl.option({ label: orbSize, value: orbSize }),
                          selectorOptionStyle,
                        ]}
                      >
                        <span>{formatOrbSize(orbSize)}</span>
                        <span
                          aria-hidden="true"
                          data-slot="selector-option-indicator"
                          mix={selectorOptionIndicatorStyle}
                        >
                          <Icon name="check" />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </popover.Context>
              <input mix={selectControl.hiddenInput()} />
            </selectControl.Context>
            <selectControl.Context
              defaultLabel={selectedModelOption?.name ?? "No model"}
              defaultValue={selectedModel}
              disabled={models.length === 0}
              name="model"
            >
              <button
                type="button"
                aria-label="Model"
                mix={[selectControlStyle, modelTriggerStyle, selectControl.trigger()]}
              >
                <Icon name="sparkles" />
                <SelectLabel />
                <Icon name="chevron-down" />
              </button>
              <popover.Context>
                <div
                  mix={[selectControl.popover(), selectorPopoverStyle, modelPopoverPositionStyle]}
                >
                  <SelectorPopoverHeader title="Choose a model" />
                  <div mix={[selectControl.list(), selectorListStyle]}>
                    {models.map((model) => (
                      <div
                        key={model.id}
                        data-model-value={model.id}
                        data-supported-thinking-levels={model.thinkingLevels.join(" ")}
                        mix={[
                          selectControl.option({ label: model.name, value: model.id }),
                          selectorOptionStyle,
                        ]}
                      >
                        <span>{model.providerName} · {model.name}</span>
                        <span
                          aria-hidden="true"
                          data-slot="selector-option-indicator"
                          mix={selectorOptionIndicatorStyle}
                        >
                          <Icon name="check" />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </popover.Context>
              <input
                name="model"
                required
                mix={selectControl.hiddenInput()}
              />
            </selectControl.Context>
            <selectControl.Context
              defaultLabel={capitalize(formatThinkingLevel(selectedThinkingLevel))}
              defaultValue={selectedThinkingLevel}
              name="thinkingLevel"
            >
              <ThinkingLevelControl supportedThinkingLevels={supportedThinkingLevels} />
            </selectControl.Context>
          </div>
          <Button
            type="submit"
            size="icon-lg"
            aria-label="Start session"
            aria-keyshortcuts="Enter"
            title={canSubmit ? "Start session" : "Project, model, and runner required"}
            data-submit-enabled={canSubmit ? "true" : "false"}
            data-submit-label="Start session"
            data-submit-pending-label="Starting session"
            disabled={!canSubmit}
            mix={roundButtonStyle}
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
      <SessionComposerBehavior dialogId={dialogId} />
    </dialog>
  );
}

export const SessionComposerClient = clientEntry<SessionComposerProps>(
  import.meta.url,
  function SessionComposerClient(handle) {
    return () => <SessionComposer {...handle.props} />;
  },
);

function formatOrbSize(orbSize: OrbSize): string {
  const resources = ORB_SIZE_RESOURCES[orbSize];
  return `${orbSize} · ${resources.cpuCount} CPU${resources.cpuCount === 1 ? "" : "s"} · ${
    resources.memoryMiB / 1024
  } GB memory`;
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function SelectLabel(handle: Handle) {
  const context = handle.context.get(selectControl.Context);
  return () => <span>{context.displayedLabel}</span>;
}

function SelectorPopoverHeader(handle: Handle<{ title: string }>) {
  const context = handle.context.get(selectControl.Context);
  return () => (
    <header mix={selectorPopoverHeaderStyle}>
      <button
        type="button"
        aria-label="Back to session"
        mix={[
          selectorPopoverBackStyle,
          on("click", () => context.close()),
        ]}
      >
        <span aria-hidden="true" mix={selectorPopoverBackIconStyle}>←</span>
        Back
      </button>
      <h3 mix={selectorPopoverTitleStyle}>{handle.props.title}</h3>
    </header>
  );
}

function ThinkingLevelControl(
  handle: Handle<{ supportedThinkingLevels: readonly SessionThinkingLevel[] }>,
) {
  const context = handle.context.get(selectControl.Context);
  let supportedThinkingLevels = [...handle.props.supportedThinkingLevels];
  const selectLevel = (level: SessionThinkingLevel) => {
    context.close();
    context.selectTypeaheadMatch(`thinking:${level}`);
  };

  return () => (
    <>
      <button
        type="button"
        aria-label="Thinking level"
        title="Thinking level · Shift+Tab to change"
        mix={[
          selectControlStyle,
          thinkingLevelTriggerStyle,
          selectControl.trigger(),
          on<HTMLButtonElement, "openorb:update-thinking-levels">(
            "openorb:update-thinking-levels",
            async (event) => {
              supportedThinkingLevels = SESSION_THINKING_LEVELS.filter((level) =>
                event.detail.includes(level)
              );
              await handle.update();
              if (
                isThinkingLevel(context.value) &&
                supportedThinkingLevels.includes(context.value)
              ) return;
              selectLevel(clampThinkingLevel(context.value ?? "", supportedThinkingLevels));
            },
          ),
          on<HTMLButtonElement, "openorb:cycle-thinking-level">(
            "openorb:cycle-thinking-level",
            () => {
              selectLevel(
                nextThinkingLevel(
                  clampThinkingLevel(context.value ?? "", supportedThinkingLevels),
                  supportedThinkingLevels,
                ),
              );
            },
          ),
        ]}
      >
        <Icon name="brain" />
        <SelectLabel />
        <Icon name="chevron-down" />
      </button>
      <popover.Context>
        <div
          mix={[
            selectControl.popover(),
            selectorPopoverStyle,
            thinkingLevelPopoverPositionStyle,
          ]}
        >
          <SelectorPopoverHeader title="Choose a thinking level" />
          <div mix={[selectControl.list(), selectorListStyle]}>
            {SESSION_THINKING_LEVELS.map((level) => (
              <div
                key={level}
                data-thinking-level-option={level}
                hidden={!supportedThinkingLevels.includes(level) || undefined}
                mix={[
                  selectControl.option({
                    label: capitalize(formatThinkingLevel(level)),
                    textValue: `thinking:${level}`,
                    value: level,
                  }),
                  selectorOptionStyle,
                ]}
              >
                <span>{capitalize(formatThinkingLevel(level))}</span>
                <span
                  aria-hidden="true"
                  data-slot="selector-option-indicator"
                  mix={selectorOptionIndicatorStyle}
                >
                  <Icon name="check" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </popover.Context>
      <input
        name="thinkingLevel"
        required
        mix={selectControl.hiddenInput()}
      />
    </>
  );
}

function isThinkingLevel(value: string | null | undefined): value is SessionThinkingLevel {
  return SESSION_THINKING_LEVELS.some((level) => level === value);
}

const dialogStyle = css({
  anchorName: "--openorb-session-composer",
  position: "fixed",
  inset: "var(--openorb-visual-viewport-center, 50%) auto auto 50%",
  zIndex: 60,
  display: "none",
  width: "min(calc(100% - 24px), 880px)",
  height: "min(320px, calc(var(--openorb-visual-viewport-height, 100dvh) - 24px))",
  maxWidth: "none",
  maxHeight: "none",
  margin: 0,
  padding: 0,
  color: "var(--foreground)",
  background: "var(--background)",
  border: "2px solid var(--border)",
  borderRadius: "32px",
  boxShadow: "0 16px 48px rgb(0 0 0 / 0.24)",
  outline: "none",
  overflow: "hidden",
  transform: "translate(-50%, -50%)",
  "&[open]": { display: "block" },
  "&[data-thinking-level='off']": { borderColor: "#9d9d9d" },
  "&[data-thinking-level='minimal']": { borderColor: "#ffffff" },
  "&[data-thinking-level='low']": { borderColor: "#1eff00" },
  "&[data-thinking-level='medium']": { borderColor: "#0070dd" },
  "&[data-thinking-level='high']": { borderColor: "#a335ee" },
  "&[data-thinking-level='xhigh']": { borderColor: "#ff8000" },
  "&[data-thinking-level='max']": { borderColor: "#e6cc80" },
  "&::backdrop": { background: "rgb(0 0 0 / 0.5)" },
  [media.sm]: {
    width: "min(calc(100% - 32px), 880px)",
    height: "min(320px, calc(var(--openorb-visual-viewport-height, 100dvh) - 32px))",
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
  borderRadius: "999px",
  boxShadow: "none",
  "&[data-slot='button']:focus-visible": {
    borderColor: "color-mix(in oklab, var(--border) 60%, var(--foreground))",
    boxShadow: "none",
  },
});
const promptAreaStyle = css({
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  padding: "8px 24px 20px",
  [media.sm]: { padding: "12px 32px 24px" },
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
  fontSize: "16px",
  lineHeight: 1.5,
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
  gap: "8px",
  minWidth: 0,
  padding: "12px",
  background: "var(--background)",
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
  borderRadius: "999px",
  boxShadow: "none",
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
      borderColor: "color-mix(in oklab, var(--border) 60%, var(--foreground))",
      boxShadow: "none",
    },
    "&:has(select:disabled), &:disabled": { cursor: "not-allowed", opacity: 0.55 },
    "@media (prefers-color-scheme: dark)": {
      "&:hover": { background: "color-mix(in oklab, var(--input) 50%, transparent)" },
    },
  }),
];
const projectTriggerStyle = css({
  anchorName: "--openorb-project-trigger",
  maxWidth: "220px",
  outline: 0,
  "& > span": {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
const orbSizeTriggerStyle = css({
  anchorName: "--openorb-orb-size-trigger",
  outline: 0,
});
const modelTriggerStyle = css({
  anchorName: "--openorb-model-trigger",
  maxWidth: "260px",
  outline: 0,
  "& > span": {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
const thinkingLevelTriggerStyle = css({
  anchorName: "--openorb-thinking-level-trigger",
  outline: 0,
});
const selectorPopoverStyle = css({
  position: "fixed",
  zIndex: 70,
  display: "none",
  flexDirection: "column",
  width: "auto",
  height: "auto",
  minWidth: 0,
  maxWidth: "none !important",
  maxHeight: "none !important",
  margin: 0,
  padding: 0,
  color: "var(--popover-foreground)",
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "32px",
  boxShadow: "0 10px 28px rgb(0 0 0 / 0.18)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
  "&:popover-open": { display: "flex" },
  "&::backdrop": { background: "var(--background)" },
  [media.sm]: {
    width: "auto",
    height: "auto",
    minWidth: "260px",
    maxWidth: "calc(100vw - 32px) !important",
    maxHeight: "min(320px, calc(100dvh - 32px)) !important",
    borderRadius: "20px",
    "&::backdrop": { background: "transparent" },
  },
});
const orbSizePopoverPositionStyle = css({
  inset: "12px !important",
  [media.sm]: {
    inset:
      "calc(anchor(--openorb-orb-size-trigger bottom) + 4px) auto auto anchor(--openorb-orb-size-trigger left) !important",
  },
});
const projectPopoverPositionStyle = css({
  inset: "12px !important",
  [media.sm]: {
    inset:
      "auto auto calc(anchor(--openorb-project-trigger top) + 4px) anchor(--openorb-project-trigger left) !important",
  },
});
const modelPopoverPositionStyle = css({
  inset: "12px !important",
  [media.sm]: {
    inset:
      "auto auto calc(anchor(--openorb-model-trigger top) + 4px) anchor(--openorb-model-trigger left) !important",
  },
});
const thinkingLevelPopoverPositionStyle = css({
  inset: "12px !important",
  [media.sm]: {
    inset:
      "auto auto calc(anchor(--openorb-thinking-level-trigger top) + 4px) anchor(--openorb-thinking-level-trigger left) !important",
  },
});
const selectorPopoverHeaderStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "28px",
  padding: "24px 24px 28px",
  borderBottom: "1px solid var(--border)",
  [media.sm]: { display: "none" },
});
const selectorPopoverBackStyle = css({
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  gap: "10px",
  padding: 0,
  color: "var(--muted-foreground)",
  background: "transparent",
  border: 0,
  outline: 0,
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
});
const selectorPopoverBackIconStyle = css({
  fontSize: "28px",
  fontWeight: 300,
  lineHeight: 0.75,
});
const selectorPopoverTitleStyle = css({
  margin: 0,
  color: "var(--foreground)",
  fontSize: "24px",
  fontWeight: 500,
  lineHeight: 1.2,
});
const selectorListStyle = css({
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  padding: "12px",
  outline: 0,
  overflow: "auto",
  overscrollBehavior: "contain",
  userSelect: "none",
  [media.sm]: { flex: "0 1 auto", padding: "4px" },
});
const selectorOptionStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minHeight: "60px",
  padding: "12px 16px",
  color: "var(--popover-foreground)",
  background: "transparent",
  borderRadius: "16px",
  outline: 0,
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
  "&[hidden]": { display: "none" },
  "&[data-highlighted='true']": {
    color: "var(--accent-foreground)",
    background: "var(--accent)",
  },
  "&[aria-disabled='true']": { pointerEvents: "none", opacity: 0.5 },
  "&[aria-selected='false'] [data-slot='selector-option-indicator']": {
    visibility: "hidden",
  },
  [media.sm]: {
    minHeight: "32px",
    padding: "6px 8px",
    borderRadius: "var(--radius-sm)",
    fontSize: "14px",
  },
});
const selectorOptionIndicatorStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "16px",
  height: "16px",
  flexShrink: 0,
  marginLeft: "auto",
});
const roundButtonStyle = css({
  borderWidth: "1px",
  borderColor: "transparent",
  borderRadius: "999px",
  "&[data-slot='button']:focus-visible": {
    borderColor: "color-mix(in oklab, var(--primary) 60%, var(--foreground))",
    boxShadow: "none",
  },
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
