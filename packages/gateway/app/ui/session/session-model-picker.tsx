import { css, type Handle, on } from "remix/ui";
import * as combobox from "remix/ui/combobox/primitives";
import * as popover from "remix/ui/popover";

import type { SessionComposerData } from "@/app/session-composer-data.ts";
import { Icon } from "@/app/ui/components/icons.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  sessionSelectControlStyle,
  sessionSelectorListStyle,
  sessionSelectorOptionIndicatorStyle,
  sessionSelectorOptionStyle,
  sessionSelectorPopoverBackIconStyle,
  sessionSelectorPopoverBackStyle,
  sessionSelectorPopoverHeaderStyle,
  sessionSelectorPopoverStyle,
  sessionSelectorPopoverTitleStyle,
} from "@/app/ui/session/session-selector-styles.ts";

export type SessionModelPickerProps = {
  defaultValue: string;
  disabled: boolean;
  models: SessionComposerData["models"];
};

export function SessionModelPicker(handle: Handle<SessionModelPickerProps>) {
  let open = false;
  let selectedModelId = handle.props.defaultValue;

  const setOpen = async (nextOpen: boolean) => {
    if (open === nextOpen) return;
    open = nextOpen;
    await handle.update();
  };

  const selectModel = async (modelId: string, root: HTMLElement) => {
    const model = handle.props.models.find((candidate) => candidate.id === modelId);
    if (!model) return;

    selectedModelId = model.id;
    open = false;
    await handle.update();

    root.closest("dialog")
      ?.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
      ?.dispatchEvent(
        new CustomEvent("openorb:update-thinking-levels", { detail: model.thinkingLevels }),
      );
  };

  return () => {
    const selectedModel = handle.props.models.find((model) => model.id === selectedModelId);

    return (
      <popover.Context>
        <combobox.Context disabled={handle.props.disabled}>
          <ModelPickerControl
            disabled={handle.props.disabled}
            models={handle.props.models}
            onOpenChange={setOpen}
            onSelect={selectModel}
            open={open}
            selectedLabel={selectedModel?.name ?? "No model"}
          />
          <input type="hidden" name="model" value={selectedModelId} />
        </combobox.Context>
      </popover.Context>
    );
  };
}

function ModelPickerControl(
  handle: Handle<{
    disabled: boolean;
    models: SessionComposerData["models"];
    onOpenChange: (open: boolean) => Promise<void>;
    onSelect: (modelId: string, root: HTMLElement) => Promise<void>;
    open: boolean;
    selectedLabel: string;
  }>,
) {
  const context = handle.context.get(combobox.Context);
  const searchInputId = `${handle.id}-search`;
  const close = () => {
    context.close();
    return handle.props.onOpenChange(false);
  };

  return () => {
    const noMatches = context.inputText !== "" && !context.isOpen;

    return (
      <div
        data-slot="session-model-picker"
        mix={combobox.onComboboxChange<HTMLDivElement>(async (event) => {
          if (event.value === null) return;
          await handle.props.onSelect(event.value, event.currentTarget);
        })}
      >
        <button
          id={`${handle.id}-trigger`}
          type="button"
          aria-label="Model"
          aria-controls={context.listId}
          aria-expanded={handle.props.open ? "true" : "false"}
          disabled={handle.props.disabled}
          mix={[
            sessionSelectControlStyle,
            modelTriggerStyle,
            popover.anchor({ placement: "top-start" }),
            popover.focusOnHide(),
            on("click", async () => {
              await handle.props.onOpenChange(true);
              await context.open("selected");
            }),
          ]}
        >
          <Icon name="sparkles" />
          <span>{handle.props.selectedLabel}</span>
          <Icon name="chevron-down" />
        </button>
        <div
          mix={[
            sessionSelectorPopoverStyle,
            modelPopoverPositionStyle,
            popover.surface({
              open: handle.props.open,
              onHide() {
                void close();
              },
            }),
          ]}
        >
          <header mix={sessionSelectorPopoverHeaderStyle}>
            <button
              type="button"
              aria-label="Back to session"
              mix={[
                sessionSelectorPopoverBackStyle,
                on("click", close),
              ]}
            >
              <span aria-hidden="true" mix={sessionSelectorPopoverBackIconStyle}>←</span>
              Back
            </button>
            <h3 mix={sessionSelectorPopoverTitleStyle}>Choose a model</h3>
          </header>
          <div mix={modelSearchContainerStyle}>
            <input
              id={searchInputId}
              aria-label="Search models"
              placeholder="Search models…"
              mix={[
                modelSearchInputStyle,
                combobox.input(),
                popover.focusOnShow(),
                on<HTMLInputElement, "keydown">("keydown", (event) => {
                  if (event.key === "Enter" && !context.isOpen) event.preventDefault();
                }),
              ]}
            />
          </div>
          <p hidden={!noMatches} mix={modelEmptyStyle}>No models found.</p>
          <div hidden={noMatches} mix={[combobox.list(), sessionSelectorListStyle]}>
            {handle.props.models.map((model) => (
              <div
                key={model.id}
                mix={[
                  combobox.option({
                    label: model.name,
                    searchValue: modelSearchValues(model),
                    value: model.id,
                  }),
                  sessionSelectorOptionStyle,
                ]}
              >
                <span>{model.providerName} · {model.name}</span>
                <span
                  aria-hidden="true"
                  data-slot="selector-option-indicator"
                  mix={sessionSelectorOptionIndicatorStyle}
                >
                  <Icon name="check" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };
}

function modelSearchValues(model: SessionComposerData["models"][number]): string[] {
  const nameSuffixes = model.name.split(/\s+/).map((_, index, words) =>
    words.slice(index).join(" ")
  );
  return [
    ...nameSuffixes,
    model.providerName,
    `${model.providerName} · ${model.name}`,
    model.id,
  ];
}

const modelTriggerStyle = css({
  anchorName: "--openorb-model-trigger",
  maxWidth: "260px",
  outline: 0,
  "& > span": {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const modelPopoverPositionStyle = css({
  inset: "12px !important",
  [media.sm]: {
    inset:
      "auto auto calc(anchor(--openorb-model-trigger top) + 4px) anchor(--openorb-model-trigger left) !important",
  },
});

const modelSearchContainerStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  margin: "16px 16px 4px",
  padding: "0 12px",
  color: "var(--muted-foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  "&:focus-within": {
    color: "var(--foreground)",
    borderColor: "color-mix(in oklab, var(--border) 60%, var(--foreground))",
  },
  [media.sm]: { margin: "8px 8px 4px" },
});

const modelEmptyStyle = css({
  margin: 0,
  padding: "24px",
  color: "var(--muted-foreground)",
  textAlign: "center",
  fontSize: "14px",
  "&[hidden]": { display: "none" },
});

const modelSearchInputStyle = css({
  width: "100%",
  minWidth: 0,
  height: "40px",
  padding: 0,
  color: "var(--foreground)",
  background: "transparent",
  border: 0,
  outline: 0,
  font: "inherit",
  fontSize: "16px",
  "&::placeholder": { color: "var(--muted-foreground)" },
  [media.sm]: { fontSize: "14px" },
});
