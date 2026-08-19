import { css, type Handle, type Props } from "remix/ui";

export type AlertVariant = "default" | "destructive";
export type AlertProps = Props<"div"> & { variant?: AlertVariant };

export function Alert(handle: Handle<AlertProps>) {
  return () => {
    const { mix, role = "alert", variant = "default", ...props } = handle.props;
    return (
      <div
        {...props}
        role={role}
        data-slot="alert"
        data-variant={variant}
        mix={[alertBaseStyle, alertVariantStyles[variant], mix]}
      />
    );
  };
}

export function AlertTitle(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="alert-title" mix={[alertTitleStyle, mix]} />;
  };
}

export function AlertDescription(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="alert-description" mix={[alertDescriptionStyle, mix]} />;
  };
}

const alertBaseStyle = css({
  position: "relative",
  width: "100%",
  display: "grid",
  gridTemplateColumns: "0 1fr",
  alignItems: "start",
  gap: "2px 0",
  padding: "12px 16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  fontSize: "14px",
  "&:has(> svg)": {
    gridTemplateColumns: "16px 1fr",
    columnGap: "12px",
  },
  "& > svg": {
    width: "16px",
    height: "16px",
    transform: "translateY(2px)",
  },
});

const alertVariantStyles = {
  default: css({
    color: "var(--card-foreground)",
    background: "var(--card)",
  }),
  destructive: css({
    color: "var(--destructive)",
    background: "var(--card)",
    "& [data-slot='alert-description']": {
      color: "color-mix(in oklab, var(--destructive) 90%, transparent)",
    },
  }),
} as const;

const alertTitleStyle = css({
  gridColumnStart: 2,
  minHeight: "16px",
  overflow: "hidden",
  fontWeight: 500,
  letterSpacing: "-0.025em",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const alertDescriptionStyle = css({
  gridColumnStart: 2,
  display: "grid",
  justifyItems: "start",
  gap: "4px",
  color: "var(--muted-foreground)",
  fontSize: "14px",
  "& p": { lineHeight: 1.625 },
});
