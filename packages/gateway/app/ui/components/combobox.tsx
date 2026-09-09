import { css, type Handle, type Props, type RemixNode } from "remix/ui";
import * as combobox from "remix/ui/combobox/primitives";

import { media } from "@/app/ui/responsive.ts";
import { Icon } from "@/app/ui/components/icons.tsx";

export { ComboboxChangeEvent, onComboboxChange } from "remix/ui/combobox/primitives";

export type ComboboxInputProps = Omit<
  Props<"input">,
  | "children"
  | "defaultValue"
  | "disabled"
  | "id"
  | "list"
  | "name"
  | "placeholder"
  | "role"
  | "type"
  | "value"
>;

export type ComboboxProps = Omit<Props<"div">, "children"> & {
  children?: RemixNode;
  defaultValue?: string | null;
  disabled?: boolean;
  inputId?: string;
  inputProps?: ComboboxInputProps;
  name?: string;
  placeholder?: string;
};

export type ComboboxOptionProps = Omit<Props<"div">, "children"> & {
  children?: RemixNode;
  disabled?: boolean;
  label: string;
  searchValue?: string | string[];
  value: string;
};

export function Combobox(handle: Handle<ComboboxProps>) {
  return () => {
    const {
      children,
      defaultValue,
      disabled,
      inputId,
      inputProps = {},
      mix,
      name,
      placeholder,
      ...rootProps
    } = handle.props;
    const { mix: inputMix, ...nativeInputProps } = inputProps;

    return (
      <combobox.Context
        {...defaultValue !== undefined ? { defaultValue } : {}}
        {...disabled !== undefined ? { disabled } : {}}
        {...name !== undefined ? { name } : {}}
      >
        <div {...rootProps} data-slot="combobox" mix={[rootStyle, mix]}>
          <div data-slot="combobox-input" mix={inputGroupStyle}>
            <input
              {...nativeInputProps}
              {...defaultValue !== undefined && defaultValue !== null ? { defaultValue } : {}}
              {...inputId !== undefined ? { id: inputId } : {}}
              {...placeholder !== undefined ? { placeholder } : {}}
              list={undefined}
              role="combobox"
              type="text"
              data-slot="combobox-input-control"
              mix={[inputStyle, combobox.input(), inputMix]}
            />
            <span data-slot="combobox-trigger-icon" mix={triggerIconStyle}>
              <Icon name="chevron-down" />
            </span>
          </div>
          <div
            data-slot="combobox-content"
            mix={[contentStyle, contentTransitionStyle, combobox.popover()]}
          >
            <div data-slot="combobox-list" mix={[listStyle, combobox.list()]}>
              {children}
            </div>
          </div>
          {name ? <input mix={combobox.hiddenInput()} /> : null}
        </div>
      </combobox.Context>
    );
  };
}

export function ComboboxOption(handle: Handle<ComboboxOptionProps>) {
  return () => {
    const { children, disabled, label, mix, searchValue, value, ...props } = handle.props;

    return (
      <div
        {...props}
        data-slot="combobox-item"
        mix={[
          optionStyle,
          combobox.option({
            ...disabled !== undefined ? { disabled } : {},
            label,
            ...searchValue !== undefined ? { searchValue } : {},
            value,
          }),
          mix,
        ]}
      >
        <span data-slot="combobox-item-label" mix={optionLabelStyle}>
          {children ?? label}
        </span>
        <span aria-hidden="true" data-slot="combobox-item-indicator" mix={indicatorStyle}>
          <Icon name="check" />
        </span>
      </div>
    );
  };
}

const rootStyle = css({
  position: "relative",
  width: "100%",
});

const inputGroupStyle = css({
  position: "relative",
  display: "flex",
  width: "100%",
  minWidth: 0,
  alignItems: "center",
});

const inputStyle = css({
  width: "100%",
  height: "32px",
  minWidth: 0,
  padding: "4px 34px 4px 10px",
  color: "var(--foreground)",
  background: "transparent",
  border: "1px solid var(--input)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
  outline: "none",
  font: "inherit",
  fontSize: "16px",
  transition: "color 150ms ease, box-shadow 150ms ease, border-color 150ms ease",
  "&::selection": {
    color: "var(--primary-foreground)",
    background: "var(--primary)",
  },
  "&::placeholder": { color: "var(--muted-foreground)" },
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
  "&:disabled": {
    pointerEvents: "none",
    cursor: "not-allowed",
    opacity: 0.5,
  },
  "&[aria-invalid='true']": {
    borderColor: "var(--destructive)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)",
  },
  "@media (prefers-color-scheme: dark)": {
    background: "color-mix(in oklab, var(--input) 30%, transparent)",
    "&[aria-invalid='true']": {
      boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent)",
    },
  },
  [media.md]: { fontSize: "14px" },
});

const triggerIconStyle = css({
  position: "absolute",
  insetInlineEnd: "8px",
  display: "inline-flex",
  width: "24px",
  height: "24px",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--muted-foreground)",
  pointerEvents: "none",
  "& svg": { width: "16px", height: "16px" },
  "input:disabled + &": { opacity: 0.5 },
});

const contentStyle = css({
  position: "fixed",
  inset: "auto",
  zIndex: 50,
  display: "flex",
  flexDirection: "column",
  width: "max-content",
  minWidth: "144px",
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "min(288px, 50dvh)",
  margin: 0,
  padding: 0,
  color: "var(--popover-foreground)",
  background: "var(--popover)",
  border: 0,
  borderRadius: "var(--radius-lg)",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  outline: "1px solid color-mix(in oklab, var(--foreground) 10%, transparent)",
  overflow: "hidden",
  "&::backdrop": { background: "transparent" },
});

const contentTransitionStyle = css({
  opacity: 0,
  transform: "scale(0.95)",
  transformOrigin: "top left",
  transition: "opacity 100ms ease, transform 100ms ease, overlay 100ms ease, display 100ms ease",
  transitionBehavior: "allow-discrete",
  "&:popover-open": {
    opacity: 1,
    transform: "scale(1)",
  },
  "&:not(:popover-open)": { pointerEvents: "none" },
  "&[data-show-reason='hint']:not(:popover-open)": {
    transition: "none",
    transitionBehavior: "normal",
  },
});

const listStyle = css({
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  maxHeight: "min(252px, calc(50dvh - 36px))",
  padding: "4px",
  outline: "none",
  overflowY: "auto",
  overscrollBehavior: "contain",
  scrollbarWidth: "none",
  userSelect: "none",
  "&::-webkit-scrollbar": { display: "none" },
});

const optionStyle = css({
  position: "relative",
  display: "flex",
  width: "100%",
  minWidth: 0,
  minHeight: "28px",
  alignItems: "center",
  gap: "8px",
  padding: "4px 32px 4px 6px",
  color: "var(--popover-foreground)",
  borderRadius: "var(--radius-md)",
  outline: "none",
  fontSize: "14px",
  lineHeight: "20px",
  cursor: "default",
  userSelect: "none",
  "--combobox-indicator-opacity": 0,
  "&[data-highlighted='true']": {
    color: "var(--accent-foreground)",
    background: "var(--accent)",
  },
  "&[aria-disabled='true']": {
    pointerEvents: "none",
    opacity: 0.5,
  },
  "&[hidden]": { display: "none" },
  "&[aria-selected='true']": { "--combobox-indicator-opacity": 1 },
});

const optionLabelStyle = css({
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const indicatorStyle = css({
  position: "absolute",
  insetInlineEnd: "8px",
  display: "flex",
  width: "16px",
  height: "16px",
  alignItems: "center",
  justifyContent: "center",
  opacity: "var(--combobox-indicator-opacity)",
  pointerEvents: "none",
  "& svg": { width: "16px", height: "16px" },
});
