import { clientEntry, css, type Handle, type Props } from "remix/ui";

export type ButtonVariant =
  | "default"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "link";
export type ButtonSize =
  | "default"
  | "xs"
  | "sm"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg";

export type ButtonProps = Omit<Props<"button">, "size"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button(handle: Handle<ButtonProps>) {
  return () => {
    const {
      children,
      mix,
      size = "default",
      type = "button",
      variant = "default",
      ...props
    } = handle.props;

    return (
      <button
        {...props}
        type={type}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        mix={[buttonBaseStyle, buttonVariantStyles[variant], buttonSizeStyles[size], mix]}
      >
        {children}
      </button>
    );
  };
}

export const SubmitProgressBehavior = clientEntry<{
  formId: string;
  idleLabel: string;
  pendingLabel: string;
}>(
  import.meta.url,
  function SubmitProgressBehavior(
    handle: Handle<{ formId: string; idleLabel: string; pendingLabel: string }>,
  ) {
    let submittedButton: HTMLButtonElement | undefined;

    const settleSubmission = () => {
      if (!submittedButton) return;
      submittedButton.disabled = false;
      submittedButton.removeAttribute("aria-busy");
      submittedButton.setAttribute("aria-label", handle.props.idleLabel);
      submittedButton.querySelector("[data-slot='submit-idle']")?.removeAttribute("hidden");
      submittedButton.querySelector("[data-slot='submit-progress']")?.setAttribute("hidden", "");
      submittedButton = undefined;
    };

    handle.queueTask(() => {
      const form = document.getElementById(handle.props.formId);
      if (!(form instanceof HTMLFormElement)) return;
      const signal = handle.signal;

      form.addEventListener("submit", (event) => {
        if (submittedButton) {
          event.preventDefault();
          return;
        }
        const submitter = event instanceof SubmitEvent &&
            event.submitter instanceof HTMLButtonElement
          ? event.submitter
          : form.querySelector<HTMLButtonElement>("button[type='submit']");
        if (!submitter) return;

        submittedButton = submitter;
        submitter.disabled = true;
        submitter.setAttribute("aria-busy", "true");
        submitter.setAttribute("aria-label", handle.props.pendingLabel);
        submitter.querySelector("[data-slot='submit-idle']")?.setAttribute("hidden", "");
        submitter.querySelector("[data-slot='submit-progress']")?.removeAttribute("hidden");

        setTimeout(() => {
          if (!signal.aborted && event.defaultPrevented) settleSubmission();
        }, 0);
      }, { signal });

      globalThis.navigation.addEventListener("navigatesuccess", settleSubmission, { signal });
      globalThis.navigation.addEventListener("navigateerror", settleSubmission, { signal });
    });

    return () => null;
  },
);

const buttonBaseStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  flexShrink: 0,
  appearance: "none",
  color: "inherit",
  background: "transparent",
  border: "0 solid transparent",
  borderRadius: "var(--radius-md)",
  outline: "none",
  font: "inherit",
  fontSize: "14px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  transition: "all 150ms ease",
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
  "&:disabled, &[aria-disabled='true']": {
    pointerEvents: "none",
    opacity: 0.5,
  },
  "&[aria-invalid='true']": {
    borderColor: "var(--destructive)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)",
  },
  "@media (prefers-color-scheme: dark)": {
    "&[aria-invalid='true']": {
      boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent)",
    },
  },
  "& svg": {
    flexShrink: 0,
    pointerEvents: "none",
  },
  "& svg:not([class*='size-'])": {
    width: "16px",
    height: "16px",
  },
});

const buttonVariantStyles = {
  default: css({
    color: "var(--primary-foreground)",
    background: "var(--primary)",
    "&:hover": { background: "color-mix(in oklab, var(--primary) 90%, transparent)" },
  }),
  destructive: css({
    color: "#ffffff",
    background: "var(--destructive)",
    "&:hover": { background: "color-mix(in oklab, var(--destructive) 90%, transparent)" },
    "&:focus-visible": {
      boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)",
    },
    "@media (prefers-color-scheme: dark)": {
      background: "color-mix(in oklab, var(--destructive) 60%, transparent)",
      "&:focus-visible": {
        boxShadow: "0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent)",
      },
    },
  }),
  outline: css({
    color: "var(--foreground)",
    background: "var(--background)",
    borderWidth: "1px",
    borderColor: "var(--border)",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
    "&:hover": { background: "var(--accent)", color: "var(--accent-foreground)" },
    "@media (prefers-color-scheme: dark)": {
      background: "color-mix(in oklab, var(--input) 30%, transparent)",
      borderColor: "var(--input)",
      "&:hover": { background: "color-mix(in oklab, var(--input) 50%, transparent)" },
    },
  }),
  secondary: css({
    color: "var(--secondary-foreground)",
    background: "var(--secondary)",
    "&:hover": {
      background: "color-mix(in oklab, var(--secondary) 80%, transparent)",
    },
  }),
  ghost: css({
    color: "var(--foreground)",
    background: "transparent",
    "&:hover": { background: "var(--accent)", color: "var(--accent-foreground)" },
    "@media (prefers-color-scheme: dark)": {
      "&:hover": { background: "color-mix(in oklab, var(--accent) 50%, transparent)" },
    },
  }),
  link: css({
    color: "var(--primary)",
    textUnderlineOffset: "4px",
    "&:hover": { textDecoration: "underline" },
  }),
} as const;

const buttonSizeStyles = {
  default: css({
    height: "36px",
    padding: "8px 16px",
    "&:has(> svg)": { paddingInline: "12px" },
  }),
  xs: css({
    height: "24px",
    gap: "4px",
    paddingInline: "8px",
    fontSize: "12px",
    "&:has(> svg)": { paddingInline: "6px" },
    "& svg:not([class*='size-'])": { width: "12px", height: "12px" },
  }),
  sm: css({
    height: "32px",
    gap: "6px",
    paddingInline: "12px",
    "&:has(> svg)": { paddingInline: "10px" },
  }),
  lg: css({
    height: "40px",
    paddingInline: "24px",
    "&:has(> svg)": { paddingInline: "16px" },
  }),
  icon: css({ width: "36px", height: "36px", padding: 0 }),
  "icon-xs": css({
    width: "24px",
    height: "24px",
    padding: 0,
    "& svg:not([class*='size-'])": { width: "12px", height: "12px" },
  }),
  "icon-sm": css({ width: "32px", height: "32px", padding: 0 }),
  "icon-lg": css({ width: "40px", height: "40px", padding: 0 }),
} as const;
